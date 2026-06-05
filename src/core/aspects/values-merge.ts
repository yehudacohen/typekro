export interface ValuesMergeExpression {
  readonly __typekroValuesMerge: true;
  readonly base: unknown;
  readonly overlays: readonly unknown[];
}

export function isValuesMergeExpression(value: unknown): value is ValuesMergeExpression {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { __typekroValuesMerge?: unknown }).__typekroValuesMerge === true
  );
}

export function mergeValuesExpression(base: unknown, overlay: unknown): ValuesMergeExpression {
  if (isValuesMergeExpression(base)) {
    const overlays = Array.isArray(base.overlays)
      ? base.overlays
      : 'overlay' in base
        ? [(base as { overlay?: unknown }).overlay]
        : [];
    return {
      __typekroValuesMerge: true,
      base: base.base,
      overlays: [...overlays, overlay],
    };
  }

  return { __typekroValuesMerge: true, base, overlays: [overlay] };
}
