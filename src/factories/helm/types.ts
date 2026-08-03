import type { TypeKroChartValues } from '../../core/types/common.js';

/** A Flux HelmRelease values source. */
export interface HelmReleaseValuesFromSource {
  /** Kubernetes object kind containing the source value. */
  kind: 'Secret' | 'ConfigMap';
  /** Name of the source object in the HelmRelease namespace. */
  name: string;
  /** Source key. Defaults to `values.yaml` when `targetPath` is omitted. */
  valuesKey?: string;
  /** Helm values path receiving the source value. */
  targetPath?: string;
  /**
   * Values projected through targetPath follow the Helm Controller baseline's
   * `--set` parsing semantics. TypeKro does not expose Flux 2.9's `literal`
   * field while its managed runtime remains on Flux 2.7.5.
   */
  /** Allow reconciliation to continue when the source object or key is absent. */
  optional?: boolean;
}

/** Select Kubernetes resources for a Flux Kustomize post-render patch. */
export interface HelmReleasePostRendererPatchTarget {
  group?: string;
  version?: string;
  kind?: string;
  name?: string;
  namespace?: string;
  labelSelector?: string;
  annotationSelector?: string;
}

/** An inline strategic-merge or JSON 6902 patch applied after Helm rendering. */
export interface HelmReleasePostRendererPatch {
  patch: string;
  target?: HelmReleasePostRendererPatchTarget;
}

/** Rewrite an image reference after Helm rendering. */
export interface HelmReleasePostRendererImage {
  name: string;
  newName?: string;
  newTag?: string;
  digest?: string;
}

/** Flux Kustomize post-renderer configuration. */
export interface HelmReleasePostRenderer {
  kustomize: {
    patches?: HelmReleasePostRendererPatch[];
    images?: HelmReleasePostRendererImage[];
  };
}

// Helm Release Resource Types
export interface HelmReleaseSpec<TValues extends object = Record<string, unknown>> {
  interval?: string;
  timeout?: string;
  chart: {
    spec: {
      chart: string;
      version?: string;
      sourceRef: {
        kind: 'HelmRepository';
        name: string;
        namespace?: string;
      };
    };
  };
  /**
   * Helm values are graph-aware TypeKro value trees: refs, CEL expressions,
   * mixed templates, arrays, and plain objects are serialized recursively.
   */
  values?: TypeKroChartValues<TValues>;
  /** Values loaded from Secrets or ConfigMaps by Flux. */
  valuesFrom?: HelmReleaseValuesFromSource[];
  /** Kustomize transformations applied by Flux after Helm renders the chart. */
  postRenderers?: HelmReleasePostRenderer[];
  targetNamespace?: string;
  install?: {
    createNamespace?: boolean;
    timeout?: string;
    remediation?: {
      retries?: number;
      remediateLastFailure?: boolean;
      ignoreTestFailures?: boolean;
    };
  };
  upgrade?: {
    timeout?: string;
    remediation?: {
      retries?: number;
      remediateLastFailure?: boolean;
      ignoreTestFailures?: boolean;
      strategy?: 'rollback' | 'uninstall';
    };
  };
  driftDetection?: {
    mode: 'enabled' | 'warn' | 'disabled';
    ignore?: Record<string, unknown>[];
  };
}

export interface HelmReleaseStatus {
  conditions?: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
    lastTransitionTime?: string;
    observedGeneration?: number;
  }>;
  helmChart?: string;
  lastAttemptedRevision?: string;
  observedGeneration?: number;
  storageNamespace?: string;
  history?: Array<{
    name?: string;
    namespace?: string;
    version?: number;
    status?: string;
    chartName?: string;
    chartVersion?: string;
    appVersion?: string;
    digest?: string;
    firstDeployed?: string;
    lastDeployed?: string;
  }>;
}
