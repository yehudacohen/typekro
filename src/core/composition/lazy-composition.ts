/**
 * Lazy Composition Wrapper
 *
 * `kubernetesComposition(...)` executes eagerly: calling it runs the
 * composition function, builds the ResourceGraphDefinition, and runs the full
 * CEL analysis/optimization (serialization) pipeline — emitting
 * `resource-graph-serialization` log lines. That eager contract is correct for
 * direct callers (and is relied upon by tests), but it is a performance/hygiene
 * problem for the BUILT-IN FACTORY CATALOG.
 *
 * The factory barrel (`src/factories/index.ts`) re-exports every built-in
 * factory. Each factory module declares its composition at module scope
 * (`export const xBootstrap = kubernetesComposition(...)`). Because of the
 * barrel, importing ANY factory — or the top-level `typekro` entry — eagerly
 * imports and therefore SERIALIZES the entire catalog (apisix, ory, cilium,
 * cert-manager, external-dns, pebble, ...), even when the consumer only
 * instantiates one. None of those graphs are deployed; the work is pure wasted
 * CPU and log noise at converge time. (`ory-identity-stack` was observed
 * serializing 60+ times.)
 *
 * {@link lazyComposition} defers a single composition's construction behind a
 * memoized thunk. The returned value is a `CallableComposition`-shaped Proxy
 * that builds the real composition on first use — the first time any property
 * is read, the composition is invoked as a function, enumerated, or described.
 * A factory that is imported but never used is therefore never serialized,
 * while a factory that IS used materializes on first touch and behaves
 * identically to an eagerly-constructed one (same eager-execution semantics,
 * same logs, same public surface: `.factory(...)`, `.toYaml(...)`,
 * `.resources`, `.status`, resource access, callable-with-spec).
 */

import type { CallableComposition } from '../types/deployment.js';
import type { KroCompatibleType } from '../types/serialization.js';

/**
 * Wrap a composition factory thunk so the underlying composition is only
 * built (and serialized) on first use.
 *
 * @param build - A thunk that constructs and returns the real composition,
 *   typically `() => kubernetesComposition(definition, fn, options)`.
 * @returns A `CallableComposition` proxy that materializes `build()` lazily and
 *   memoizes the result. All property reads, calls, enumeration, and
 *   descriptor lookups transparently forward to the materialized composition.
 */
export function lazyComposition<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(build: () => CallableComposition<TSpec, TStatus>): CallableComposition<TSpec, TStatus> {
  let built: CallableComposition<TSpec, TStatus> | undefined;
  const materialize = (): CallableComposition<TSpec, TStatus> => {
    if (!built) {
      built = build();
    }
    return built;
  };

  // The proxy target is a function so the result is callable (compositions can
  // be invoked with a spec). The target itself is never used — every trap
  // forwards to the materialized composition.
  const target = (() => undefined) as unknown as CallableComposition<TSpec, TStatus>;

  return new Proxy(target, {
    apply(_target, thisArg, argArray) {
      // Calling the composition with a spec is a "use" — materialize, then
      // invoke the real callable.
      return Reflect.apply(
        materialize() as unknown as (...args: unknown[]) => unknown,
        thisArg,
        argArray
      );
    },
    get(_target, prop, _receiver) {
      const real = materialize() as unknown as object;
      // Forward to the real composition. Use the real composition as the
      // receiver so getters and `this`-dependent accessors resolve correctly.
      return Reflect.get(real, prop, real);
    },
    has(_target, prop) {
      return Reflect.has(materialize() as unknown as object, prop);
    },
    ownKeys(_target) {
      return Reflect.ownKeys(materialize() as unknown as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        materialize() as unknown as object,
        prop
      );
      // Proxy invariant: a non-configurable descriptor may only be reported for
      // a key that is a non-configurable own property of the TARGET. The target
      // (an empty stub function) has none of the composition's keys, and the
      // real composition defines several keys as `configurable: false` (e.g.
      // the callable-composition brand, `status`). Force `configurable: true`
      // so this transparent forwarding proxy never violates the invariant. The
      // forwarded value is unchanged — only the descriptor's configurability
      // flag is relaxed, which is purely a reflection detail.
      if (descriptor) {
        descriptor.configurable = true;
      }
      return descriptor;
    },
    getPrototypeOf(_target) {
      return Reflect.getPrototypeOf(materialize() as unknown as object);
    },
    set(_target, prop, value, _receiver) {
      const real = materialize() as unknown as object;
      return Reflect.set(real, prop, value, real);
    },
    defineProperty(_target, prop, descriptor) {
      return Reflect.defineProperty(materialize() as unknown as object, prop, descriptor);
    },
    deleteProperty(_target, prop) {
      return Reflect.deleteProperty(materialize() as unknown as object, prop);
    },
  });
}
