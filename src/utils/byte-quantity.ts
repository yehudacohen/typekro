/**
 * Byte multiplier per Kubernetes quantity suffix.
 *
 * A `Map` rather than an object literal: the suffix is taken from caller
 * input, and an object lookup keyed on caller input reads `Object.prototype`
 * on a miss (`'constructor'`, `'__proto__'`). The pattern below already bounds
 * the suffix to this exact set, so the two guards are independent.
 */
const BYTE_SUFFIXES = new Map<string, number>([
  ['', 1],
  ['k', 1000],
  ['K', 1000],
  ['M', 1000 ** 2],
  ['G', 1000 ** 3],
  ['T', 1000 ** 4],
  ['Ki', 1024],
  ['Mi', 1024 ** 2],
  ['Gi', 1024 ** 3],
  ['Ti', 1024 ** 4],
]);

/**
 * The bytes in a Kubernetes-style byte quantity such as `'100Gi'`, `'50G'` or
 * `'1048576'`, rounded down, or `undefined` when the value is not one.
 * Callers apply their own bounds and error messages.
 */
export function byteQuantityBytes(value: string): number | undefined {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(|k|K|M|G|T|Ki|Mi|Gi|Ti)$/.exec(value.trim());
  const digits = match?.[1];
  const suffix = match?.[2];
  if (digits === undefined || suffix === undefined) return undefined;
  const bytes = Math.floor(Number(digits) * (BYTE_SUFFIXES.get(suffix) ?? 1));
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}
