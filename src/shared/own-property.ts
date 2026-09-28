/**
 * Own-property assignment for objects rebuilt from arbitrary keys.
 *
 * `target[key] = value` is not a plain write when `key` is `'__proto__'`: on
 * an ordinary object it runs the inherited prototype setter, so the key never
 * becomes a property and silently disappears from the rebuilt object. Data
 * whose keys come from a caller (a map of setting names, Helm values, labels)
 * can legitimately contain it, so every helper that copies such data key by
 * key assigns through {@link setOwnProperty}.
 *
 * Every other key is assigned exactly as before, so the rebuilt object keeps
 * its ordinary prototype and nothing else about it changes.
 */
export function setOwnProperty(target: object, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return;
  }
  (target as Record<string, unknown>)[key] = value;
}
