import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { getComponentLogger } from '../logging/index.js';
import {
  type BuilderLifecycleState,
  bindRegistrySession,
  createTemporaryBuilder,
  newBuilderLifecycle,
  removeTemporaryBuilder,
  snapshotBuilder,
} from './builder-lifecycle.js';
import { ContainerBuildError } from './errors.js';
import { checkDockerAvailable, execDocker, validateBuildArgs } from './exec.js';
import { resolveRegistry } from './registries/index.js';
import type {
  ContainerBuildOptions,
  ContainerBuildResult,
  RegistrySession,
} from './registries/types.js';

const logger = getComponentLogger('container-build');
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function resolvePlatforms(options: ContainerBuildOptions): readonly string[] {
  if (options.platform && options.platforms) {
    throw new ContainerBuildError(
      'Specify either platform or platforms, not both.',
      'INVALID_PLATFORM'
    );
  }
  const platforms = options.platforms
    ? [...new Set(options.platforms)]
    : options.platform
      ? [options.platform]
      : [];
  for (const platform of platforms) {
    if (!/^linux\/[a-z0-9_]+(?:\/[a-z0-9_]+)?$/.test(platform)) {
      throw new ContainerBuildError(
        `Invalid container platform: "${platform}".`,
        'INVALID_PLATFORM',
        ['Use an OCI platform such as linux/amd64 or linux/arm64.']
      );
    }
  }
  return platforms;
}

function repositoryFromTaggedUri(uri: string): string {
  const colon = uri.lastIndexOf(':');
  const slash = uri.lastIndexOf('/');
  return colon > slash ? uri.slice(0, colon) : uri;
}

function digestFromInspectOutput(output: string): string {
  const trimmed = output.trim();
  let candidate = trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') candidate = parsed;
  } catch {
    // Buildx versions may return an unquoted digest despite the JSON format request.
  }
  if (!DIGEST_PATTERN.test(candidate)) {
    throw ContainerBuildError.digestVerificationFailed(
      `expected sha256 manifest digest, received "${candidate.slice(0, 160)}"`
    );
  }
  return candidate;
}

async function verifyPublishedDigest(
  taggedImageUri: string,
  metadataPath: string,
  session: RegistrySession,
  builder: string | undefined,
  timeout: number,
  signal: AbortSignal | undefined
): Promise<string> {
  const inspected = await execDocker(
    [
      'buildx',
      'imagetools',
      'inspect',
      taggedImageUri,
      ...(builder ? ['--builder', builder] : []),
      '--format',
      '{{json .Manifest.Digest}}',
    ],
    {
      quiet: true,
      timeout,
      ...(session.environment ? { environment: session.environment } : {}),
      ...(signal ? { signal } : {}),
    }
  );
  const digest = digestFromInspectOutput(inspected.stdout);
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    const pushedDigest = metadata['containerimage.digest'];
    if (typeof pushedDigest === 'string' && pushedDigest !== digest) {
      throw ContainerBuildError.digestVerificationFailed(
        `BuildKit reported ${pushedDigest}, registry returned ${digest}`
      );
    }
  } catch (error) {
    if (error instanceof ContainerBuildError) throw error;
    logger.debug('Buildx metadata did not contain a comparable digest', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return digest;
}

async function inspectPublishedDigest(
  taggedImageUri: string,
  session: RegistrySession,
  builder: string | undefined,
  timeout: number,
  signal: AbortSignal | undefined
): Promise<string | undefined> {
  try {
    const inspected = await execDocker(
      [
        'buildx',
        'imagetools',
        'inspect',
        taggedImageUri,
        ...(builder ? ['--builder', builder] : []),
        '--format',
        '{{json .Manifest.Digest}}',
      ],
      {
        quiet: true,
        timeout,
        ...(session.environment ? { environment: session.environment } : {}),
        ...(signal ? { signal } : {}),
      }
    );
    return digestFromInspectOutput(inspected.stdout);
  } catch (error) {
    if (error instanceof ContainerBuildError && error.code === 'BUILD_CANCELLED') throw error;
    if (signal?.aborted) throw ContainerBuildError.cancelled();
    if (error instanceof ContainerBuildError && error.code === 'BUILD_TIMEOUT') throw error;
    if (error instanceof ContainerBuildError && error.code === 'DIGEST_VERIFICATION_FAILED') {
      throw error;
    }
    if (manifestWasPositivelyNotFound(error, taggedImageUri)) {
      logger.debug('Container tag is not available for adoption', { taggedImageUri });
      return undefined;
    }
    const cause = error instanceof Error ? error : new Error(String(error));
    throw ContainerBuildError.tagInspectionFailed(taggedImageUri, cause);
  }
}

function manifestWasPositivelyNotFound(error: unknown, taggedImageUri: string): boolean {
  if (!(error instanceof ContainerBuildError) || error.code !== 'DOCKER_COMMAND_FAILED') {
    return false;
  }
  const stderr = error.command?.stderr;
  if (typeof stderr !== 'string') return false;
  const target = taggedImageUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const knownAbsence = new RegExp(
    `^ERROR:\\s+${target}:\\s+(?:not found|manifest unknown(?::.*)?|manifest_unknown(?::.*)?|no such manifest(?::.*)?)\\s*$`,
    'i'
  );
  return stderr.split(/\r?\n/).some((line) => knownAbsence.test(line.trim()));
}

/** Build, publish, and registry-verify a container image. */
export async function buildContainer(
  options: ContainerBuildOptions
): Promise<ContainerBuildResult> {
  const startedAt = Date.now();
  const {
    context,
    dockerfile = 'Dockerfile',
    imageName,
    buildArgs,
    target,
    existingTagPolicy = 'replace',
    quiet = false,
    progress = 'auto',
    timeout = 300_000,
    signal,
    extraDockerArgs = [],
  } = options;
  const contextPath = resolve(context);
  if (!existsSync(contextPath)) {
    throw new ContainerBuildError(
      `Build context directory not found: ${contextPath}`,
      'INVALID_CONTEXT'
    );
  }
  const dockerfilePath = join(contextPath, dockerfile);
  if (!existsSync(dockerfilePath)) {
    throw new ContainerBuildError(`Dockerfile not found: ${dockerfilePath}`, 'INVALID_DOCKERFILE');
  }
  if (!/^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$/.test(imageName)) {
    throw new ContainerBuildError(`Invalid image name: "${imageName}".`, 'INVALID_IMAGE_NAME');
  }
  if (buildArgs) validateBuildArgs(buildArgs);
  if (existingTagPolicy !== 'replace' && existingTagPolicy !== 'adopt') {
    throw new ContainerBuildError(
      `Invalid existing tag policy: "${String(existingTagPolicy)}".`,
      'INVALID_TAG_POLICY',
      ['Use "replace" for mutable tags or "adopt" for immutable content-derived tags.']
    );
  }
  if (
    existingTagPolicy === 'adopt' &&
    (options.tag === undefined || options.tag === 'content-hash')
  ) {
    throw new ContainerBuildError(
      'Adopting an existing tag requires an explicit tag derived from the complete build input.',
      'UNSAFE_ADOPTION_TAG',
      [
        'Include the context, Dockerfile, build arguments, target, platforms, extra Docker arguments, and relevant filesystem metadata in the tag identity.',
        'Use existingTagPolicy: "replace" with TypeKro\'s built-in content-hash tag.',
      ]
    );
  }
  const platforms = resolvePlatforms(options);
  let tag = options.tag ?? 'latest';
  if (tag === 'content-hash') tag = await computeContentHash(contextPath, dockerfilePath);

  await checkDockerAvailable(signal);
  const registry = resolveRegistry(options.registry);
  const taggedImageUri = await registry.resolveImageUri(imageName, tag);
  logger.info('Resolving container artifact', {
    taggedImageUri,
    platforms: platforms.length ? platforms : ['native'],
  });

  const resources: { session?: RegistrySession; builder?: BuilderLifecycleState } = {};
  let buildResult: ContainerBuildResult | undefined;
  let buildFailure: ContainerBuildError | undefined;
  let cleanupFailure: ContainerBuildError | undefined;
  const metadataDirectory = await mkdtemp(join(tmpdir(), 'typekro-build-'));
  const metadataPath = join(metadataDirectory, 'metadata.json');
  const performBuild = async (): Promise<ContainerBuildResult> => {
    const session = bindRegistrySession(await registry.prepare(imageName, timeout, signal));
    resources.session = session;
    let builder: BuilderLifecycleState | undefined;
    if (!session.remote && platforms.length > 1) {
      throw new ContainerBuildError(
        'Multi-platform images must be published to a remote registry.',
        'MULTI_PLATFORM_REQUIRES_REGISTRY'
      );
    }
    const buildArgFlags = buildArgs
      ? Object.entries(buildArgs).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`])
      : [];
    const common = [
      '-t',
      taggedImageUri,
      '-f',
      dockerfilePath,
      ...(platforms.length ? ['--platform', platforms.join(',')] : []),
      ...(target ? ['--target', target] : []),
      ...buildArgFlags,
      ...extraDockerArgs,
      contextPath,
    ];
    if (session.remote) {
      if (session.buildkitConfigPath || platforms.length > 1) {
        if (extraDockerArgs.some((arg) => arg === '--builder' || arg.startsWith('--builder='))) {
          throw new ContainerBuildError(
            'A dedicated temporary builder cannot be overridden by extraDockerArgs.',
            'BUILDER_OVERRIDE_CONFLICT'
          );
        }
        builder = newBuilderLifecycle(`typekro-${randomUUID().slice(0, 12)}`);
        resources.builder = builder;
        await createTemporaryBuilder(builder, session, timeout, signal);
      }
      if (existingTagPolicy === 'adopt') {
        const digest = await inspectPublishedDigest(
          taggedImageUri,
          session,
          builder?.name,
          timeout,
          signal
        );
        if (digest) {
          const repository = repositoryFromTaggedUri(taggedImageUri);
          const imageUri = `${repository}@${digest}`;
          const duration = Date.now() - startedAt;
          logger.info('Existing container tag adopted', {
            imageUri,
            taggedImageUri,
            duration,
          });
          return {
            imageUri,
            taggedImageUri,
            repository,
            tag,
            digest,
            duration,
            pushed: true,
            platforms,
          };
        }
      }
      await execDocker(
        [
          'buildx',
          'build',
          ...(builder ? ['--builder', builder.name] : []),
          '--push',
          '--metadata-file',
          metadataPath,
          ...(quiet ? ['--quiet'] : ['--progress', progress]),
          ...common,
        ],
        {
          quiet,
          timeout,
          ...(session.environment ? { environment: session.environment } : {}),
          ...(signal ? { signal } : {}),
        }
      );
      const digest = await verifyPublishedDigest(
        taggedImageUri,
        metadataPath,
        session,
        builder?.name,
        timeout,
        signal
      );
      const repository = repositoryFromTaggedUri(taggedImageUri);
      const imageUri = `${repository}@${digest}`;
      const duration = Date.now() - startedAt;
      logger.info('Container build published', { imageUri, taggedImageUri, duration });
      return {
        imageUri,
        taggedImageUri,
        repository,
        tag,
        digest,
        duration,
        pushed: true,
        platforms,
      };
    }

    await execDocker(['build', ...common], {
      quiet,
      timeout,
      ...(signal ? { signal } : {}),
    });
    const duration = Date.now() - startedAt;
    return {
      imageUri: taggedImageUri,
      taggedImageUri,
      repository: repositoryFromTaggedUri(taggedImageUri),
      tag,
      duration,
      pushed: false,
      platforms,
    };
  };
  try {
    buildResult = await performBuild();
  } catch (error) {
    if (error instanceof ContainerBuildError) {
      buildFailure = Object.isExtensible(error)
        ? error
        : new ContainerBuildError(
            error.message,
            error.code,
            [...error.suggestions],
            error,
            error.command
          );
    } else {
      buildFailure = new ContainerBuildError(
        'Container build failed.',
        'BUILD_FAILED',
        [],
        error instanceof Error ? error : undefined
      );
    }
  } finally {
    const { builder, session } = resources;
    if (builder && session) await removeTemporaryBuilder(builder, session, timeout);
    let registrySession: 'not-returned' | 'completed' | 'uncertain' = 'not-returned';
    if (session) {
      try {
        await session.cleanup();
        registrySession = 'completed';
      } catch {
        registrySession = 'uncertain';
      }
    }
    let metadataFiles: 'completed' | 'uncertain' = 'completed';
    try {
      await rm(metadataDirectory, { recursive: true, force: true });
    } catch {
      metadataFiles = 'uncertain';
    }
    const cleanup = Object.freeze({
      ...(builder ? { builder: snapshotBuilder(builder) } : {}),
      registrySession,
      metadataFiles,
    });
    if (buildResult) buildResult.cleanup = cleanup;
    if (buildFailure) buildFailure.cleanup = cleanup;
    else if (registrySession === 'uncertain' || metadataFiles === 'uncertain') {
      // Keep raw cleanup diagnostics out of retained public results; preserve image success separately.
      const error = new ContainerBuildError(
        'Temporary build cleanup did not complete.',
        'CLEANUP_FAILED'
      );
      error.cleanup = cleanup;
      if (buildResult) error.buildResult = buildResult;
      cleanupFailure = error;
    }
  }
  if (buildFailure) throw buildFailure;
  if (cleanupFailure) throw cleanupFailure;
  if (!buildResult)
    throw new ContainerBuildError('Container build produced no result.', 'BUILD_FAILED');
  return buildResult;
}

/** Compute a deterministic build-context digest using only Node-compatible APIs. */
export async function computeContentHash(
  contextPath: string,
  dockerfilePath: string
): Promise<string> {
  const hasher = createHash('sha256');
  for await (const chunk of createReadStream(dockerfilePath)) hasher.update(chunk);

  const ignore = (await import('ignore')).default;
  const ignored = ignore().add(['.git', 'node_modules']);
  const dockerignorePath = join(contextPath, '.dockerignore');
  if (existsSync(dockerignorePath)) ignored.add(await readFile(dockerignorePath, 'utf8'));

  const files: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(join(contextPath, directory), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored.ignores(relativePath + (entry.isDirectory() ? '/' : ''))) continue;
      if (entry.isDirectory()) await walk(join(directory, entry.name), relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  };
  await walk('', '');
  files.sort();
  for (const file of files) {
    hasher.update(file);
    try {
      for await (const chunk of createReadStream(join(contextPath, file))) hasher.update(chunk);
    } catch (error) {
      throw new ContainerBuildError(
        `Build context file cannot be hashed: ${file}: ${error instanceof Error ? error.message : String(error)}`,
        'INVALID_CONTEXT',
        ['Make every included build-context file readable or exclude it through .dockerignore.'],
        error instanceof Error ? error : undefined
      );
    }
  }
  return `sha-${hasher.digest('hex').slice(0, 12)}`;
}
