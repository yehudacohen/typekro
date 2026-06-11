/**
 * Cross-module helper fixtures for interprocedural analysis tests.
 * These live in a SEPARATE module so the analyzer must follow an import to reach them
 * (the Dagster-mapper shape: value-builders imported from another file).
 */

/** Expression-bodied helper using a cross-field nullish chain. */
export const crossModuleData = (spec: { a?: string; b?: string }) => ({
  value: spec.a ?? spec.b ?? 'cross-module-default',
})

/** A setIfDefined-style mutator (mirrors the Dagster mapper's helper-mutation pattern). */
const setIfDefined = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (value !== undefined) target[key] = value
}

/** Object built by mutation through another helper, with a nested cross-field default. */
export const crossModuleMutated = (spec: { primary?: string; secondary?: string }) => {
  const out: Record<string, unknown> = {}
  setIfDefined(out, 'resolved', spec.primary ?? spec.secondary ?? 'mutated-default')
  return out
}
