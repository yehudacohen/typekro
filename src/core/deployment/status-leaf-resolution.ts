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
 *
 * ## The input is a template, not a workspace
 *
 * The status object handed in is the composition's *status template*: the object
 * holding the `KubernetesRef`s and CEL expressions the composition declared. One
 * template is built per composition and then read again on every reconcile and
 * for every instance. Resolving into it in place would overwrite those refs with
 * the values of one reconcile, so the next resolution would find concrete values
 * where it expected expressions — and report an unchanging snapshot of whatever
 * the first instance happened to see.
 *
 * So resolution never writes into the input. Every container is copied and the
 * resolved values go into the copy. The copy is made descriptor by descriptor
 * over `Reflect.ownKeys`, so non-enumerable metadata (`__nestedStatusCel`,
 * `__statusLeafDiagnostics`), symbol keys, and prototype-less objects — all of
 * which the serializer depends on — come through exactly as they were.
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
  /**
   * A **copy** of the status template carrying the resolved values, with failing
   * leaves left `undefined`. The template passed in is never written to.
   */
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
 * Copy one container, shallowly, keeping everything about it except identity.
 *
 * Descriptors are copied rather than values so the copy keeps what a plain
 * spread would drop and the serializer would then miss:
 *
 * - **Non-enumerable metadata.** `__nestedStatusCel` is attached with
 *   `Object.defineProperty(..., { enumerable: false })` on the Kro path, and the
 *   deployment strategy reads it back off the status object after resolution.
 * - **Symbol keys**, including the brands TypeKro marks values with.
 * - **The prototype**, so an `Object.create(null)` status map stays
 *   prototype-less — the serializer builds those deliberately, to keep a status
 *   field named `constructor` or `toString` from colliding with `Object`.
 *
 * The copy is shallow: nested containers are copied by the walker as it reaches
 * them, and leaves are never copied at all — a `KubernetesRef` or CEL expression
 * is opaque, handed to the resolver as-is and replaced in the copy by whatever
 * the resolver returns.
 */
function copyContainer<T extends Record<string, unknown> | unknown[]>(value: T): T {
  const copy: Record<string | symbol, unknown> | unknown[] = Array.isArray(value)
    ? []
    : (Object.create(Object.getPrototypeOf(value)) as Record<string | symbol, unknown>);

  for (const key of Reflect.ownKeys(value)) {
    // An array's own `length` is maintained by the index writes below; defining
    // it from the source descriptor would fight them.
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined) Object.defineProperty(copy, key, descriptor);
  }
  if (Array.isArray(value) && Array.isArray(copy)) copy.length = value.length;

  return copy as T;
}

/** True when a string key is TypeKro-internal metadata rather than a status field. */
function isInternalKey(key: string): boolean {
  return key.startsWith('__');
}

/**
 * Resolve every leaf of a status object independently, into a fresh structure.
 *
 * The status template passed in is **not** modified: every container is copied
 * and the resolved values are written into the copy, so the same template can be
 * resolved again — for the next reconcile, or for another instance — and see the
 * refs and CEL expressions it was built with. Non-enumerable metadata (for
 * example `__nestedStatusCel`), symbol keys and prototype-less objects are
 * carried across by {@link copyContainer}.
 *
 * Keys prefixed with `__` are TypeKro-internal: they are copied across but never
 * resolved and never reported.
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
  // Original container -> its copy. Doubles as the cycle guard: a container
  // reached a second time yields the copy already made for it, so a cyclic
  // template produces a cyclic *copy* rather than looping or leaking a
  // reference back into the input.
  const copies = new WeakMap<object, unknown>();

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

    // Anything that is not a walkable container is opaque: shared by reference
    // with the template, exactly as it was before, and never written to.
    if (!isWalkableContainer(value)) return value;

    if (copies.has(value)) return copies.get(value);

    const copy = copyContainer(value);
    copies.set(value, copy);

    if (Array.isArray(value) && Array.isArray(copy)) {
      for (let index = 0; index < value.length; index += 1) {
        copy[index] = await resolveAt(value[index], indexPath(path, index));
      }
      return copy;
    }

    for (const key of Object.keys(value)) {
      // TypeKro-internal metadata (for example __nestedStatusCel) is not a
      // status field: copyContainer has already carried it across untouched,
      // and it must not be resolved or reported.
      if (isInternalKey(key)) continue;
      const resolvedChild = await resolveAt(
        (value as Record<string, unknown>)[key],
        childPath(path, key)
      );
      // defineProperty rather than assignment: the template may declare a status
      // field as a getter or as read-only, and the resolved copy has to hold a
      // plain value either way.
      Object.defineProperty(copy, key, {
        value: resolvedChild,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
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
