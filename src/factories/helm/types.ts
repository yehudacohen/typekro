import type { TypeKroChartValues } from '../../core/types/common.js';

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
  targetNamespace?: string;
  install?: {
    createNamespace?: boolean;
    timeout?: string;
    remediation?: { retries?: number };
  };
  upgrade?: {
    timeout?: string;
    remediation?: { retries?: number };
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
