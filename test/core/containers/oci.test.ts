import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildContainer } from '../../../src/core/containers/build.js';
import { ContainerBuildError } from '../../../src/core/containers/errors.js';
import { kubernetesSecretRegistryCredentials } from '../../../src/core/containers/registries/credentials.js';
import { harbor } from '../../../src/core/containers/registries/harbor.js';
import {
  normalizeRegistryHost,
  OciRegistryHandler,
} from '../../../src/core/containers/registries/oci.js';
import type { RegistryHandler } from '../../../src/core/containers/registries/types.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

describe('generic OCI registry provider', () => {
  let directory = '';
  let originalPath = '';
  let logPath = '';
  let stdinPath = '';
  let contextPath = '';

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'typekro-oci-test-'));
    originalPath = process.env.PATH ?? '';
    logPath = join(directory, 'docker-log.jsonl');
    stdinPath = join(directory, 'docker-stdin');
    contextPath = join(directory, 'context');
    mkdirSync(contextPath);
    writeFileSync(join(contextPath, 'Dockerfile'), 'FROM scratch\n');

    const dockerPath = join(directory, 'docker');
    writeFileSync(
      dockerPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args, dockerConfig: process.env.DOCKER_CONFIG }) + '\\n');
if (process.env.FAKE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {});
if (args[0] === 'version') { process.stdout.write('28.0.0\\n'); process.exit(0); }
if (args[0] === 'login') {
  if (process.env.FAKE_EXPECT_CONTEXT_METADATA) {
    const root = process.env.DOCKER_CONFIG + '/contexts/meta';
    const metadata = fs.readdirSync(root, { recursive: true }).find(entry => String(entry).endsWith('meta.json'));
    if (!metadata) process.exit(20);
  }
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    fs.writeFileSync(process.env.FAKE_DOCKER_STDIN, input);
    process.exit(process.env.FAKE_LOGIN_FAIL === '1' ? 1 : 0);
  });
  return;
}
if (args[0] === 'buildx' && args[1] === 'build') {
  if (process.env.FAKE_EXPECT_CONFIG_CONTENT) {
    const config = fs.readFileSync(process.env.DOCKER_CONFIG + '/config.json', 'utf8');
    if (!config.includes(process.env.FAKE_EXPECT_CONFIG_CONTENT)) process.exit(18);
    if (process.env.FAKE_REJECT_CREDS_STORE && JSON.parse(config).credsStore) process.exit(22);
  }
  const finish = () => {
    const index = args.indexOf('--metadata-file');
    fs.writeFileSync(args[index + 1], JSON.stringify({ 'containerimage.digest': process.env.FAKE_METADATA_DIGEST || '${DIGEST}' }));
    process.exit(0);
  };
  const delay = Number(process.env.FAKE_BUILD_DELAY_MS || 0);
  if (delay > 0) setTimeout(finish, delay); else finish();
  return;
}
if (args[0] === 'buildx' && args[1] === 'create') {
  if (process.env.FAKE_EXPECT_BUILDX_PLUGIN && !fs.existsSync(process.env.DOCKER_CONFIG + '/cli-plugins/docker-buildx')) process.exit(21);
  if (process.env.FAKE_REJECT_BUILDKIT_CA === '1') process.exit(19);
  process.exit(0);
}
if (args[0] === 'buildx' && args[1] === 'imagetools') {
  process.stdout.write(JSON.stringify(process.env.FAKE_INSPECT_DIGEST || '${DIGEST}') + '\\n');
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o700 }
    );
    chmodSync(dockerPath, 0o700);
    process.env.PATH = `${directory}:${originalPath}`;
    process.env.FAKE_DOCKER_LOG = logPath;
    process.env.FAKE_DOCKER_STDIN = stdinPath;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_DOCKER_LOG;
    delete process.env.FAKE_DOCKER_STDIN;
    delete process.env.FAKE_LOGIN_FAIL;
    delete process.env.FAKE_METADATA_DIGEST;
    delete process.env.FAKE_INSPECT_DIGEST;
    delete process.env.FAKE_EXPECT_CONFIG_CONTENT;
    delete process.env.FAKE_EXPECT_CONTEXT_METADATA;
    delete process.env.FAKE_EXPECT_BUILDX_PLUGIN;
    delete process.env.FAKE_REJECT_CREDS_STORE;
    delete process.env.FAKE_BUILD_DELAY_MS;
    delete process.env.FAKE_IGNORE_SIGTERM;
    delete process.env.FAKE_REJECT_BUILDKIT_CA;
    rmSync(directory, { recursive: true, force: true });
  });

  it('normalizes origins, composes repository prefixes, and keeps Harbor transport-thin', async () => {
    expect(normalizeRegistryHost('https://registry.example.test')).toBe('registry.example.test');
    const config = harbor({ registry: 'registry.example.test:5443', project: 'chirp' });
    const handler = new OciRegistryHandler(config);
    expect(await handler.resolveImageUri('gateway', 'sha-content')).toBe(
      'registry.example.test:5443/chirp/gateway:sha-content'
    );
    expect(() => normalizeRegistryHost('https://user:pass@registry.test/path')).toThrow(
      ContainerBuildError
    );
    expect(
      () => new OciRegistryHandler({ type: 'oci', registry: 'http://registry.example.test' })
    ).toThrow('must explicitly enable tls.plainHttp');
    expect(
      () =>
        new OciRegistryHandler({
          type: 'oci',
          registry: 'registry.example.test',
          tls: { plainHttp: true, insecure: true },
        })
    ).toThrow('cannot be combined');
  });

  it('publishes through an isolated session and returns a registry-verified immutable URI', async () => {
    const password = 'not-on-the-command-line';
    const result = await buildContainer({
      context: contextPath,
      imageName: 'gateway',
      tag: 'sha-content',
      platforms: ['linux/amd64', 'linux/arm64'],
      registry: harbor({
        registry: 'https://registry.example.test',
        project: 'chirp',
        credentialProvider: async () => ({ username: 'robot$chirp', password }),
        tls: { caCertificate: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----' },
      }),
    });

    expect(result).toMatchObject({
      imageUri: `registry.example.test/chirp/gateway@${DIGEST}`,
      taggedImageUri: 'registry.example.test/chirp/gateway:sha-content',
      repository: 'registry.example.test/chirp/gateway',
      tag: 'sha-content',
      digest: DIGEST,
      pushed: true,
      platforms: ['linux/amd64', 'linux/arm64'],
    });
    expect(readFileSync(stdinPath, 'utf8')).toBe(password);
    const log = readFileSync(logPath, 'utf8');
    expect(log).not.toContain(password);
    expect(log).toContain('"login"');
    expect(log).toContain('"create"');
    expect(log).toContain('"--buildkitd-config"');
    expect(log).toContain('"--push"');
    expect(log).toContain('"imagetools"');
    const records = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { dockerConfig?: string });
    for (const record of records) {
      if (record.dockerConfig) expect(existsSync(record.dockerConfig)).toBe(false);
    }
  });

  it('fails closed when BuildKit and the registry disagree about the manifest digest', async () => {
    process.env.FAKE_METADATA_DIGEST = OTHER_DIGEST;
    await expect(
      buildContainer({
        context: contextPath,
        imageName: 'gateway',
        registry: harbor({ registry: 'registry.example.test', project: 'chirp' }),
      })
    ).rejects.toMatchObject({ code: 'DIGEST_VERIFICATION_FAILED' });
  });

  it('reports authentication rejection without exposing the credential', async () => {
    process.env.FAKE_LOGIN_FAIL = '1';
    const password = 'registry-secret-value';
    let failure: unknown;
    try {
      await buildContainer({
        context: contextPath,
        imageName: 'gateway',
        registry: harbor({
          registry: 'registry.example.test',
          project: 'chirp',
          credentialProvider: async () => ({ username: 'robot$chirp', password }),
        }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ContainerBuildError);
    expect(String(failure)).not.toContain(password);
    expect(readFileSync(logPath, 'utf8')).not.toContain(password);
  });

  it('discovers an existing Docker config inside an isolated, cleaned session', async () => {
    const dockerConfig = join(directory, 'source-docker-config.json');
    const marker = 'credential-helper-marker';
    writeFileSync(
      dockerConfig,
      JSON.stringify({ credHelpers: { 'registry.example.test': marker } })
    );
    process.env.FAKE_EXPECT_CONFIG_CONTENT = marker;
    await buildContainer({
      context: contextPath,
      imageName: 'gateway',
      registry: harbor({
        registry: 'registry.example.test',
        project: 'chirp',
        dockerConfigPath: dockerConfig,
      }),
    });
    const records = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { dockerConfig?: string });
    const isolated = records.map((record) => record.dockerConfig).filter(Boolean);
    expect(isolated.length).toBeGreaterThan(0);
    for (const path of isolated) expect(existsSync(String(path))).toBe(false);
  });

  it('preserves named Docker context metadata inside an isolated session', async () => {
    const dockerDirectory = join(directory, 'source-docker');
    const dockerConfig = join(dockerDirectory, 'config.json');
    const contextMetadata = join(dockerDirectory, 'contexts', 'meta', 'orbstack-hash');
    mkdirSync(contextMetadata, { recursive: true });
    writeFileSync(dockerConfig, JSON.stringify({ currentContext: 'orbstack' }));
    writeFileSync(
      join(contextMetadata, 'meta.json'),
      JSON.stringify({ Name: 'orbstack', Endpoints: { docker: {} } })
    );
    process.env.FAKE_EXPECT_CONTEXT_METADATA = '1';

    await buildContainer({
      context: contextPath,
      imageName: 'context-aware',
      registry: harbor({
        registry: 'registry.example.test',
        project: 'chirp',
        dockerConfigPath: dockerConfig,
        credentialProvider: async () => ({ username: 'robot$chirp', password: 'context-token' }),
      }),
    });

    expect(existsSync(join(contextMetadata, 'meta.json'))).toBe(true);
    const records = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { dockerConfig?: string });
    for (const isolated of records.map((record) => record.dockerConfig).filter(Boolean)) {
      expect(existsSync(String(isolated))).toBe(false);
    }
  });

  it('uses isolated Docker auth directly for an explicitly plain-HTTP registry', async () => {
    const password = 'local-plain-http-token';
    const dockerDirectory = join(directory, 'plain-http-docker');
    const dockerConfig = join(dockerDirectory, 'config.json');
    const buildxPlugin = join(dockerDirectory, 'cli-plugins', 'docker-buildx');
    mkdirSync(join(dockerDirectory, 'cli-plugins'), { recursive: true });
    writeFileSync(dockerConfig, JSON.stringify({ credsStore: 'osxkeychain' }));
    writeFileSync(buildxPlugin, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    process.env.FAKE_EXPECT_CONFIG_CONTENT = 'robot$local';
    process.env.FAKE_EXPECT_BUILDX_PLUGIN = '1';
    process.env.FAKE_REJECT_CREDS_STORE = '1';

    await buildContainer({
      context: contextPath,
      imageName: 'plain-http',
      registry: harbor({
        registry: 'http://registry.local.test:5000',
        project: 'chirp',
        dockerConfigPath: dockerConfig,
        credentialProvider: async () => ({ username: 'robot$local', password }),
        tls: { plainHttp: true },
      }),
    });

    const log = readFileSync(logPath, 'utf8');
    expect(log).not.toContain('"login"');
    expect(log).not.toContain(password);
    expect(existsSync(stdinPath)).toBe(false);
  });

  it('bounds timeout and cancellation even when a Docker subprocess ignores SIGTERM', async () => {
    process.env.FAKE_BUILD_DELAY_MS = '10000';
    process.env.FAKE_IGNORE_SIGTERM = '1';
    const started = Date.now();
    await expect(
      buildContainer({
        context: contextPath,
        imageName: 'timeout',
        timeout: 100,
        registry: harbor({ registry: 'registry.example.test', project: 'chirp' }),
      })
    ).rejects.toMatchObject({ code: 'BUILD_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2_500);

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    const cancelled = Date.now();
    await expect(
      buildContainer({
        context: contextPath,
        imageName: 'cancelled',
        signal: abort.signal,
        registry: harbor({ registry: 'registry.example.test', project: 'chirp' }),
      })
    ).rejects.toMatchObject({ code: 'BUILD_CANCELLED' });
    expect(Date.now() - cancelled).toBeLessThan(2_500);
  });

  it('fails closed when configured custom CA trust is rejected by BuildKit', async () => {
    process.env.FAKE_REJECT_BUILDKIT_CA = '1';
    await expect(
      buildContainer({
        context: contextPath,
        imageName: 'ca-rejected',
        registry: harbor({
          registry: 'registry.example.test',
          project: 'chirp',
          tls: { caCertificate: '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----' },
        }),
      })
    ).rejects.toMatchObject({ code: 'DOCKER_COMMAND_FAILED' });
  });

  it('resolves credentials from a selected Kubernetes Secret without retaining them', async () => {
    const requests: unknown[] = [];
    const explicit = kubernetesSecretRegistryCredentials({
      namespace: 'harbor-system',
      name: 'push-robot',
      context: 'orbstack',
      secretReader: async (request) => {
        requests.push(request);
        return {
          username: Buffer.from('robot$push').toString('base64'),
          password: Buffer.from('short-lived').toString('base64'),
        };
      },
    });
    expect(await explicit()).toEqual({ username: 'robot$push', password: 'short-lived' });
    expect(requests).toEqual([
      { namespace: 'harbor-system', name: 'push-robot', context: 'orbstack' },
    ]);

    const dockerConfig = kubernetesSecretRegistryCredentials({
      namespace: 'chirp',
      name: 'push-json',
      registry: 'registry.example.test',
      secretReader: async () => ({
        '.dockerconfigjson': Buffer.from(
          JSON.stringify({
            auths: {
              'https://registry.example.test': {
                auth: Buffer.from('robot$json:one-time').toString('base64'),
              },
            },
          })
        ).toString('base64'),
      }),
    });
    expect(await dockerConfig()).toEqual({ username: 'robot$json', password: 'one-time' });

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(explicit(cancelled.signal)).rejects.toMatchObject({
      code: 'BUILD_CANCELLED',
    });
  });

  it('accepts an external registry handler through one conformance boundary', async () => {
    const calls: string[] = [];
    const handler: RegistryHandler = {
      async resolveImageUri(imageName, tag) {
        calls.push(`resolve:${imageName}:${tag}`);
        return `extension.test/${imageName}:${tag}`;
      },
      async prepare(imageName) {
        calls.push(`prepare:${imageName}`);
        return {
          remote: false,
          async cleanup() {
            calls.push('cleanup');
          },
        };
      },
    };
    const result = await buildContainer({
      context: contextPath,
      imageName: 'extension',
      tag: 'v1',
      registry: { type: 'custom', handler },
    });
    expect(result.imageUri).toBe('extension.test/extension:v1');
    expect(calls).toEqual(['resolve:extension:v1', 'prepare:extension', 'cleanup']);
  });
});
