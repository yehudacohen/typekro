/**
 * Helpers for reading ArkType's JSON AST.
 *
 * ArkType serializes a constraint two different ways depending on whether it
 * carries metadata. Declared plainly it is its own value (`maxLength: 46`);
 * declared with a custom error message — anything configured through
 * `.configure({ message })` — it becomes `{ rule: 46, meta: { message } }`
 * instead. Every consumer that reads the AST has to account for both, or a
 * schema that explains its limit to the caller quietly stops carrying that
 * limit into the artifacts generated from it.
 */

/**
 * Read the rule out of an ArkType constraint, with or without metadata.
 *
 * Bounds and patterns wrap as `{ rule, meta }`; a domain wraps as
 * `{ domain, meta }`. Anything else — including a flagged pattern
 * (`{ rule, flags }`), which a caller has to see whole in order to reject its
 * flags rather than discard them — is returned unchanged.
 */
export function arkConstraintRule(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'meta' in value) {
    if ('rule' in value) return Reflect.get(value, 'rule');
    if ('domain' in value) return Reflect.get(value, 'domain');
  }
  return value;
}
