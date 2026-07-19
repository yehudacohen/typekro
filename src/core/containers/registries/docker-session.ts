import { Buffer } from 'node:buffer';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { ContainerBuildError } from '../errors.js';
import { execDocker } from '../exec.js';
import type {
  OciRegistryCredentialProvider,
  OciRegistryTlsConfig,
  RegistrySession,
} from './types.js';

export interface DockerRegistrySessionOptions {
  readonly registryHost: string;
  readonly credentialProvider?: OciRegistryCredentialProvider;
  readonly dockerConfigPath?: string;
  readonly tls?: OciRegistryTlsConfig;
  readonly timeout: number;
  readonly signal?: AbortSignal;
}

function defaultDockerConfigPath(): string {
  const configuredDirectory = process.env.DOCKER_CONFIG;
  return configuredDirectory
    ? join(configuredDirectory, 'config.json')
    : join(homedir(), '.docker', 'config.json');
}

async function copyDockerConfiguration(source: string, target: string): Promise<void> {
  try {
    await copyFile(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
    await writeFile(target, '{}\n', { encoding: 'utf8', mode: 0o600 });
  }
  await chmod(target, 0o600);

  // config.json can select a named context. Docker resolves that context through
  // sibling contexts/meta and contexts/tls state, so copying only config.json
  // makes otherwise valid configurations (including OrbStack) unusable.
  try {
    await cp(join(dirname(source), 'contexts'), join(dirname(target), 'contexts'), {
      recursive: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // DOCKER_CONFIG also controls per-user CLI plugin discovery. Keep Buildx
  // available without copying unrelated plugins or sharing mutable state.
  const sourceBuildx = join(dirname(source), 'cli-plugins', 'docker-buildx');
  const targetBuildx = join(dirname(target), 'cli-plugins', 'docker-buildx');
  try {
    await mkdir(dirname(targetBuildx), { recursive: true });
    await cp(sourceBuildx, targetBuildx);
    if (!(await lstat(targetBuildx)).isSymbolicLink()) await chmod(targetBuildx, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function writeDockerCredential(
  configPath: string,
  registryHost: string,
  credential: { username: string; password: string }
): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Docker config.json must contain an object.');
  }
  const config = parsed as Record<string, unknown>;
  const currentAuths =
    config.auths && typeof config.auths === 'object' && !Array.isArray(config.auths)
      ? (config.auths as Record<string, unknown>)
      : {};
  const currentHelpers =
    config.credHelpers &&
    typeof config.credHelpers === 'object' &&
    !Array.isArray(config.credHelpers)
      ? (config.credHelpers as Record<string, unknown>)
      : {};
  const { [registryHost]: _targetHelper, ...otherHelpers } = currentHelpers;
  const {
    credsStore: _globalCredentialStore,
    credHelpers: _credHelpers,
    ...sessionConfig
  } = config;
  const auth = Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString(
    'base64'
  );
  await writeFile(
    configPath,
    `${JSON.stringify({
      ...sessionConfig,
      ...(Object.keys(otherHelpers).length > 0 ? { credHelpers: otherHelpers } : {}),
      auths: {
        ...currentAuths,
        [registryHost]: { username: credential.username, password: credential.password, auth },
      },
    })}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  await chmod(configPath, 0o600);
}

async function prepareBuildkitTrust(
  directory: string,
  registryHost: string,
  tls: OciRegistryTlsConfig | undefined
): Promise<string | undefined> {
  if (!tls?.caCertificate && !tls?.caFile && !tls?.insecure && !tls?.plainHttp) return undefined;

  let caPath: string | undefined;
  if (tls.caCertificate) {
    caPath = join(directory, 'registry-ca.pem');
    await writeFile(caPath, tls.caCertificate, { encoding: 'utf8', mode: 0o600 });
  } else if (tls.caFile) {
    caPath = join(directory, basename(tls.caFile));
    await copyFile(resolve(tls.caFile), caPath);
    await chmod(caPath, 0o600);
  }

  const lines = [
    `[registry.${tomlString(registryHost)}]`,
    ...(caPath ? [`  ca = [${tomlString(caPath)}]`] : []),
    ...(tls.plainHttp ? ['  http = true'] : []),
    ...(tls.insecure ? ['  insecure = true'] : []),
  ];
  const configPath = join(directory, 'buildkitd.toml');
  await writeFile(configPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  return configPath;
}

/** Open an isolated Docker authentication and BuildKit trust session. */
export async function createDockerRegistrySession(
  options: DockerRegistrySessionOptions
): Promise<RegistrySession> {
  const directory = await mkdtemp(join(tmpdir(), 'typekro-registry-'));
  await chmod(directory, 0o700);

  try {
    const configPath = join(directory, 'config.json');
    await mkdir(dirname(configPath), { recursive: true });
    await copyDockerConfiguration(
      options.dockerConfigPath ?? defaultDockerConfigPath(),
      configPath
    );
    const environment = { DOCKER_CONFIG: directory };

    if (options.credentialProvider) {
      const credential = await options.credentialProvider(options.signal);
      if (!credential.username || !credential.password) {
        throw new ContainerBuildError(
          'OCI credential provider returned an empty username or password.',
          'REGISTRY_CREDENTIAL_INVALID',
          ['Return both username and password from the credential provider.']
        );
      }
      if (options.tls?.plainHttp) {
        // Docker login has no transport override and probes HTTPS even when the
        // BuildKit registry is explicitly configured for plain HTTP. Write the
        // standard short-lived auth entry directly into this isolated session.
        await writeDockerCredential(configPath, options.registryHost, credential);
      } else {
        await execDocker(
          ['login', '--username', credential.username, '--password-stdin', options.registryHost],
          {
            stdin: credential.password,
            quiet: true,
            timeout: options.timeout,
            environment,
            ...(options.signal ? { signal: options.signal } : {}),
            sensitiveValues: [credential.username, credential.password],
          }
        );
      }
    }

    const buildkitConfigPath = await prepareBuildkitTrust(
      directory,
      options.registryHost,
      options.tls
    );
    return {
      remote: true,
      environment,
      ...(buildkitConfigPath ? { buildkitConfigPath } : {}),
      async cleanup() {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof ContainerBuildError) throw error;
    throw new ContainerBuildError(
      `Failed to prepare isolated registry credentials: ${error instanceof Error ? error.message : String(error)}`,
      'REGISTRY_SESSION_FAILED',
      ['Verify the Docker config, credential provider, and registry TLS configuration.'],
      error instanceof Error ? error : undefined
    );
  }
}

/** Read an isolated Docker config for tests without exposing it through public build results. */
export async function readDockerSessionConfig(
  session: RegistrySession
): Promise<string | undefined> {
  const directory = session.environment?.DOCKER_CONFIG;
  if (!directory) return undefined;
  return readFile(join(directory, 'config.json'), 'utf8');
}
