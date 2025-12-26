// Pebble ACME Test Server Type Definitions
// Following the JupyterHub Pebble Helm Chart configuration

import { type } from 'arktype';

// Common Kubernetes types
export interface ResourceRequirements {
  limits?: {
    cpu?: string;
    memory?: string;
    [key: string]: string | undefined;
  };
  requests?: {
    cpu?: string;
    memory?: string;
    [key: string]: string | undefined;
  };
}

export interface Toleration {
  key?: string;
  operator?: 'Exists' | 'Equal';
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  tolerationSeconds?: number;
}

export interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    fieldRef?: {
      apiVersion?: string;
      fieldPath: string;
    };
    resourceFieldRef?: {
      containerName?: string;
      resource: string;
      divisor?: string;
    };
    configMapKeyRef?: {
      name?: string;
      key: string;
      optional?: boolean;
    };
    secretKeyRef?: {
      name?: string;
      key: string;
      optional?: boolean;
    };
  };
}

// Pebble Bootstrap Configuration
export interface PebbleBootstrapConfig {
  // Basic configuration
  name: string;
  namespace?: string;
  version?: string;
  
  // Pebble server configuration
  pebble?: {
    image?: {
      repository?: string;
      tag?: string;
      pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    };
    resources?: ResourceRequirements;
    nodeSelector?: Record<string, string>;
    tolerations?: Toleration[];
    env?: EnvVar[];
    config?: {
      pebble?: {
        httpPort?: number;  // Default: 80 (HTTP-01 challenge port)
        tlsPort?: number;   // Default: 443 (TLS-ALPN-01 challenge port)
      };
    };
  };
  
  // CoreDNS configuration for DNS resolution
  coredns?: {
    image?: {
      repository?: string;
      tag?: string;
      pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    };
    resources?: ResourceRequirements;
    nodeSelector?: Record<string, string>;
    tolerations?: Toleration[];
    // Custom CoreDNS configuration segment
    corefileSegment?: string;
  };
  
  // Service configuration
  service?: {
    type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
    port?: number;        // Default: 443 (HTTPS ACME API)
    managementPort?: number; // Default: 15000 (Management API)
  };
  
  // Security configuration
  security?: {
    // Whether to create RBAC resources
    rbac?: {
      create?: boolean;
    };
    // Service account configuration
    serviceAccount?: {
      create?: boolean;
      name?: string;
      annotations?: Record<string, string>;
    };
  };
}

// Pebble Helm Repository Configuration
export interface PebbleHelmRepositoryConfig {
  name: string;
  namespace?: string;
  url?: string;
  interval?: string;
  id?: string;
}

// Pebble Helm Release Configuration
export interface PebbleHelmReleaseConfig {
  name: string;
  namespace?: string;
  chart?: {
    name?: string;
    version?: string;
  };
  repositoryRef?: {
    name: string;
    namespace?: string;
  };
  values?: PebbleHelmValues;
  interval?: string;
  id?: string;
}

// Pebble Helm Values (matches the JupyterHub Pebble Helm Chart values.yaml)
export interface PebbleHelmValues {
  // Pebble server configuration
  pebble?: {
    image?: {
      repository?: string;
      tag?: string;
      pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    };
    resources?: ResourceRequirements;
    nodeSelector?: Record<string, string>;
    tolerations?: Toleration[];
    env?: EnvVar[];
    config?: {
      pebble?: {
        httpPort?: number;
        tlsPort?: number;
      };
    };
  };
  
  // CoreDNS configuration
  coredns?: {
    image?: {
      repository?: string;
      tag?: string;
      pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    };
    resources?: ResourceRequirements;
    nodeSelector?: Record<string, string>;
    tolerations?: Toleration[];
    corefileSegment?: string;
  };
  
  // Service configuration
  service?: {
    type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
    port?: number;
    managementPort?: number;
  };
  
  // RBAC configuration
  rbac?: {
    create?: boolean;
  };
  
  // Service account configuration
  serviceAccount?: {
    create?: boolean;
    name?: string;
    annotations?: Record<string, string>;
  };
}

// Status types
export interface PebbleBootstrapStatus {
  ready: boolean;
  phase: string;
  version: string;
  pebbleReady: boolean;
  corednsReady: boolean;
  acmeEndpoint: string;
  managementEndpoint: string;
  dnsServer: string;
}

// =============================================================================
// ARKTYPE SCHEMAS FOR BOOTSTRAP COMPOSITION
// =============================================================================

export const PebbleBootstrapConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'email?': 'string'
});

export const PebbleBootstrapStatusSchema = type({
  ready: 'boolean',
  phase: 'string',
  version: 'string',
  pebbleReady: 'boolean',
  corednsReady: 'boolean',
  acmeEndpoint: 'string',
  managementEndpoint: 'string',
  dnsServer: 'string'
});