/**
 * `Middleware` spec validation.
 *
 * A Traefik `Middleware` configures exactly one behavior. Two keys in one
 * object is not a merge — Traefik picks one and silently drops the other — so
 * this is a real misconfiguration worth rejecting.
 *
 * The type system already makes it a compile error (see
 * `TraefikMiddlewareSpec`), but the same rule is re-checked at runtime for
 * JavaScript callers and for specs assembled dynamically.
 *
 * **Why this check is safe outside a status builder:** it only inspects which
 * KEYS a spec object carries, never their values. Keys are always written by
 * the author and are concrete in both direct and KRO mode, so this never
 * inspects a schema proxy. Value-level validation, which would have to reason
 * about refs, is deliberately absent.
 */

import { TypeKroError } from '../../../core/errors.js';
import { TRAEFIK_MIDDLEWARE_KINDS } from '../constants.js';

const MIDDLEWARE_KIND_SET: ReadonlySet<string> = new Set(TRAEFIK_MIDDLEWARE_KINDS);

/** The middleware keys a spec object carries, in declaration order. */
export function traefikMiddlewareKeys(spec: unknown): readonly string[] {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return [];
  return Object.entries(spec)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

/**
 * Validate a `Middleware` spec, returning one human-readable issue per problem
 * and an empty array when the spec is well formed.
 *
 * @param spec - The candidate `Middleware.spec`. Accepts `unknown` so callers
 *   can validate dynamically assembled objects without a type assertion.
 *
 * @example
 * ```typescript
 * validateTraefikMiddlewareSpec({ forwardAuth: { address: 'http://authz' } }); // []
 * validateTraefikMiddlewareSpec({}); // ['Traefik Middleware spec is empty. ...']
 * ```
 */
export function validateTraefikMiddlewareSpec(spec: unknown): readonly string[] {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return ['Traefik Middleware spec must be an object with exactly one middleware key.'];
  }

  const keys = traefikMiddlewareKeys(spec);
  const issues: string[] = [];
  const unknownKeys = keys.filter((key) => !MIDDLEWARE_KIND_SET.has(key));
  const knownKeys = keys.filter((key) => MIDDLEWARE_KIND_SET.has(key));

  if (keys.length === 0) {
    issues.push(
      `Traefik Middleware spec is empty. Set exactly one of: ${TRAEFIK_MIDDLEWARE_KINDS.join(', ')}.`
    );
  }
  if (knownKeys.length > 1) {
    issues.push(
      `Traefik Middleware spec sets ${knownKeys.length} middlewares (${knownKeys.join(', ')}). ` +
        'A Middleware configures exactly one behavior — Traefik would apply only one of these. ' +
        'Create one Middleware per behavior and compose them with a `chain` middleware or the ' +
        "route's `middlewares` list."
    );
  }
  if (unknownKeys.length > 0) {
    issues.push(
      `Traefik Middleware spec has unknown key(s): ${unknownKeys.join(', ')}. ` +
        `Supported middlewares are: ${TRAEFIK_MIDDLEWARE_KINDS.join(', ')}.`
    );
  }

  return issues;
}

/**
 * Throw when a `Middleware` spec does not configure exactly one middleware.
 *
 * @param spec - The candidate `Middleware.spec`.
 * @param name - Resource name, included in the error context.
 * @throws {TypeKroError} With code `TRAEFIK_MIDDLEWARE_INVALID_SPEC`.
 */
export function assertTraefikMiddlewareSpec(spec: unknown, name: string): void {
  const issues = validateTraefikMiddlewareSpec(spec);
  if (issues.length === 0) return;
  throw new TypeKroError(
    `Invalid Traefik Middleware "${name}": ${issues.join(' ')}`,
    'TRAEFIK_MIDDLEWARE_INVALID_SPEC',
    { name, issues, keys: traefikMiddlewareKeys(spec) }
  );
}
