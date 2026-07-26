/** Internal source-analysis metadata kept outside status DTOs and YAML. */
export interface CompositionAnalysisMetadata {
  readonly originalCompositionFn: (...args: unknown[]) => unknown;
  readonly originalSchema: unknown;
}

const metadataByStatus = new WeakMap<WeakKey, CompositionAnalysisMetadata>();

/** Attach imperative compatibility-frontend metadata to a captured status object. */
export function setCompositionAnalysisMetadata<TArgs extends unknown[]>(
  status: WeakKey,
  metadata: {
    readonly originalCompositionFn: (...args: TArgs) => unknown;
    readonly originalSchema: unknown;
  }
): void {
  metadataByStatus.set(status, metadata as unknown as CompositionAnalysisMetadata);
}

/** Read imperative compatibility-frontend metadata without private DTO fields. */
export function getCompositionAnalysisMetadata(
  status: unknown
): CompositionAnalysisMetadata | undefined {
  return (typeof status === 'object' && status !== null) || typeof status === 'function'
    ? metadataByStatus.get(status)
    : undefined;
}

/** Preserve internal analysis metadata when status mappings are optimized or cloned. */
export function copyCompositionAnalysisMetadata(source: unknown, target: WeakKey): boolean {
  const metadata = getCompositionAnalysisMetadata(source);
  if (!metadata) return false;
  metadataByStatus.set(target, metadata);
  return true;
}
