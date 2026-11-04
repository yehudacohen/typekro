import { getComponentLogger } from '../logging/index.js';
import { execDocker } from './exec.js';
import type { ContainerBuilderLifecycle, RegistrySession } from './registries/types.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type BuilderLifecycleState = Mutable<ContainerBuilderLifecycle>;
const logger = getComponentLogger('container-builder');
// Read only the required metadata: no container config/environment or volume payload.
const CONTAINER_FORMAT =
  '{{json .Id}}\n{{json .Name}}\n{{range .Mounts}}{{if and (eq .Type "volume") (eq .Destination "/var/lib/buildkit")}}{{json .Name}}{{end}}{{end}}';
const VOLUME_FORMAT = '{{json .Name}}\n{{json .Driver}}\n{{json .Scope}}\n{{json .CreatedAt}}';

function safeIdentifier(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value)) throw new Error('Invalid metadata.');
  return value;
}

function strings(output: string, count: number): string[] {
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== count) throw new Error('Incomplete metadata.');
  return lines.map((line) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'string' || !value) throw new Error('Invalid metadata.');
    return value;
  });
}

/** Capture Docker selection without retaining it in the public lifecycle record. */
export function bindRegistrySession(session: RegistrySession): RegistrySession {
  const environment: Record<string, string> = {};
  for (const key of [
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'DOCKER_HOST',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'DOCKER_API_VERSION',
    'BUILDX_CONFIG',
  ]) {
    environment[key] = process.env[key] ?? '';
  }
  Object.assign(environment, session.environment);
  return {
    remote: session.remote,
    environment: Object.freeze(environment),
    ...(session.buildkitConfigPath ? { buildkitConfigPath: session.buildkitConfigPath } : {}),
    cleanup: () => session.cleanup(),
  };
}

export function newBuilderLifecycle(name: string): BuilderLifecycleState {
  return {
    name,
    nodeName: `${name}0`,
    driver: 'docker-container',
    creation: 'uncertain',
    identity: 'incomplete',
    removal: 'not-attempted',
    removalIssue: 'creation-unconfirmed',
  };
}

/** Allocate the caller's lifecycle record BEFORE create/bootstrap can fail. */
export async function createTemporaryBuilder(
  state: BuilderLifecycleState,
  session: RegistrySession,
  timeout: number,
  signal?: AbortSignal
): Promise<void> {
  try {
    await execDocker(
      [
        'buildx',
        'create',
        '--name',
        state.name,
        '--node',
        state.nodeName,
        '--driver',
        state.driver,
        ...(session.buildkitConfigPath ? ['--buildkitd-config', session.buildkitConfigPath] : []),
        '--bootstrap',
      ],
      {
        quiet: true,
        timeout,
        ...(session.environment ? { environment: session.environment } : {}),
        ...(signal ? { signal } : {}),
      }
    );
    state.creation = 'completed';
    delete state.removalIssue;
  } finally {
    // Best-effort metadata also preserves a partial create; it never overrides the create error.
    await observeBuilder(state, session, timeout);
  }
}

async function observeBuilder(
  state: BuilderLifecycleState,
  session: RegistrySession,
  timeout: number
): Promise<void> {
  const run = (args: string[]) =>
    execDocker(args, {
      quiet: true,
      timeout: Math.min(timeout, 5_000),
      ...(session.environment ? { environment: session.environment } : {}),
    });
  try {
    state.dockerContext = safeIdentifier((await run(['context', 'show'])).stdout.trim());
    state.daemonId = safeIdentifier((await run(['info', '--format', '{{.ID}}'])).stdout.trim());
    const expected = `buildx_buildkit_${state.nodeName}`;
    const [id, name, volume] = strings(
      (await run(['container', 'inspect', expected, '--format', CONTAINER_FORMAT])).stdout,
      3
    );
    if (!id || !/^[a-f0-9]{64}$/.test(id) || name !== `/${expected}` || !volume) {
      throw new Error('Unexpected builder identity.');
    }
    const volumeName = safeIdentifier(volume);
    state.container = Object.freeze({ id, name, stateVolumeName: volumeName });
    const [actualName, driver, scope, createdAt] = strings(
      (await run(['volume', 'inspect', volumeName, '--format', VOLUME_FORMAT])).stdout,
      4
    );
    if (
      actualName !== volumeName ||
      !driver ||
      !scope ||
      !createdAt ||
      !/^[0-9T:.+Z-]+$/.test(createdAt) ||
      !Number.isFinite(Date.parse(createdAt))
    ) {
      throw new Error('Unexpected state volume identity.');
    }
    state.stateVolume = Object.freeze({
      name: volumeName,
      driver: safeIdentifier(driver),
      scope: safeIdentifier(scope),
      createdAt,
    });
    const after = safeIdentifier((await run(['info', '--format', '{{.ID}}'])).stdout.trim());
    if (after !== state.daemonId) throw new Error('Daemon changed during observation.');
    state.identity = 'observed';
  } catch {
    // Raw CLI/config/registry diagnostics may contain private material. Keep only bounded outcomes.
    logger.warn('Temporary Buildx physical identity is incomplete', {
      builder: state.name,
      code: 'BUILDER_IDENTITY_INCOMPLETE',
    });
  }
}

export async function removeTemporaryBuilder(
  state: BuilderLifecycleState,
  session: RegistrySession,
  timeout: number
): Promise<void> {
  if (state.creation !== 'completed') return;
  const options = {
    quiet: true,
    timeout: Math.min(timeout, 30_000),
    ...(session.environment ? { environment: session.environment } : {}),
  };
  if (state.daemonId) {
    try {
      const current = (await execDocker(['info', '--format', '{{.ID}}'], options)).stdout.trim();
      if (current !== state.daemonId) {
        state.removal = 'uncertain';
        state.removalIssue = 'daemon-changed';
        return;
      }
    } catch {
      state.removal = 'uncertain';
      state.removalIssue = 'daemon-unavailable';
      return;
    }
  }
  try {
    await execDocker(['buildx', 'rm', '--force', state.name], options);
    state.removal = 'command-succeeded';
  } catch {
    state.removal = 'uncertain';
    state.removalIssue = 'command-failed';
    logger.warn('Temporary Buildx removal did not complete', {
      builder: state.name,
      code: 'BUILDER_REMOVE_FAILED',
    });
  }
}

export function snapshotBuilder(state: BuilderLifecycleState): ContainerBuilderLifecycle {
  return Object.freeze({ ...state });
}
