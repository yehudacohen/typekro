/**
 * Container Build Utility
 *
 * Builds a Docker image from a Dockerfile and optionally pushes it to a
 * container registry. Returns the full image URI for use in K8s deployments.
 *
 * @example
 * ```typescript
 * import { buildContainer } from 'typekro/containers';
 *
 * // Local Orbstack (no push needed)
 * const result = await buildContainer({
 *   context: './apps/my-app',
 *   imageName: 'my-app',
 *   registry: { type: 'orbstack' },
 * });
 *
 * // AWS ECR (auto-creates repo, pushes)
 * const result = await buildContainer({
 *   context: './apps/my-app',
 *   imageName: 'my-app',
 *   tag: 'content-hash',
 *   platform: 'linux/amd64',
 *   registry: { type: 'ecr', region: 'us-west-2' },
 * });
 *
 * // Use the image URI in a TypeKro composition
 * await factory.deploy({
 *   app: { image: result.imageUri, port: 3000 },
 * });
 * ```
 */

import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getComponentLogger } from '../logging/index.js';
import { ContainerBuildError } from './errors.js';
import { checkDockerAvailable, execDocker, validateBuildArgs } from './exec.js';
import { resolveRegistry } from './registries/index.js';
import type { ContainerBuildOptions, ContainerBuildResult } from './registries/types.js';

const logger = getComponentLogger('container-build');

/**
 * Build a Docker image and optionally push it to a container registry.
 *
 * Docker's own layer cache handles memoization — if nothing in the build
 * context changed, the build returns near-instantly.
 */
export async function buildContainer(options: ContainerBuildOptions): Promise<ContainerBuildResult> {
  const startTime = Date.now();
  const {
    context,
    dockerfile = 'Dockerfile',
    imageName,
    platform,
    buildArgs,
    target,
    quiet = false,
    timeout = 300_000,
    extraDockerArgs = [],
    registry: registryConfig,
  } = options;

  // Validate inputs
  const contextPath = resolve(context);
  if (!existsSync(contextPath)) {
    throw new ContainerBuildError(
      `Build context directory not found: ${contextPath}`,
      'INVALID_CONTEXT',
      ['Check the context path is correct.', `Directory: ${contextPath}`]
    );
  }

  const dockerfilePath = join(contextPath, dockerfile);
  if (!existsSync(dockerfilePath)) {
    throw new ContainerBuildError(
      `Dockerfile not found: ${dockerfilePath}`,
      'INVALID_DOCKERFILE',
      [`Expected Dockerfile at: ${dockerfilePath}`, 'Set the dockerfile option if using a non-default name.']
    );
  }

  // Validate image name — must be a valid Docker/OCI image reference.
  // Must start and end with alphanumeric, no trailing dots/slashes/hyphens.
  if (!/^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$/.test(imageName)) {
    throw new ContainerBuildError(
      `Invalid image name: "${imageName}". Must be lowercase alphanumeric, may contain dots/hyphens/underscores/slashes, must not start or end with a separator.`,
      'INVALID_IMAGE_NAME',
      ['Image names must match: /^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$/']
    );
  }

  if (buildArgs) {
    validateBuildArgs(buildArgs);
  }

  // Resolve tag
  let tag = options.tag ?? 'latest';
  if (tag === 'content-hash') {
    tag = await computeContentHash(contextPath, dockerfilePath);
  }

  logger.info('Building container image', { imageName, tag, context: contextPath, registry: registryConfig.type });

  // Check Docker availability
  await checkDockerAvailable();

  // Resolve registry handler
  const registry = resolveRegistry(registryConfig);

  // Resolve full image URI
  const imageUri = await registry.resolveImageUri(imageName, tag);

  // Authenticate with registry (no-op for local registries)
  await registry.authenticate();

  // Build the image
  const buildArgFlags = buildArgs
    ? Object.entries(buildArgs).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`])
    : [];

  const dockerBuildArgs = [
    'build',
    '-t', imageUri,
    '-f', dockerfilePath,
    ...(platform ? ['--platform', platform] : []),
    ...(target ? ['--target', target] : []),
    ...buildArgFlags,
    ...extraDockerArgs,
    contextPath,
  ];

  await execDocker(dockerBuildArgs, { quiet, timeout });

  // Push to registry — handler returns whether it actually pushed
  const pushed = await registry.push(imageUri, imageName);

  const duration = Date.now() - startTime;
  logger.info('Container build complete', { imageUri, tag, duration, pushed });

  return { imageUri, tag, duration, pushed };
}

/**
 * Compute a content-based hash of the build context for deterministic tagging.
 * Exported for direct unit testing without Docker.
 *
 * Hashes the Dockerfile content plus all file contents in the context,
 * respecting .dockerignore if present. Files are streamed (not loaded into
 * memory) and hashed in sorted order for determinism.
 */
export async function computeContentHash(contextPath: string, dockerfilePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');

  // Hash the Dockerfile content (streamed for memory efficiency)
  for await (const chunk of Bun.file(dockerfilePath).stream()) {
    hasher.update(chunk);
  }

  // Parse .dockerignore if present — same format as .gitignore
  const ignore = (await import('ignore')).default;
  const ig = ignore();
  // Always exclude .git and node_modules (Docker does this implicitly)
  ig.add(['.git', 'node_modules']);
  const dockerignorePath = join(contextPath, '.dockerignore');
  if (existsSync(dockerignorePath)) {
    const patterns = await Bun.file(dockerignorePath).text();
    ig.add(patterns);
  }

  // Collect files, excluding .dockerignore matches
  const glob = new Bun.Glob('**/*');
  const files: string[] = [];
  for await (const path of glob.scan({ cwd: contextPath, onlyFiles: true })) {
    if (ig.ignores(path)) continue;
    files.push(path);
  }
  files.sort();

  for (const file of files) {
    // Hash the file path (so renames change the hash)
    hasher.update(file);
    // Stream file contents through the hasher (binary-safe, memory-efficient)
    const stream = Bun.file(join(contextPath, file)).stream();
    for await (const chunk of stream) {
      hasher.update(chunk);
    }
  }

  const hash = hasher.digest('hex');
  return `sha-${hash.slice(0, 12)}`;
}
