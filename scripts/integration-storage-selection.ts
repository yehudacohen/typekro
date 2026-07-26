export interface StorageClassCandidate {
  metadata?: {
    name?: string;
    annotations?: Record<string, string>;
  };
}

function defaultStorageClass(resources: StorageClassCandidate[]): string | undefined {
  return resources.find((resource) => {
    const annotations = resource.metadata?.annotations ?? {};
    return (
      annotations['storageclass.kubernetes.io/is-default-class'] === 'true' ||
      annotations['storageclass.beta.kubernetes.io/is-default-class'] === 'true'
    );
  })?.metadata?.name;
}

export function selectStorageClass(
  storageClasses: StorageClassCandidate[],
  requested: string | undefined,
  allowAnnotatedDefault: boolean
): string | undefined {
  if (requested) {
    if (!storageClasses.some((resource) => resource.metadata?.name === requested)) {
      throw new Error(`Configured StorageClass does not exist: ${requested}`);
    }
    return requested;
  }

  if (!allowAnnotatedDefault) {
    throw new Error(
      'Existing clusters require an explicit RWO-capable StorageClass. Set TYPEKRO_NATS_STORAGE_CLASS (and optionally TYPEKRO_TEST_STORAGE_CLASS); a default annotation alone is not operational evidence.'
    );
  }

  return defaultStorageClass(storageClasses);
}
