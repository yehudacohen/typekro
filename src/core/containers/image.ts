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
 * Memoization: the build is keyed by container identity (`id ?? imageName`) and cached, so awaiting
 * the same container many times (e.g. several deployments sharing one image) builds it exactly ONCE.
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

import { buildContainer } from './build.js';
import type { ContainerBuildOptions, ContainerBuildResult } from './registries/types.js';

/** A built container image, resolved to a literal — both the full URI and its split parts. */
export interface ContainerImage {
  /** Full image URI, e.g. `123.dkr.ecr.us-east-1.amazonaws.com/app:sha-abc`. */
  readonly imageUri: string;
  /** The URI without the tag, e.g. `123.dkr.ecr.us-east-1.amazonaws.com/app`. */
  readonly repository: string;
  /** The tag, e.g. `sha-abc`. */
  readonly tag: string;
}

/** Options for {@link container}: the {@link ContainerBuildOptions} plus an optional stable identity. */
export interface ContainerOptions extends ContainerBuildOptions {
  /** Stable identity for build memoization; defaults to `imageName`. Set when two containers share one. */
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

/** Build memoization, keyed by container identity (`id ?? imageName`) — builds each image once. */
const buildCache = new Map<string, Promise<ContainerImage>>();

/** Test seam: the builder `container()` delegates to (defaults to the real {@link buildContainer}). */
type Builder = (options: ContainerBuildOptions) => Promise<ContainerBuildResult>;

async function buildAndShape(options: ContainerOptions, build: Builder): Promise<ContainerImage> {
  const { id: _id, ...buildOptions } = options;
  const result = await build({ ...buildOptions, tag: buildOptions.tag ?? 'content-hash' });
  const { repository, tag } = splitImageUri(result.imageUri);
  return { imageUri: result.imageUri, repository, tag };
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
  const key = options.id ?? options.imageName;
  let pending = buildCache.get(key);
  if (!pending) {
    pending = buildAndShape(options, build);
    buildCache.set(key, pending);
  }
  return pending;
}

/** Clear the build memoization cache. Intended for tests/long-lived processes that need a rebuild. */
export function clearContainerCache(): void {
  buildCache.clear();
}
