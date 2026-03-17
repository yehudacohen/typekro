// Helm Release Resource Types
export interface HelmReleaseSpec {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Helm values are arbitrary user-defined objects
  values?: Record<string, any>;
  targetNamespace?: string;
  install?: {
    createNamespace?: boolean;
    remediation?: { retries?: number };
  };
  upgrade?: {
    remediation?: { retries?: number };
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
