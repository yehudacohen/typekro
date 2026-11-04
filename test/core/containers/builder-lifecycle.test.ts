import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContainer } from '../../../src/core/containers/build.js';
import { ContainerBuildError } from '../../../src/core/containers/errors.js';
import type { ContainerBuildOptions } from '../../../src/core/containers/registries/types.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'c'.repeat(64);
const CREATED_AT = '2026-01-02T03:04:05Z';
const PRIVATE_DIAGNOSTIC = 'private-auth-path-or-error';

// A native fake Docker executable exercises the public buildContainer path, never a real daemon.
describe('temporary builder lifecycle output', () => {
  let directory = '';
  let originalPath = '';
  let originalHost: string | undefined;
  let sessionDirectory = '';
  let mode = '';
  let cleanupCalls = 0;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'typekro-builder-lifecycle-'));
    originalPath = process.env.PATH ?? '';
    originalHost = process.env.DOCKER_HOST;
    mode = '';
    cleanupCalls = 0;
    sessionDirectory = join(directory, 'session');
    mkdirSync(sessionDirectory);
    writeFileSync(join(sessionDirectory, 'config.json'), '{}');
    mkdirSync(join(directory, 'context'));
    writeFileSync(join(directory, 'context', 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(
      join(directory, 'docker'),
      `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const root=__dirname, args=process.argv.slice(2);
fs.appendFileSync(path.join(root,'log'),JSON.stringify({args,host:process.env.DOCKER_HOST})+'\\n');
const mode=fs.readFileSync(path.join(root,'mode'),'utf8');
const statePath=path.join(root,'state');
if(args[0]==='version'){console.log('28.0.0');process.exit(0);}
if(args[0]==='context'){console.log('fixture-context');process.exit(0);}
if(args[0]==='info'){
 const p=path.join(root,'info-count'), n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8'))+1:1;
 fs.writeFileSync(p,String(n));console.log(mode==='daemon-change'&&n>=3?'other-daemon':'fixture-daemon');process.exit(0);
}
if(args[0]==='buildx'&&args[1]==='create'){
 const name=args[args.indexOf('--name')+1],node=args[args.indexOf('--node')+1];
 fs.writeFileSync(statePath,JSON.stringify({name,node,volume:'observed-volume-'+node}));
 if(mode==='create-fail'){console.error('${PRIVATE_DIAGNOSTIC}');process.exit(17);}process.exit(0);
}
const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):null;
if(args[0]==='container'){
 if(mode==='identity-fail'){console.error('${PRIVATE_DIAGNOSTIC}');process.exit(18);}
 console.log(JSON.stringify('${CONTAINER_ID}')+'\\n'+JSON.stringify('/buildx_buildkit_'+state.node)+'\\n'+JSON.stringify(state.volume));process.exit(0);
}
if(args[0]==='volume'){
 if(mode==='volume-identity-fail'){console.error('${PRIVATE_DIAGNOSTIC}');process.exit(18);}
 console.log([state.volume,'local','local','${CREATED_AT}'].map(x=>JSON.stringify(x)).join('\\n'));process.exit(0);
}
if(args[0]==='buildx'&&args[1]==='rm'){
 if(mode==='remove-fail'||mode==='build-and-cleanup-fail'){console.error('${PRIVATE_DIAGNOSTIC}');process.exit(19);}process.exit(0);
}
if(args[0]==='buildx'&&args[1]==='imagetools'){console.log(JSON.stringify('${DIGEST}'));process.exit(0);}
if(args[0]==='buildx'&&args[1]==='build'){
 if(mode==='build-and-cleanup-fail'){console.error('primary build failed');process.exit(23);}
 const finish=()=>{fs.writeFileSync(args[args.indexOf('--metadata-file')+1],JSON.stringify({'containerimage.digest':'${DIGEST}'}));process.exit(0);};
 if(mode==='slow-build')setTimeout(finish,1500);else finish();return;
}
if(args[0]==='build')process.exit(0);
console.error('Unexpected fake Docker command');process.exit(29);
`,
      { mode: 0o700 }
    );
    process.env.PATH = `${directory}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = originalHost;
    rmSync(directory, { recursive: true, force: true });
  });

  function options(remote = true): ContainerBuildOptions {
    writeFileSync(join(directory, 'mode'), mode);
    return {
      context: join(directory, 'context'),
      imageName: 'fixture',
      tag: 'input-key',
      quiet: true,
      timeout: 5000,
      registry: {
        type: 'custom',
        handler: {
          async resolveImageUri() {
            return remote ? 'registry.example.invalid/fixture:input-key' : 'fixture:input-key';
          },
          async prepare() {
            return {
              remote,
              buildkitConfigPath: join(directory, 'private-trust.toml'),
              environment: { DOCKER_CONFIG: sessionDirectory, FAKE_BUILDER_ROOT: directory },
              async cleanup() {
                cleanupCalls++;
                if (mode === 'session-fail' || mode === 'build-and-cleanup-fail')
                  throw new Error(PRIVATE_DIAGNOSTIC);
                rmSync(sessionDirectory, { recursive: true, force: true });
              },
            };
          },
        },
      },
    };
  }

  function log(): Array<{ args: string[]; host?: string }> {
    return readFileSync(join(directory, 'log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const record: unknown = JSON.parse(line);
        if (
          !record ||
          typeof record !== 'object' ||
          !('args' in record) ||
          !Array.isArray(record.args)
        ) {
          throw new Error('Invalid fake Docker log');
        }
        const args: string[] = [];
        for (const arg of record.args) {
          if (typeof arg !== 'string') throw new Error('Invalid fake Docker argument');
          args.push(arg);
        }
        return {
          args,
          ...('host' in record && typeof record.host === 'string' ? { host: record.host } : {}),
        };
      });
  }

  function storedState() {
    const state: unknown = JSON.parse(readFileSync(join(directory, 'state'), 'utf8'));
    if (
      !state ||
      typeof state !== 'object' ||
      !('name' in state) ||
      typeof state.name !== 'string' ||
      !('node' in state) ||
      typeof state.node !== 'string' ||
      !('volume' in state) ||
      typeof state.volume !== 'string'
    ) {
      throw new Error('Invalid fake builder state');
    }
    return { name: state.name, node: state.node, volume: state.volume };
  }

  async function waitForBuild() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (
        existsSync(join(directory, 'log')) &&
        log().some((r) => r.args[0] === 'buildx' && r.args[1] === 'build')
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Fake build was not started');
  }

  it('returns observed physical identity and command outcome without claiming reclaim', async () => {
    const result = await buildContainer(options());
    const state = storedState();
    expect(result.imageUri).toBe(`registry.example.invalid/fixture@${DIGEST}`);
    expect(result.cleanup?.builder).toMatchObject({
      name: state.name,
      nodeName: state.node,
      creation: 'completed',
      identity: 'observed',
      dockerContext: 'fixture-context',
      daemonId: 'fixture-daemon',
      container: {
        id: CONTAINER_ID,
        name: `/buildx_buildkit_${state.node}`,
        stateVolumeName: state.volume,
      },
      stateVolume: { name: state.volume, driver: 'local', scope: 'local', createdAt: CREATED_AT },
      removal: 'command-succeeded',
    });
    expect(Object.isFrozen(result.cleanup?.builder)).toBe(true);
    expect(cleanupCalls).toBe(1);
    expect(existsSync(sessionDirectory)).toBe(false);
    expect(JSON.stringify(result.cleanup)).not.toContain(directory);
    expect(result.cleanup).toMatchObject({
      registrySession: 'completed',
      metadataFiles: 'completed',
    });
  });

  it('retains image success and identity when removal fails, after auth cleanup', async () => {
    mode = 'remove-fail';
    const result = await buildContainer(options());
    expect(result.pushed).toBe(true);
    expect(result.cleanup?.builder).toMatchObject({
      identity: 'observed',
      removal: 'uncertain',
      removalIssue: 'command-failed',
    });
    expect(result.cleanup?.builder?.container?.id).toBe(CONTAINER_ID);
    expect(existsSync(sessionDirectory)).toBe(false);
    expect(JSON.stringify(result.cleanup)).not.toContain(PRIVATE_DIAGNOSTIC);
  });

  it('preserves partial creation identity on error without deleting unconfirmed state', async () => {
    mode = 'create-fail';
    try {
      await buildContainer(options());
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerBuildError);
      if (!(error instanceof ContainerBuildError)) throw error;
      expect(error.code).toBe('DOCKER_COMMAND_FAILED');
      expect(error.cleanup?.builder).toMatchObject({
        creation: 'uncertain',
        identity: 'observed',
        removal: 'not-attempted',
        removalIssue: 'creation-unconfirmed',
      });
      expect(error.cleanup?.builder?.container?.id).toBe(CONTAINER_ID);
      expect(log().some((r) => r.args[1] === 'rm' || r.args[1] === 'build')).toBe(false);
      expect(existsSync(sessionDirectory)).toBe(false);
    }
  });

  it('keeps the primary build failure through builder and session cleanup failures', async () => {
    mode = 'build-and-cleanup-fail';
    try {
      await buildContainer(options());
      throw new Error('Expected failure');
    } catch (error) {
      if (!(error instanceof ContainerBuildError)) throw error;
      expect(error.code).toBe('DOCKER_COMMAND_FAILED');
      expect(error.command?.exitCode).toBe(23);
      expect(error.message).toContain('primary build failed');
      expect(error.cleanup).toMatchObject({
        registrySession: 'uncertain',
        metadataFiles: 'completed',
        builder: { removal: 'uncertain' },
      });
      expect(error.buildResult).toBeUndefined();
      expect(JSON.stringify(error.cleanup)).not.toContain(PRIVATE_DIAGNOSTIC);
    }
  });

  it('preserves an immutable primary error as the cause instead of failing to attach cleanup', async () => {
    const primary = Object.freeze(
      new ContainerBuildError('primary preparation failed', 'FROZEN_PRIMARY')
    );
    const input = options();
    if (input.registry.type !== 'custom') throw new Error('Expected fixture handler');
    input.registry = {
      type: 'custom',
      handler: {
        ...input.registry.handler,
        async prepare() {
          throw primary;
        },
      },
    };
    try {
      await buildContainer(input);
      throw new Error('Expected failure');
    } catch (error) {
      if (!(error instanceof ContainerBuildError)) throw error;
      expect(error.code).toBe('FROZEN_PRIMARY');
      expect(error.cause).toBe(primary);
      expect(error.cleanup).toMatchObject({
        registrySession: 'not-returned',
        metadataFiles: 'completed',
      });
    }
  });

  it('reports session cleanup failure separately from a completed image', async () => {
    mode = 'session-fail';
    try {
      await buildContainer(options());
      throw new Error('Expected failure');
    } catch (error) {
      if (!(error instanceof ContainerBuildError)) throw error;
      expect(error.code).toBe('CLEANUP_FAILED');
      expect(error.buildResult?.digest).toBe(DIGEST);
      expect(error.cleanup).toMatchObject({
        registrySession: 'uncertain',
        metadataFiles: 'completed',
      });
      expect(JSON.stringify(error.cleanup)).not.toContain(PRIVATE_DIAGNOSTIC);
      expect(error.message).not.toContain(PRIVATE_DIAGNOSTIC);
    }
  });

  it('labels failed observation incomplete instead of guessing physical identities', async () => {
    mode = 'identity-fail';
    const result = await buildContainer(options());
    expect(result.cleanup?.builder).toMatchObject({
      creation: 'completed',
      identity: 'incomplete',
      removal: 'command-succeeded',
    });
    expect(result.cleanup?.builder?.container).toBeUndefined();
    expect(result.cleanup?.builder?.stateVolume).toBeUndefined();
    expect(JSON.stringify(result.cleanup)).not.toContain(PRIVATE_DIAGNOSTIC);
  });

  it('preserves the observed mounted-volume name when volume metadata is unavailable', async () => {
    mode = 'volume-identity-fail';
    const result = await buildContainer(options());
    expect(result.cleanup?.builder?.identity).toBe('incomplete');
    expect(result.cleanup?.builder?.container).toMatchObject({
      id: CONTAINER_ID,
      stateVolumeName: storedState().volume,
    });
    expect(result.cleanup?.builder?.stateVolume).toBeUndefined();
    expect(JSON.stringify(result.cleanup)).not.toContain(PRIVATE_DIAGNOSTIC);
  });

  it('rejects a conflicting builder override before allocating a builder', async () => {
    await expect(
      buildContainer({ ...options(), extraDockerArgs: ['--builder=unowned'] })
    ).rejects.toMatchObject({ code: 'BUILDER_OVERRIDE_CONFLICT' });
    expect(log().some((r) => r.args[1] === 'create' || r.args[1] === 'rm')).toBe(false);
    expect(existsSync(sessionDirectory)).toBe(false);
  });

  it('retains state instead of removing against a changed daemon', async () => {
    mode = 'daemon-change';
    const result = await buildContainer(options());
    expect(result.cleanup?.builder).toMatchObject({
      removal: 'uncertain',
      removalIssue: 'daemon-changed',
    });
    expect(log().some((r) => r.args[1] === 'rm')).toBe(false);
  });

  it('carries lifecycle on cancellation and still attempts owned cleanup', async () => {
    mode = 'slow-build';
    const controller = new AbortController();
    const pending = buildContainer({ ...options(), signal: controller.signal });
    await waitForBuild();
    controller.abort();
    try {
      await pending;
      throw new Error('Expected cancellation');
    } catch (error) {
      if (!(error instanceof ContainerBuildError)) throw error;
      expect(error.code).toBe('BUILD_CANCELLED');
      expect(error.cleanup?.builder?.removal).toBe('command-succeeded');
      expect(existsSync(sessionDirectory)).toBe(false);
    }
  });

  it('preserves immutable tag adoption while returning builder cleanup', async () => {
    const result = await buildContainer({ ...options(), existingTagPolicy: 'adopt' });
    expect(result.digest).toBe(DIGEST);
    expect(result.cleanup?.builder?.removal).toBe('command-succeeded');
    expect(log().some((r) => r.args[1] === 'build')).toBe(false);
  });

  it('does not allocate builder state for a local build', async () => {
    const result = await buildContainer(options(false));
    expect(result.pushed).toBe(false);
    expect(result.cleanup?.builder).toBeUndefined();
    expect(cleanupCalls).toBe(1);
    expect(log().some((r) => r.args[1] === 'create' || r.args[1] === 'inspect')).toBe(false);
  });

  it('keeps the selected Docker environment through cleanup', async () => {
    mode = 'slow-build';
    process.env.DOCKER_HOST = 'tcp://fixture.invalid:2375';
    const pending = buildContainer(options());
    await waitForBuild();
    process.env.DOCKER_HOST = 'tcp://changed.invalid:2375';
    await pending;
    expect(
      log()
        .filter((r) => r.args[1] === 'rm')
        .map((r) => r.host)
    ).toEqual(['tcp://fixture.invalid:2375']);
  });
});
