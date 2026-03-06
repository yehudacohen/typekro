// Kustomization Resource Types (for Flux CD Kustomization)
export interface KustomizationSpec {
  interval: string;
  sourceRef: {
    kind: 'GitRepository' | 'Bucket' | 'OCIRepository';
    name: string;
    namespace?: string;
  };
  path?: string;
  patches?: Array<{
    target?: {
      group?: string;
      version?: string;
      kind?: string;
      name?: string;
      namespace?: string;
      labelSelector?: string;
      annotationSelector?: string;
    };
    patch: string | Record<string, unknown>;
    options?: {
      allowNameChange?: boolean;
      allowKindChange?: boolean;
    };
  }>;
  images?: Array<{
    name: string;
    newName?: string;
    newTag?: string;
    digest?: string;
  }>;
  replicas?: Array<{
    name: string;
    count: number;
  }>;
  patchesStrategicMerge?: string[];
  patchesJson6902?: Array<{
    target: {
      group?: string;
      version?: string;
      kind: string;
      name: string;
      namespace?: string;
    };
    path: string;
  }>;
  prune?: boolean;
  wait?: boolean;
  timeout?: string;
}

export interface KustomizationStatus {
  conditions?: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
    lastTransitionTime?: string;
  }>;
  lastAppliedRevision?: string;
  lastAttemptedRevision?: string;
  observedGeneration?: number;
  inventory?: {
    entries: Array<{
      id: string;
      v: string;
    }>;
  };
}
