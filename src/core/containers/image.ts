/**
 * Container Image Utility
 *
 * `container()` declares a container image built from source and pushed to a registry. It is the
 * high-level front door over {@link buildContainer}: a memoized async builder that resolves to a
 * SHAPED result (`{ imageUri, repository, tag }`) so callers can use the full URI for a resource's
 * image field OR the split `repository`/`tag` for a Helm chart's image values — without re-splitting.
 *
 * An image build is an async, client-side, pre-deploy side effect, so `container()` is honest about
 * that: you `await` it. It is NOT a deferred reference — resolve images in (async) setup code before
 * composing, then feed the resulting literals into resources or chart values.
 *
 * Memoization: the build is keyed by the effective content, target, registry, and build options, so
 * awaiting the same container many times builds it once while a changed context or registry cannot
 * accidentally reuse a different image.
 *
 * @example
 * ```typescript
 * import { container } from 'typekro/containers';
 *
 * const img = await container({ context: './app', imageName: 'app', registry: { type: 'ecr' } });
 * // img.imageUri  → '123.dkr.ecr.us-east-1.amazonaws.com/app:sha-abc'
 * // img.repository → '123.dkr.ecr.us-east-1.amazonaws.com/app'   img.tag → 'sha-abc'
 *
 * Deployment({ name: 'app', image: img.imageUri, ports: [{ containerPort: 3000 }] });
 * // or for a Helm chart's split image values: { repository: img.repository, tag: img.tag }
 * ```
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildContainer, computeContentHash } from './build.js';
import { ContainerBuildError } from './errors.js';
import type { ContainerBuildOptions, ContainerBuildResult } from './registries/types.js';

/** A built container image, resolved to a literal — both the full URI and its split parts. */
export interface ContainerImage {
  /** Immutable digest URI for remote images, or the local tagged URI. */
  readonly imageUri: string;
  /** Human-readable tagged URI retained for inspection and retention policy. */
  readonly taggedImageUri: string;
  readonly repository: string;
  readonly tag: string;
  /** Registry-verified digest. Omitted for local, non-pushed images. */
  readonly digest?: string;
  readonly platforms: readonly string[];
}

/** Options for {@link container}: the {@link ContainerBuildOptions} plus an optional diagnostic identity. */
export interface ContainerOptions extends ContainerBuildOptions {
  /** Stable diagnostic identity included in, but never substituted for, the complete cache key. */
  id?: string;
}

/**
 * Split a full image URI into `{ repository, tag }`. Handles digest form (`repo@sha256:…`) and tag
 * form (`repo:tag`), registry-port-colon aware (a colon in `host:port/...` is not the tag separator).
 */
export function splitImageUri(uri: string): { repository: string; tag: string } {
  const at = uri.lastIndexOf('@');
  if (at !== -1) return { repository: uri.slice(0, at), tag: uri.slice(at + 1) };
  const colon = uri.lastIndexOf(':');
  const slash = uri.lastIndexOf('/');
  return colon > slash
    ? { repository: uri.slice(0, colon), tag: uri.slice(colon + 1) }
    : { repository: uri, tag: 'latest' };
}

/** Build memoization, keyed by effective content/options — builds each exact image once. */
const buildCache = new Map<string, Promise<ContainerImage>>();
const objectIdentities = new WeakMap<object, number>();
let nextObjectIdentity = 1;

/** Test seam: the builder `container()` delegates to (defaults to the real {@link buildContainer}). */
type Builder = (options: ContainerBuildOptions) => Promise<ContainerBuildResult>;

async function buildAndShape(options: ContainerOptions, build: Builder): Promise<ContainerImage> {
  const { id: _id, ...buildOptions } = options;
  const result = await build({ ...buildOptions, tag: buildOptions.tag ?? 'content-hash' });
  return {
    imageUri: result.imageUri,
    taggedImageUri: result.taggedImageUri,
    repository: result.repository,
    tag: result.tag,
    ...(result.digest ? { digest: result.digest } : {}),
    platforms: result.platforms,
  };
}

function objectIdentity(value: object | undefined): number | undefined {
  if (!value) return undefined;
  let identity = objectIdentities.get(value);
  if (!identity) {
    identity = nextObjectIdentity++;
    objectIdentities.set(value, identity);
  }
  return identity;
}

function sortedRecord(
  value: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> | undefined {
  return value
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : undefined;
}

function registryIdentity(registry: ContainerBuildOptions['registry']): object {
  switch (registry.type) {
    case 'oci':
      return {
        type: registry.type,
        registry: registry.registry,
        repositoryPrefix: registry.repositoryPrefix,
        dockerConfigPath: registry.dockerConfigPath,
        tls: registry.tls,
        credentialProvider: objectIdentity(registry.credentialProvider),
      };
    case 'ecr':
      return {
        type: registry.type,
        accountId: registry.accountId,
        region: registry.region,
        createRepository: registry.createRepository,
        credentials: objectIdentity(registry.credentials),
      };
    case 'custom':
      return { type: registry.type, handler: objectIdentity(registry.handler) };
    default:
      return registry;
  }
}

async function resolvedBuildOptions(
  options: ContainerOptions,
  build: Builder
): Promise<ContainerOptions> {
  const context = resolve(options.context);
  const dockerfile = options.dockerfile ?? 'Dockerfile';
  if (
    build === buildContainer &&
    options.existingTagPolicy === 'adopt' &&
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
  let tag = options.tag ?? 'content-hash';
  if (
    tag === 'content-hash' &&
    build === buildContainer &&
    existsSync(context) &&
    existsSync(join(context, dockerfile))
  ) {
    tag = await computeContentHash(context, join(context, dockerfile));
  }
  return { ...options, context, dockerfile, tag };
}

function buildCacheKey(options: ContainerOptions, build: Builder): string {
  const identity = {
    id: options.id,
    context: options.context,
    dockerfile: options.dockerfile,
    imageName: options.imageName,
    tag: options.tag,
    existingTagPolicy: options.existingTagPolicy,
    platform: options.platform,
    platforms: options.platforms ? [...options.platforms] : undefined,
    buildArgs: sortedRecord(options.buildArgs),
    target: options.target,
    timeout: options.timeout,
    signal: objectIdentity(options.signal),
    extraDockerArgs: options.extraDockerArgs ? [...options.extraDockerArgs] : undefined,
    registry: registryIdentity(options.registry),
    builder: objectIdentity(build),
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/**
 * Build a container image (delegating to {@link buildContainer}) and resolve to its shaped result.
 * Memoized by identity — see the module doc. `build` is an injectable test seam; production callers
 * pass only `options`.
 */
export function container(
  options: ContainerOptions,
  build: Builder = buildContainer
): Promise<ContainerImage> {
  return resolvedBuildOptions(options, build).then((resolved) => {
    const key = buildCacheKey(resolved, build);
    let pending = buildCache.get(key);
    if (!pending) {
      pending = buildAndShape(resolved, build);
      buildCache.set(key, pending);
      pending.catch(() => {
        if (buildCache.get(key) === pending) buildCache.delete(key);
      });
    }
    return pending;
  });
}

/** Clear the build memoization cache. Intended for tests/long-lived processes that need a rebuild. */
export function clearContainerCache(): void {
  buildCache.clear();
}
