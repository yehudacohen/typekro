/**
 * Independent per-leaf resolution for direct-mode status objects.
 *
 * Direct mode used to hand the whole computed status object to
 * `ReferenceResolver.resolveReferences()` in a single call. That traversal has
 * no per-leaf error boundary, so a single failing leaf — most commonly a CEL
 * expression that touches an optional nested field before the controller has
 * populated it (`service.status.loadBalancer.ingress` on a fresh Service) —
 * unwound the entire traversal. The caller then fell back to the *unresolved*
 * builder output, so `ready`, `failed` and `phase` reported nothing even though
 * they were perfectly resolvable.
 *
 * This module walks the status object itself and resolves each leaf on its own.
 * A leaf that fails is recorded as a {@link StatusLeafDiagnostic} carrying that
 * leaf's path and error, and its siblings — and sibling subtrees — keep their
 * resolved values.
 *
 * The diagnostics are both returned and attached to the status object as a
 * non-enumerable property, following the same convention the serializer uses
 * for `__nestedStatusCel`: observable by tooling, invisible to JSON/YAML
 * emission and to `Object.keys()`.
 */

import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { ensureError } from '../errors.js';

/** Non-enumerable property carrying per-leaf status resolution diagnostics. */
const STATUS_LEAF_DIAGNOSTICS = '__statusLeafDiagnostics';

/**
 * A single status leaf that could not be resolved in direct mode.
 *
 * `path` is the leaf's location inside the status object (`phase`,
 * `components.gateway.address`, `addresses[0]`), which is what an author needs
 * to find the offending status field.
 */
export interface StatusLeafDiagnostic {
  /** Dotted/bracketed path of the leaf inside the status object. */
  readonly path: string;
  /** The CEL expression or reference path that failed, when one is available. */
  readonly expression?: string;
  /** Human-readable failure message. */
  readonly message: string;
  /** The underlying error. */
  readonly error: Error;
}

/** Result of resolving a status object leaf by leaf. */
export interface StatusLeafResolutionResult<T> {
  /** The status object, resolved in place, with failing leaves left `undefined`. */
  readonly status: T;
  /** One entry per leaf that failed to resolve. Empty when everything resolved. */
  readonly diagnostics: readonly StatusLeafDiagnostic[];
}

/** Resolves one status leaf. Rejects when that leaf cannot be resolved. */
export type StatusLeafResolver = (leaf: unknown, path: string) => Promise<unknown>;

/**
 * True when a value is a status *leaf* — something that has to be resolved as a
 * unit rather than walked into.
 */
function isStatusLeaf(value: unknown): boolean {
  if (isKubernetesRef(value) || isCelExpression(value)) return true;
  return typeof value === 'string' && value.includes('__KUBERNETES_REF_');
}

/**
 * True when a value is a container the walker should descend into.
 *
 * Only arrays and plain objects are walked. Anything else with an unusual
 * prototype is treated as an opaque value and left alone, so the walker never
 * mutates a class instance it does not own.
 */
function isWalkableContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Describe a leaf for the diagnostic, without dumping an entire object graph. */
function describeLeaf(leaf: unknown): string | undefined {
  if (isCelExpression(leaf)) return leaf.expression;
  if (isKubernetesRef(leaf)) {
    return leaf.fieldPath ? `${leaf.resourceId}.${leaf.fieldPath}` : leaf.resourceId;
  }
  if (typeof leaf === 'string') return leaf;
  return undefined;
}

function childPath(parentPath: string, key: string): string {
  return parentPath === '' ? key : `${parentPath}.${key}`;
}

function indexPath(parentPath: string, index: number): string {
  return `${parentPath}[${index}]`;
}

/**
 * Resolve every leaf of a status object independently.
 *
 * Containers are mutated in place so that non-enumerable metadata attached to
 * the status object (for example `__nestedStatusCel`) survives resolution.
 * Keys prefixed with `__` are TypeKro-internal and are never resolved.
 *
 * @param status The computed status object, whose leaves are CEL expressions,
 *   `KubernetesRef`s, reference-marker strings, or plain values.
 * @param resolveLeaf Resolves a single leaf. Any rejection is captured as that
 *   leaf's diagnostic; it never aborts sibling leaves.
 */
export async function resolveStatusLeavesIndependently<T>(
  status: T,
  resolveLeaf: StatusLeafResolver
): Promise<StatusLeafResolutionResult<T>> {
  const diagnostics: StatusLeafDiagnostic[] = [];
  const visited = new WeakSet<object>();

  async function resolveAt(value: unknown, path: string): Promise<unknown> {
    if (isStatusLeaf(value)) {
      try {
        return await resolveLeaf(value, path);
      } catch (error: unknown) {
        const cause = ensureError(error);
        const expression = describeLeaf(value);
        diagnostics.push({
          path,
          ...(expression === undefined ? {} : { expression }),
          message: `Status field '${path}' could not be resolved: ${cause.message}`,
          error: cause,
        });
        // The failing leaf resolves to nothing. Its siblings are untouched.
        return undefined;
      }
    }

    if (!isWalkableContainer(value)) return value;

    // Guard against cycles: a self-referential status object must not loop.
    if (visited.has(value)) return value;
    visited.add(value);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        value[index] = await resolveAt(value[index], indexPath(path, index));
      }
      return value;
    }

    for (const key of Object.keys(value)) {
      // TypeKro-internal metadata (for example __nestedStatusCel) is not a
      // status field and must not be resolved or reported.
      if (key.startsWith('__')) continue;
      value[key] = await resolveAt(value[key], childPath(path, key));
    }
    return value;
  }

  const resolved = (await resolveAt(status, '')) as T;
  attachStatusLeafDiagnostics(resolved, diagnostics);
  return { status: resolved, diagnostics };
}

/**
 * Attach per-leaf diagnostics to a status object as a non-enumerable property.
 *
 * Non-enumerable so the diagnostics never leak into emitted YAML, JSON, or
 * `Object.keys()` of the user-visible status.
 */
export function attachStatusLeafDiagnostics(
  status: unknown,
  diagnostics: readonly StatusLeafDiagnostic[]
): void {
  if (status === null || typeof status !== 'object') return;
  Object.defineProperty(status, STATUS_LEAF_DIAGNOSTICS, {
    value: diagnostics,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * Read the per-leaf status diagnostics recorded during direct-mode resolution.
 *
 * Returns an empty array when the status resolved cleanly or was produced by a
 * path that does not record diagnostics (Kro mode).
 */
export function getStatusLeafDiagnostics(status: unknown): readonly StatusLeafDiagnostic[] {
  if (status === null || typeof status !== 'object') return [];
  const descriptor = Object.getOwnPropertyDescriptor(status, STATUS_LEAF_DIAGNOSTICS);
  return Array.isArray(descriptor?.value) ? (descriptor.value as StatusLeafDiagnostic[]) : [];
}
