/**
 * APISix Ingress Controller Types
 *
 * Type definitions for APISix ingress controller bootstrap configuration
 * following the same patterns as cert-manager types.
 */

import { type Type, type } from 'arktype';
import type {
  Affinity,
  EnvVar,
  ResourceRequirements,
  SecurityContext,
  Toleration,
} from '../cert-manager/types.js';

// APISix Bootstrap Configuration
export interface APISixBootstrapConfig {
  // Basic configuration
  name: string;
  namespace?: string;
  version?: string;

  // Global configuration
  global?: {
    imagePullSecrets?: string[];
    imageRegistry?: string;
  };

  // Installation configuration
  installCRDs?: boolean;
  replicaCount?: number;

  // Gateway configuration (APISix Gateway)
  gateway?: {
    type?: 'NodePort' | 'LoadBalancer' | 'ClusterIP';
    http?: {
      enabled?: boolean;
      servicePort?: number;
      containerPort?: number;
    };
    https?: {
      enabled?: boolean;
      servicePort?: number;
      containerPort?: number;
    };
    stream?: {
      enabled?: boolean;
      only?: boolean;
      tcp?: number[];
      udp?: number[];
    };
    ingress?: {
      enabled?: boolean;
      annotations?: Record<string, string>;
      hosts?: string[];
      tls?: Array<{
        secretName?: string;
        hosts?: string[];
      }>;
    };
    /**
     * Admin API credentials for the APISIX Admin API.
     *
     * Override the chart defaults for production deployments. When omitted,
     * credentials are resolved from `APISIX_ADMIN_KEY` / `APISIX_VIEWER_KEY`
     * environment variables, falling back to well-known chart defaults (with a
     * warning) for local development only.
     *
     * @security These values are sensitive. Do not commit them to source control.
     * Prefer environment variables or a secrets manager.
     */
    adminCredentials?: {
      admin?: string;
      viewer?: string;
    };
  };

  // Ingress Controller configuration
  ingressController?: {
    enabled?: boolean;
    image?: {
      repository?: string;
      tag?: string;
      pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    };
    resources?: ResourceRequirements;
    nodeSelector?: Record<string, string>;
    tolerations?: Toleration[];
    affinity?: Affinity;
    securityContext?: SecurityContext;
    containerSecurityContext?: SecurityContext;
    extraArgs?: string[];
    env?: EnvVar[];
    config?: {
      apisix?: {
        serviceNamespace?: string;
        serviceName?: string;
        servicePort?: number;
        adminAPIVersion?: string;
      };
      kubernetes?: {
        kubeconfig?: string;
        resyncInterval?: string;
        namespace?: string;
        ingressClass?: string;
        ingressVersion?: string;
        watchEndpointSlices?: boolean;
        watchedNamespace?: string;
      };
    };
  };

  // APISix configuration
  apisix?: {
    image?: {
      repository?: string;
      tag?: string;
      pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    };
    resources?: ResourceRequirements;
    nodeSelector?: Record<string, string>;
    tolerations?: Toleration[];
    affinity?: Affinity;
    securityContext?: SecurityContext;
    containerSecurityContext?: SecurityContext;
    extraArgs?: string[];
    env?: EnvVar[];
    config?: Record<string, any>;
  };

  // Dashboard configuration
  dashboard?: {
    enabled?: boolean;
    image?: {
      repository?: string;
      tag?: string;
      pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    };
    resources?: ResourceRequirements;
    config?: Record<string, any>;
  };

  // etcd configuration
  etcd?: {
    enabled?: boolean;
    image?: {
      repository?: string;
      tag?: string;
      pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    };
    resources?: ResourceRequirements;
    auth?: {
      rbac?: {
        create?: boolean;
        user?: string;
        password?: string;
      };
      tls?: {
        enabled?: boolean;
        existingSecret?: string;
        certFilename?: string;
        keyFilename?: string;
        verify?: boolean;
      };
    };
  };

  // Service Account configuration
  serviceAccount?: {
    create?: boolean;
    name?: string;
    annotations?: Record<string, string>;
  };

  // RBAC configuration
  rbac?: {
    create?: boolean;
  };

  // Custom values override (for any additional Helm values)
  customValues?: Record<string, any>;
}

/**
 * ArkType schema for APISixBootstrapConfig
 * Following KroCompatibleType constraints - only basic types, nested objects, and optional fields
 */
export const APISixBootstrapConfigSchema: Type<APISixBootstrapConfig> = type({
  // Basic configuration
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',

  // Installation configuration
  'installCRDs?': 'boolean',
  'replicaCount?': 'number',

  // Global configuration
  'global?': {
    'imagePullSecrets?': 'string[]',
    'imageRegistry?': 'string',
  },

  // Gateway configuration
  'gateway?': {
    'type?': '"NodePort" | "LoadBalancer" | "ClusterIP"',
    'http?': {
      'enabled?': 'boolean',
      'servicePort?': 'number',
      'containerPort?': 'number',
    },
    'https?': {
      'enabled?': 'boolean',
      'servicePort?': 'number',
      'containerPort?': 'number',
    },
  },

  // Ingress Controller configuration
  'ingressController?': {
    'enabled?': 'boolean',
    'extraArgs?': 'string[]',
    'config?': {
      'kubernetes?': {
        'ingressClass?': 'string',
        'namespace?': 'string',
        'watchedNamespace?': 'string',
      },
    },
  },

  // Service Account configuration
  'serviceAccount?': {
    'create?': 'boolean',
    'name?': 'string',
  },

  // RBAC configuration
  'rbac?': {
    'create?': 'boolean',
  },
});

/**
 * ArkType schema for APISixBootstrapStatus
 * Following KroCompatibleType constraints - only basic types, nested objects, and optional fields
 */
export const APISixBootstrapStatusSchema: Type<APISixBootstrapStatus> = type({
  // Overall status
  ready: 'boolean',
  phase: '"Pending" | "Installing" | "Ready" | "Failed" | "Upgrading"',

  // Component status
  gatewayReady: 'boolean',
  ingressControllerReady: 'boolean',
  dashboardReady: 'boolean',
  etcdReady: 'boolean',

  // Service information
  'gatewayService?': {
    name: 'string',
    namespace: 'string',
    type: 'string',
    'clusterIP?': 'string',
    'externalIP?': 'string',
  },

  // Ingress class information
  'ingressClass?': {
    name: 'string',
    controller: 'string',
  },
});

// APISix Bootstrap Status
export interface APISixBootstrapStatus {
  // Overall status
  ready: boolean;
  phase: 'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading';

  // Component status
  gatewayReady: boolean;
  ingressControllerReady: boolean;
  dashboardReady: boolean;
  etcdReady: boolean;

  // Service information
  gatewayService?: {
    name: string;
    namespace: string;
    type: string;
    clusterIP?: string;
    externalIP?: string;
    ports?: Array<{
      name: string;
      port: number;
      targetPort: number;
      protocol: string;
    }>;
  };

  // Ingress class information
  ingressClass?: {
    name: string;
    controller: string;
  };
}

// APISix Helm Values (matches the official APISix Helm chart structure)
export interface APISixHelmValues {
  // Global configuration
  global?: {
    imagePullSecrets?: string[];
    imageRegistry?: string;
  };

  // Installation configuration
  installCRDs?: boolean;
  replicaCount?: number;

  // Deployment configuration
  deployment?: {
    admin?: {
      allow_admin?: string[];
      admin_key?: Array<{
        name?: string;
        key?: string;
        role?: string;
      }>;
      admin_listen?: {
        ip?: string;
        port?: number;
      };
    };
  };

  // Gateway configuration
  gateway?: {
    type?: 'NodePort' | 'LoadBalancer' | 'ClusterIP';
    http?: {
      enabled?: boolean;
      servicePort?: number;
      containerPort?: number;
    };
    https?: {
      enabled?: boolean;
      servicePort?: number;
      containerPort?: number;
    };
    stream?: {
      enabled?: boolean;
      only?: boolean;
      tcp?: number[];
      udp?: number[];
    };
    ingress?: {
      enabled?: boolean;
      annotations?: Record<string, string>;
      hosts?: string[];
      tls?: Array<{
        secretName?: string;
        hosts?: string[];
      }>;
    };
  };

  // Ingress Controller configuration
  ingressController?: {
    enabled?: boolean;
    image?: {
      repository?: string;
      tag?: string;
      pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    };
    resources?: ResourceRequirements;
    nodeSelector?: Record<string, string>;
    tolerations?: Toleration[];
    affinity?: Affinity;
    securityContext?: SecurityContext;
    containerSecurityContext?: SecurityContext;
    extraArgs?: string[];
    env?: EnvVar[];
    config?: {
      apisix?: {
        serviceNamespace?: string;
        serviceName?: string;
        servicePort?: number;
        adminAPIVersion?: string;
      };
      kubernetes?: {
        kubeconfig?: string;
        resyncInterval?: string;
        namespace?: string;
        ingressClass?: string;
        ingressVersion?: string;
        watchEndpointSlices?: boolean;
        watchedNamespace?: string;
      };
    };
  };

  // APISix configuration (for main apisix chart)
  apisix?: {
    image?: {
      repository?: string;
      tag?: string;
      pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    };
    resources?: ResourceRequirements;
    nodeSelector?: Record<string, string>;
    tolerations?: Toleration[];
    affinity?: Affinity;
    securityContext?: SecurityContext;
    containerSecurityContext?: SecurityContext;
    extraArgs?: string[];
    env?: EnvVar[];
    config?: Record<string, any>;
    // Admin service configuration (for ingress controller chart)
    // This configures the init container to wait for the correct APISIX admin service
    adminService?: {
      namespace?: string;
      name?: string;
      port?: number;
    };
  };

  // Dashboard configuration
  dashboard?: {
    enabled?: boolean;
    image?: {
      repository?: string;
      tag?: string;
      pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    };
    resources?: ResourceRequirements;
    config?: Record<string, any>;
  };

  // etcd configuration
  etcd?: {
    enabled?: boolean;
    image?: {
      repository?: string;
      tag?: string;
      pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
    };
    resources?: ResourceRequirements;
    auth?: {
      rbac?: {
        create?: boolean;
        user?: string;
        password?: string;
      };
      tls?: {
        enabled?: boolean;
        existingSecret?: string;
        certFilename?: string;
        keyFilename?: string;
        verify?: boolean;
      };
    };
  };

  // Service Account configuration
  serviceAccount?: {
    create?: boolean;
    name?: string;
    annotations?: Record<string, string>;
  };

  // RBAC configuration
  rbac?: {
    create?: boolean;
  };

  // Service configuration (for gateway service type)
  service?: {
    type?: 'NodePort' | 'LoadBalancer' | 'ClusterIP';
    /** External traffic policy. Set to '' to disable for ClusterIP on Kubernetes 1.33+. */
    externalTrafficPolicy?: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    http?: {
      enabled?: boolean;
      servicePort?: number;
      containerPort?: number;
    };
    tls?: {
      enabled?: boolean;
      servicePort?: number;
      containerPort?: number;
    };
  };

  // Custom values override
  [key: string]: unknown;
}

/**
 * Extended APISix configuration for admin access.
 *
 * @security The `credentials` field contains sensitive admin API keys.
 * Never log or persist these values in plain text.
 */
export interface APISixAdminConfig {
  allow?: {
    ipList?: string[];
  };
  /** @security Admin and viewer API keys — treat as secrets. */
  credentials?: {
    admin?: string;
    viewer?: string;
  };
}
