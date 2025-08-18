// Helm Release Resource Types
export interface HelmReleaseSpec {
  interval?: string;
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
  values?: Record<string, any>;
}

export interface HelmReleaseStatus {
  phase: 'Pending' | 'Installing' | 'Upgrading' | 'Ready' | 'Failed';
  revision?: number;
  lastDeployed?: string;
}