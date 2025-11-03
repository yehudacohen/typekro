// Cert-Manager Type Definitions
// Following cert-manager.io/v1 API specifications

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

export interface NodeAffinity {
  requiredDuringSchedulingIgnoredDuringExecution?: {
    nodeSelectorTerms: {
      matchExpressions?: {
        key: string;
        operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist' | 'Gt' | 'Lt';
        values?: string[];
      }[];
      matchFields?: {
        key: string;
        operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist' | 'Gt' | 'Lt';
        values?: string[];
      }[];
    }[];
  };
  preferredDuringSchedulingIgnoredDuringExecution?: {
    weight: number;
    preference: {
      matchExpressions?: {
        key: string;
        operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist' | 'Gt' | 'Lt';
        values?: string[];
      }[];
      matchFields?: {
        key: string;
        operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist' | 'Gt' | 'Lt';
        values?: string[];
      }[];
    };
  }[];
}

export interface PodAffinity {
  requiredDuringSchedulingIgnoredDuringExecution?: {
    labelSelector?: {
      matchExpressions?: {
        key: string;
        operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
        values?: string[];
      }[];
      matchLabels?: Record<string, string>;
    };
    namespaces?: string[];
    topologyKey: string;
  }[];
  preferredDuringSchedulingIgnoredDuringExecution?: {
    weight: number;
    podAffinityTerm: {
      labelSelector?: {
        matchExpressions?: {
          key: string;
          operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
          values?: string[];
        }[];
        matchLabels?: Record<string, string>;
      };
      namespaces?: string[];
      topologyKey: string;
    };
  }[];
}

export interface PodAntiAffinity {
  requiredDuringSchedulingIgnoredDuringExecution?: {
    labelSelector?: {
      matchExpressions?: {
        key: string;
        operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
        values?: string[];
      }[];
      matchLabels?: Record<string, string>;
    };
    namespaces?: string[];
    topologyKey: string;
  }[];
  preferredDuringSchedulingIgnoredDuringExecution?: {
    weight: number;
    podAffinityTerm: {
      labelSelector?: {
        matchExpressions?: {
          key: string;
          operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
          values?: string[];
        }[];
        matchLabels?: Record<string, string>;
      };
      namespaces?: string[];
      topologyKey: string;
    };
  }[];
}

export interface Affinity {
  nodeAffinity?: NodeAffinity;
  podAffinity?: PodAffinity;
  podAntiAffinity?: PodAntiAffinity;
}

export interface SecurityContext {
  runAsUser?: number;
  runAsGroup?: number;
  runAsNonRoot?: boolean;
  fsGroup?: number;
  seLinuxOptions?: {
    level?: string;
    role?: string;
    type?: string;
    user?: string;
  };
  windowsOptions?: {
    gmsaCredentialSpec?: string;
    gmsaCredentialSpecName?: string;
    hostProcess?: boolean;
    runAsUserName?: string;
  };
  fsGroupChangePolicy?: 'Always' | 'OnRootMismatch';
  supplementalGroups?: number[];
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

export interface Volume {
  name: string;
  hostPath?: {
    path: string;
    type?: string;
  };
  emptyDir?: {
    medium?: string;
    sizeLimit?: string;
  };
  secret?: {
    secretName?: string;
    items?: {
      key: string;
      path: string;
      mode?: number;
    }[];
    defaultMode?: number;
    optional?: boolean;
  };
  configMap?: {
    name?: string;
    items?: {
      key: string;
      path: string;
      mode?: number;
    }[];
    defaultMode?: number;
    optional?: boolean;
  };
  persistentVolumeClaim?: {
    claimName: string;
    readOnly?: boolean;
  };
}

export interface VolumeMount {
  name: string;
  mountPath: string;
  subPath?: string;
  readOnly?: boolean;
  mountPropagation?: 'None' | 'HostToContainer' | 'Bidirectional';
}

export interface LabelSelector {
  matchExpressions?: {
    key: string;
    operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
    values?: string[];
  }[];
  matchLabels?: Record<string, string>;
}

// Cert-Manager Bootstrap Configuration
export interface CertManagerBootstrapConfig {
  // Basic configuration
  name: string;
  namespace?: string;
  version?: string;

  // Global configuration
  global?: {
    leaderElection?: {
      namespace?: string;
    };
    logLevel?: number;
    podSecurityPolicy?: {
      enabled?: boolean;
      useAppArmor?: boolean;
    };
  };

  // Installation configuration
  installCRDs?: boolean; // Note: Best practice is to install CRDs separately
  replicaCount?: number;
  strategy?: {
    type?: 'Recreate' | 'RollingUpdate';
    rollingUpdate?: {
      maxSurge?: number | string;
      maxUnavailable?: number | string;
    };
  };

  // Controller configuration
  controller?: {
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
    volumes?: Volume[];
    volumeMounts?: VolumeMount[];
    extraArgs?: string[]; // Additional arguments for cert-manager controller (use this for DNS resolver config)
    env?: EnvVar[];
    serviceAccount?: {
      create?: boolean;
      name?: string;
      annotations?: Record<string, string>;
    };
  };

  // Webhook configuration
  webhook?: {
    enabled?: boolean;
    replicaCount?: number;
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
    args?: string[];
    env?: EnvVar[];
    serviceAccount?: {
      create?: boolean;
      name?: string;
      annotations?: Record<string, string>;
    };
    config?: {
      apiVersion?: string;
      kind?: string;
      metadata?: {
        name?: string;
      };
      webhooks?: WebhookConfig[];
    };
    mutatingAdmissionWebhooks?: {
      failurePolicy?: 'Fail' | 'Ignore';
      admissionReviewVersions?: string[];
      timeoutSeconds?: number;
    };
    validatingAdmissionWebhooks?: {
      failurePolicy?: 'Fail' | 'Ignore';
      admissionReviewVersions?: string[];
      timeoutSeconds?: number;
    };
  };

  // CA Injector configuration
  cainjector?: {
    enabled?: boolean;
    replicaCount?: number;
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
    args?: string[];
    env?: EnvVar[];
    serviceAccount?: {
      create?: boolean;
      name?: string;
      annotations?: Record<string, string>;
    };
  };

  // ACME HTTP01 solver configuration
  acmesolver?: {
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
  };

  // Startup API check configuration
  startupapicheck?: {
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
    timeout?: string;
    backoffLimit?: number;
    jobAnnotations?: Record<string, string>;
    podAnnotations?: Record<string, string>;
  };

  // Monitoring configuration
  prometheus?: {
    enabled?: boolean;
    servicemonitor?: {
      enabled?: boolean;
      prometheusInstance?: string;
      targetPort?: number;
      path?: string;
      interval?: string;
      scrapeTimeout?: string;
      labels?: Record<string, string>;
      honorLabels?: boolean;
    };
  };

  // Custom Helm values override
  customValues?: Record<string, any>;

  // TypeKro specific
  id?: string;
}

export interface CertManagerBootstrapStatus {
  // Overall status - derived from HelmRelease status (real data)
  phase: 'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading';
  ready: boolean;
  version: string;

  // Component readiness - derived from HelmRelease status (real data)
  controllerReady: boolean;
  webhookReady: boolean;
  cainjectorReady: boolean;

  // CRD installation status - derived from configuration (accurate for bootstrap)
  crds: {
    installed: boolean; // From spec.installCRDs
    version: string; // From spec.version
  };

  // Note: Removed misleading fields that can't be populated with real data:
  // - endpoints: Would require querying services created by Helm chart
  // - issuers/certificates: Would require querying cert-manager CRDs
  // These should be added in future compositions that manage resources directly
}

// Webhook configuration types
export interface WebhookConfig {
  name: string;
  clientConfig: {
    service?: {
      name: string;
      namespace: string;
      path?: string;
      port?: number;
    };
    url?: string;
    caBundle?: string;
  };
  rules?: {
    operations: ('CREATE' | 'UPDATE' | 'DELETE' | 'CONNECT')[];
    apiGroups: string[];
    apiVersions: string[];
    resources: string[];
    scope?: 'Cluster' | 'Namespaced' | '*';
  }[];
  admissionReviewVersions: string[];
  sideEffects: 'None' | 'NoneOnDryRun' | 'Some' | 'Unknown';
  timeoutSeconds?: number;
  failurePolicy?: 'Fail' | 'Ignore';
  matchPolicy?: 'Exact' | 'Equivalent';
  namespaceSelector?: LabelSelector;
  objectSelector?: LabelSelector;
}

// Certificate CRD Types (following cert-manager.io/v1 API)
export interface CertificateConfig {
  name: string;
  namespace?: string;
  spec: {
    // Required fields
    secretName: string;
    issuerRef: {
      name: string;
      kind: 'Issuer' | 'ClusterIssuer';
      group?: string; // Defaults to cert-manager.io
    };

    // Certificate identity
    commonName?: string;
    dnsNames?: string[];
    ipAddresses?: string[];
    uris?: string[];
    emailAddresses?: string[];

    // Subject information
    subject?: {
      organizationalUnits?: string[];
      countries?: string[];
      organizations?: string[];
      localities?: string[];
      provinces?: string[];
      streetAddresses?: string[];
      postalCodes?: string[];
      serialNumber?: string;
    };

    // Certificate lifecycle
    duration?: string; // e.g., "2160h" (90 days)
    renewBefore?: string; // e.g., "360h" (15 days)

    // Key usage
    usages?: (
      | 'signing'
      | 'digital signature'
      | 'content commitment'
      | 'key encipherment'
      | 'key agreement'
      | 'data encipherment'
      | 'cert sign'
      | 'crl sign'
      | 'encipher only'
      | 'decipher only'
      | 'any'
      | 'server auth'
      | 'client auth'
      | 'code signing'
      | 'email protection'
      | 's/mime'
      | 'ipsec end system'
      | 'ipsec tunnel'
      | 'ipsec user'
      | 'timestamping'
      | 'ocsp signing'
      | 'microsoft sgc'
      | 'netscape sgc'
    )[];

    // Private key configuration
    privateKey?: {
      algorithm?: 'RSA' | 'ECDSA' | 'Ed25519';
      encoding?: 'PKCS1' | 'PKCS8';
      size?: number; // RSA: 2048, 3072, 4096; ECDSA: 256, 384, 521
      rotationPolicy?: 'Never' | 'Always';
    };

    // Keystore formats
    keystores?: {
      jks?: {
        create?: boolean;
        passwordSecretRef?: {
          name: string;
          key: string;
        };
      };
      pkcs12?: {
        create?: boolean;
        passwordSecretRef?: {
          name: string;
          key: string;
        };
      };
    };

    // Additional output formats
    additionalOutputFormats?: {
      type: 'DER' | 'CombinedPEM';
    }[];

    // Secret template
    secretTemplate?: {
      annotations?: Record<string, string>;
      labels?: Record<string, string>;
    };
  };
  id?: string;
}

// ClusterIssuer CRD Types (following cert-manager.io/v1 API)
export interface ClusterIssuerConfig {
  name: string;
  spec: {
    // ACME issuer (Let's Encrypt, etc.)
    acme?: {
      server: string; // e.g., "https://acme-v02.api.letsencrypt.org/directory"
      email: string;
      privateKeySecretRef: {
        name: string;
      };

      // External Account Binding (for some ACME providers)
      externalAccountBinding?: {
        keyID: string;
        keySecretRef: {
          name: string;
          key: string;
        };
        keyAlgorithm?: 'HS256' | 'HS384' | 'HS512';
      };

      // Challenge solvers
      solvers: {
        // Selector for which domains this solver applies to
        selector?: {
          dnsNames?: string[];
          dnsZones?: string[];
          matchLabels?: Record<string, string>;
        };

        // HTTP-01 challenge
        http01?: {
          ingress?: {
            class?: string;
            name?: string;
            podTemplate?: {
              metadata?: {
                annotations?: Record<string, string>;
                labels?: Record<string, string>;
              };
              spec?: {
                nodeSelector?: Record<string, string>;
                tolerations?: Toleration[];
                affinity?: Affinity;
              };
            };
            serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
          };
          gateway?: {
            name: string;
            namespace?: string;
            httpRoute?: {
              labels?: Record<string, string>;
            };
          };
        };

        // DNS-01 challenge
        dns01?: {
          cnameStrategy?: 'Follow' | 'None';

          // AWS Route53
          route53?: {
            accessKeyID?: string;
            accessKeyIDSecretRef?: {
              name: string;
              key: string;
              namespace?: string;
            };
            secretAccessKeySecretRef?: {
              name: string;
              key: string;
              namespace?: string;
            };
            region: string;
            hostedZoneID?: string;
            role?: string;
          };

          // Azure DNS
          azureDNS?: {
            clientID?: string;
            clientSecretSecretRef?: {
              name: string;
              key: string;
            };
            subscriptionID: string;
            tenantID: string;
            resourceGroupName: string;
            hostedZoneName?: string;
            environment?:
              | 'AzurePublicCloud'
              | 'AzureChinaCloud'
              | 'AzureGermanCloud'
              | 'AzureUSGovernmentCloud';
          };

          // Cloudflare
          cloudflare?: {
            email?: string;
            apiKeySecretRef?: {
              name: string;
              key: string;
            };
            apiTokenSecretRef?: {
              name: string;
              key: string;
            };
          };

          // Google Cloud DNS
          cloudDNS?: {
            project: string;
            serviceAccountSecretRef?: {
              name: string;
              key: string;
            };
          };

          // DigitalOcean
          digitalocean?: {
            tokenSecretRef: {
              name: string;
              key: string;
            };
          };

          // RFC2136 (generic DNS)
          rfc2136?: {
            nameserver: string;
            tsigKeyName?: string;
            tsigAlgorithm?: string;
            tsigSecretSecretRef?: {
              name: string;
              key: string;
            };
          };

          // Webhook (custom DNS providers)
          webhook?: {
            groupName: string;
            solverName: string;
            config?: Record<string, any>;
          };
        };
      }[];
    };

    // CA issuer (private certificate authority)
    ca?: {
      secretName: string;
      crlDistributionPoints?: string[];
      ocspServers?: string[];
      issuingCertificateURLs?: string[];
    };

    // HashiCorp Vault issuer
    vault?: {
      server: string;
      path: string;
      namespace?: string;
      caBundle?: string;
      auth: {
        tokenSecretRef?: {
          name: string;
          key: string;
        };
        appRole?: {
          path: string;
          roleId: string;
          secretRef: {
            name: string;
            key: string;
          };
        };
        kubernetes?: {
          mountPath: string;
          role: string;
          secretRef?: {
            name: string;
            key: string;
          };
        };
      };
    };

    // Venafi issuer
    venafi?: {
      zone: string;
      tpp?: {
        url: string;
        credentialsRef: {
          name: string;
        };
        caBundle?: string;
      };
      cloud?: {
        url?: string;
        apiTokenSecretRef: {
          name: string;
          key: string;
        };
      };
    };

    // Self-signed issuer
    selfSigned?: {
      crlDistributionPoints?: string[];
    };
  };
  id?: string;
}

// Issuer CRD Types (namespace-scoped version of ClusterIssuer)
export interface IssuerConfig {
  name: string;
  namespace?: string;
  spec: ClusterIssuerConfig['spec'];
  id?: string;
}

// Challenge CRD Types
export interface ChallengeConfig {
  name: string;
  namespace?: string;
  spec: {
    url: string;
    authorizationURL: string;
    dnsName: string;
    wildcard?: boolean;
    type: 'HTTP-01' | 'DNS-01';
    token: string;
    key: string;
    solver: {
      selector?: {
        dnsNames?: string[];
        dnsZones?: string[];
        matchLabels?: Record<string, string>;
      };
      http01?: {
        ingress?: {
          class?: string;
          name?: string;
          podTemplate?: {
            metadata?: {
              annotations?: Record<string, string>;
              labels?: Record<string, string>;
            };
            spec?: {
              nodeSelector?: Record<string, string>;
              tolerations?: Toleration[];
              affinity?: Affinity;
            };
          };
          serviceType?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
        };
      };
      dns01?: {
        cnameStrategy?: 'Follow' | 'None';
        route53?: {
          accessKeyID?: string;
          secretAccessKeySecretRef?: {
            name: string;
            key: string;
          };
          region: string;
          hostedZoneID?: string;
          role?: string;
        };
        azureDNS?: {
          clientID?: string;
          clientSecretSecretRef?: {
            name: string;
            key: string;
          };
          subscriptionID: string;
          tenantID: string;
          resourceGroupName: string;
          hostedZoneName?: string;
          environment?:
            | 'AzurePublicCloud'
            | 'AzureChinaCloud'
            | 'AzureGermanCloud'
            | 'AzureUSGovernmentCloud';
        };
        cloudflare?: {
          email?: string;
          apiKeySecretRef?: {
            name: string;
            key: string;
          };
          apiTokenSecretRef?: {
            name: string;
            key: string;
          };
        };
        cloudDNS?: {
          project: string;
          serviceAccountSecretRef?: {
            name: string;
            key: string;
          };
        };
        digitalocean?: {
          tokenSecretRef: {
            name: string;
            key: string;
          };
        };
        rfc2136?: {
          nameserver: string;
          tsigKeyName?: string;
          tsigAlgorithm?: string;
          tsigSecretSecretRef?: {
            name: string;
            key: string;
          };
        };
        webhook?: {
          groupName: string;
          solverName: string;
          config?: Record<string, any>;
        };
      };
    };
    issuerRef: {
      name: string;
      kind: 'Issuer' | 'ClusterIssuer';
      group?: string;
    };
  };
  id?: string;
}

// Order CRD Types
export interface OrderConfig {
  name: string;
  namespace?: string;
  spec: {
    request: string; // Base64 encoded CSR
    issuerRef: {
      name: string;
      kind: 'Issuer' | 'ClusterIssuer';
      group?: string;
    };
    commonName?: string;
    dnsNames?: string[];
    ipAddresses?: string[];
    duration?: string;
  };
  id?: string;
}

// Certificate status types
export interface CertificateCondition {
  type: 'Ready' | 'Issuing';
  status: 'True' | 'False' | 'Unknown';
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

export interface CertificateStatus {
  conditions?: CertificateCondition[];
  lastFailureTime?: string;
  notAfter?: string;
  notBefore?: string;
  renewalTime?: string;
  revision?: number;
  nextPrivateKeySecretName?: string;
}

// Issuer status types
export interface IssuerCondition {
  type: 'Ready';
  status: 'True' | 'False' | 'Unknown';
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

export interface IssuerStatus {
  conditions?: IssuerCondition[];
  acme?: {
    uri?: string;
    lastRegisteredEmail?: string;
  };
}

// Challenge status types
export interface ChallengeStatus {
  processing?: boolean;
  presented?: boolean;
  reason?: string;
  state?: 'valid' | 'ready' | 'pending' | 'processing' | 'invalid' | 'expired' | 'errored';
}

// Order status types
export interface OrderStatus {
  state?: 'valid' | 'ready' | 'pending' | 'processing' | 'invalid' | 'expired' | 'errored';
  reason?: string;
  url?: string;
  finalizeURL?: string;
  certificate?: string; // Base64 encoded certificate
  authorizations?: {
    url: string;
    identifier: {
      type: string;
      value: string;
    };
    wildcard?: boolean;
    challenges?: {
      url: string;
      token: string;
      type: string;
    }[];
  }[];
}

// =============================================================================
// ARKTYPE SCHEMAS FOR BOOTSTRAP COMPOSITION
// =============================================================================

import { type, type Type } from 'arktype';

/**
 * ArkType schema for CertManagerBootstrapConfig
 * Following KroCompatibleType constraints - only basic types, nested objects, and optional fields
 */
export const CertManagerBootstrapConfigSchema: Type<CertManagerBootstrapConfig> = type({
  // Basic configuration
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',

  // Installation configuration
  'installCRDs?': 'boolean',
  'replicaCount?': 'number',

  // Global configuration
  'global?': {
    'leaderElection?': {
      'namespace?': 'string',
    },
    'logLevel?': 'number',
    'podSecurityPolicy?': {
      'enabled?': 'boolean',
      'useAppArmor?': 'boolean',
    },
  },

  // Strategy configuration
  'strategy?': {
    'type?': '"Recreate" | "RollingUpdate"',
    'rollingUpdate?': {
      'maxSurge?': 'string',
      'maxUnavailable?': 'string',
    },
  },

  // Controller configuration
  'controller?': {
    'image?': {
      'repository?': 'string',
      'tag?': 'string',
      'pullPolicy?': '"Always" | "IfNotPresent" | "Never"',
    },
    'extraArgs?': 'string[]',
    'resources?': {
      'limits?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
      'requests?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
    },
    'nodeSelector?': 'Record<string, string>',
    'serviceAccount?': {
      'create?': 'boolean',
      'name?': 'string',
    },
  },

  // Webhook configuration
  'webhook?': {
    'enabled?': 'boolean',
    'replicaCount?': 'number',
    'image?': {
      'repository?': 'string',
      'tag?': 'string',
      'pullPolicy?': '"Always" | "IfNotPresent" | "Never"',
    },
    'resources?': {
      'limits?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
      'requests?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
    },
    'nodeSelector?': 'Record<string, string>',
    'serviceAccount?': {
      'create?': 'boolean',
      'name?': 'string',
    },
    'mutatingAdmissionWebhooks?': {
      'failurePolicy?': '"Fail" | "Ignore"',
      'timeoutSeconds?': 'number',
    },
    'validatingAdmissionWebhooks?': {
      'failurePolicy?': '"Fail" | "Ignore"',
      'timeoutSeconds?': 'number',
    },
  },

  // CA Injector configuration
  'cainjector?': {
    'enabled?': 'boolean',
    'replicaCount?': 'number',
    'image?': {
      'repository?': 'string',
      'tag?': 'string',
      'pullPolicy?': '"Always" | "IfNotPresent" | "Never"',
    },
    'resources?': {
      'limits?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
      'requests?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
    },
    'nodeSelector?': 'Record<string, string>',
    'serviceAccount?': {
      'create?': 'boolean',
      'name?': 'string',
    },
  },

  // ACME solver configuration
  'acmesolver?': {
    'image?': {
      'repository?': 'string',
      'tag?': 'string',
      'pullPolicy?': '"Always" | "IfNotPresent" | "Never"',
    },
    'resources?': {
      'limits?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
      'requests?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
    },
    'nodeSelector?': 'Record<string, string>',
  },

  // Startup API check configuration
  'startupapicheck?': {
    'enabled?': 'boolean',
    'image?': {
      'repository?': 'string',
      'tag?': 'string',
      'pullPolicy?': '"Always" | "IfNotPresent" | "Never"',
    },
    'resources?': {
      'limits?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
      'requests?': {
        'cpu?': 'string',
        'memory?': 'string',
      },
    },
    'nodeSelector?': 'Record<string, string>',
    'timeout?': 'string',
    'backoffLimit?': 'number',
  },

  // Monitoring configuration
  'prometheus?': {
    'enabled?': 'boolean',
    'servicemonitor?': {
      'enabled?': 'boolean',
      'prometheusInstance?': 'string',
      'targetPort?': 'number',
      'path?': 'string',
      'interval?': 'string',
      'scrapeTimeout?': 'string',
      'honorLabels?': 'boolean',
    },
  },

  // TypeKro specific
  'id?': 'string',
});

/**
 * ArkType schema for CertManagerBootstrapStatus
 * Following KroCompatibleType constraints - only basic types, nested objects, and optional fields
 */
export const CertManagerBootstrapStatusSchema: Type<CertManagerBootstrapStatus> = type({
  // Overall status - derived from HelmRelease status (real data)
  phase: '"Pending" | "Installing" | "Ready" | "Failed" | "Upgrading"',
  ready: 'boolean',
  version: 'string',

  // Component readiness - derived from HelmRelease status (real data)
  controllerReady: 'boolean',
  webhookReady: 'boolean',
  cainjectorReady: 'boolean',

  // CRD installation status - derived from configuration (accurate for bootstrap)
  crds: {
    installed: 'boolean', // From spec.installCRDs
    version: 'string', // From spec.version
  },

  // Note: Removed misleading fields (endpoints, issuers, certificates)
  // These should be added in future compositions that manage resources directly
});

// =============================================================================
// HELM INTEGRATION TYPES
// =============================================================================

/**
 * Configuration interface for Cert-Manager HelmRepository
 */
export interface CertManagerHelmRepositoryConfig {
  name: string;
  namespace?: string;
  url?: string; // Defaults to https://charts.jetstack.io
  interval?: string; // Defaults to 5m
  id?: string;
}

/**
 * Configuration interface for Cert-Manager HelmRelease
 */
export interface CertManagerHelmReleaseConfig {
  name: string;
  namespace?: string;
  repositoryName?: string; // Name of the HelmRepository to reference
  version?: string; // Chart version
  values?: CertManagerHelmValues;
  id?: string;
}

/**
 * Cert-Manager Helm values interface
 * Based on the official cert-manager Helm chart values
 */
export interface CertManagerHelmValues {
  // Installation configuration
  installCRDs?: boolean; // Default: false (best practice is separate CRD installation)

  // Global configuration
  global?: {
    leaderElection?: {
      namespace?: string;
    };
    logLevel?: number;
    podSecurityPolicy?: {
      enabled?: boolean;
      useAppArmor?: boolean;
    };
  };

  // Replica configuration
  replicaCount?: number;

  // Deployment strategy
  strategy?: {
    type?: 'Recreate' | 'RollingUpdate';
    rollingUpdate?: {
      maxSurge?: number | string;
      maxUnavailable?: number | string;
    };
  };

  // Image configuration
  image?: {
    repository?: string;
    tag?: string;
    pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  };

  // Controller configuration
  controller?: {
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
    volumes?: Volume[];
    volumeMounts?: VolumeMount[];
    extraArgs?: string[]; // Additional arguments for cert-manager controller
    env?: EnvVar[];
    serviceAccount?: {
      create?: boolean;
      name?: string;
      annotations?: Record<string, string>;
    };
  };

  // Webhook configuration
  webhook?: {
    enabled?: boolean;
    replicaCount?: number;
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
    args?: string[];
    env?: EnvVar[];
    serviceAccount?: {
      create?: boolean;
      name?: string;
      annotations?: Record<string, string>;
    };
    config?: {
      apiVersion?: string;
      kind?: string;
      metadata?: {
        name?: string;
      };
      webhooks?: WebhookConfig[];
    };
    mutatingAdmissionWebhooks?: {
      failurePolicy?: 'Fail' | 'Ignore';
      admissionReviewVersions?: string[];
      timeoutSeconds?: number;
    };
    validatingAdmissionWebhooks?: {
      failurePolicy?: 'Fail' | 'Ignore';
      admissionReviewVersions?: string[];
      timeoutSeconds?: number;
    };
  };

  // CA Injector configuration
  cainjector?: {
    enabled?: boolean;
    replicaCount?: number;
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
    args?: string[];
    env?: EnvVar[];
    serviceAccount?: {
      create?: boolean;
      name?: string;
      annotations?: Record<string, string>;
    };
  };

  // ACME HTTP01 solver configuration
  acmesolver?: {
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
  };

  // Startup API check configuration
  startupapicheck?: {
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
    timeout?: string;
    backoffLimit?: number;
    jobAnnotations?: Record<string, string>;
    podAnnotations?: Record<string, string>;
  };

  // Monitoring configuration
  prometheus?: {
    enabled?: boolean;
    servicemonitor?: {
      enabled?: boolean;
      prometheusInstance?: string;
      targetPort?: number;
      path?: string;
      interval?: string;
      scrapeTimeout?: string;
      labels?: Record<string, string>;
      honorLabels?: boolean;
    };
  };

  // Additional custom values
  [key: string]: any;
}
