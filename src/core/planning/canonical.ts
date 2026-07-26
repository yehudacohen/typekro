import { createHash } from 'node:crypto';

import { TypeKroError } from '../errors.js';

/** Error raised when a value cannot participate in a canonical plan encoding. */
export class CanonicalizationError extends TypeKroError {
  constructor(message: string, path: string) {
    super(message, 'PLAN_CANONICALIZATION_FAILED', { path });
    this.name = 'CanonicalizationError';
  }
}

function canonicalize(value: unknown, path: string, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(`Non-finite number at ${path}`, path);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'undefined') {
    throw new CanonicalizationError(`Undefined is not canonical at ${path}`, path);
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new CanonicalizationError(`Unsupported ${typeof value} at ${path}`, path);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new CanonicalizationError(`Circular array at ${path}`, path);
    seen.add(value);
    const result = value.map((item, index) => canonicalize(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new CanonicalizationError(`Circular object at ${path}`, path);
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(
        Reflect.get(value, key),
        path === '$' ? `$.${key}` : `${path}.${key}`,
        seen
      );
    }
    seen.delete(value);
    return result;
  }
  throw new CanonicalizationError(`Unsupported value at ${path}`, path);
}

/** Serialize JSON-compatible data with recursively sorted object keys. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, '$', new WeakSet<object>()));
}

/** SHA-256 digest of the canonical UTF-8 representation. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}
