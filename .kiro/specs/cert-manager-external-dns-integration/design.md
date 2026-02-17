# Cert-Manager and External-DNS Integration Design

## Overview

This design document outlines the implementation of comprehensive cert-manager and external-dns support for TypeKro. The implementation follows the established factory ecosystem pattern from Cilium while incorporating key lessons learned from that implementation. This design addresses the specific requirements for certificate management and DNS automation with early integration testing and dual deployment strategy support.

**Key Design Improvements from Cilium Experience:**
1. **Early Integration Testing**: Integration tests are written immediately after type definitions, before implementations
2. **Dual Deployment Support**: Both kro and direct deployment strategies are supported and tested throughout
3. **Exact Resource Structure**: Factories represent exact Kubernetes resource structures with embedded readiness evaluators
4. **Simple Factory Abstractions**: Developer-friendly wrappers provide abstractions while maintaining type safety
5. **Status-Driven Endpoints**: Use actual resource status fields for integration endpoints rather than inferring from inputs

## Architecture

### Directory Structure

Following the established ecosystem pattern with improvements from Cilium experience:

```
src/factories/cert-manager/
├── index.ts                           # Main exports
├── types.ts                          # Type definitions
├── compositions/                     # Bootstrap compositions
│   ├── index.ts
│   └── cert-manager-bootstrap.ts    # Main bootstrap composition
└── resources/                       # CRD factory functions with embedded readiness evaluators
    ├── index.ts
    ├── helm.ts                     # Cert-manager-specific Helm wrappers
    ├── certificates.ts             # Certificate, CertificateRequest
    ├── issuers.ts                  # Issuer, ClusterIssuer
    └── challenges.ts               # Challenge, Order

src/factories/external-dns/
├── index.ts                           # Main exports
├── types.ts                          # Type definitions
├── compositions/                     # Bootstrap compositions
│   ├── index.ts
│   └── external-dns-bootstrap.ts    # Main bootstrap composition
└── resources/                       # Resource factory functions with embedded readiness evaluators
    ├── index.ts
    ├── helm.ts                     # External-DNS-specific Helm wrappers
    └── dns-endpoint.ts             # DNSEndpoint CRD (if needed)

src/factories/webapp/                  # Webapp integration composition (OPTIONAL - may be part of examples instead)
├── index.ts
├── types.ts
└── compositions/
    ├── index.ts
    └── webapp-with-certs.ts          # Complete webapp with cert-manager + external-dns

NOTE: The webapp composition may be implemented as an example in the examples/ directory rather than a separate factory ecosystem, following the pattern of existing examples like examples/complete-webapp.ts
```

**Key Design Principles:**
- **Reuse existing TypeKro factories** - wrap existing `helmRepository`, `helmRelease`, etc. with cert-manager/external-dns-specific configurations
- **Embed readiness evaluators** - co-locate readiness logic with factory functions following established Cilium pattern
- **Status-driven integration** - use actual resource status fields for endpoints and integration points (not inferred values)
- **Early integration testing** - write integration tests immediately after type definitions, before implementations
- **Dual deployment support** - ensure both direct and kro factories work throughout development
- **Follow TypeKro conventions** - use established patterns from shared.ts and existing ecosystems

### Core Components

#### 1. Cert-Manager Bootstrap Composition (`cert-manager-bootstrap.ts`)

The main bootstrap composition that deploys cert-manager via Helm with comprehensive configuration options and status outputs derived from actual resource status.

#### 2. External-DNS Bootstrap Composition (`external-dns-bootstrap.ts`)

The main bootstrap composition that deploys external-dns via Helm with DNS provider configuration and status outputs derived from actual resource status.

#### 3. CRD Factory Functions

Type-safe factory functions for cert-manager CRDs with embedded readiness evaluators:

- **Certificates**: Certificate lifecycle management with renewal tracking
- **Issuers**: Certificate authority configuration (ACME, CA, Vault, Venafi)
- **Challenges**: ACME challenge handling (HTTP01, DNS01)
- **Orders**: ACME order lifecycle tracking

#### 4. Helm Integration Wrappers

Ecosystem-specific wrappers around existing TypeKro Helm factories that provide:
- Ecosystem-specific default configurations (repository URLs, chart names, etc.)
- Type-safe configuration interfaces for Helm values
- Validation specific to cert-manager and external-dns deployment requirements
- Reuse of existing Helm readiness evaluators

#### 5. Webapp Integration Composition

A comprehensive composition demonstrating the integration of cert-manager and external-dns for complete web application deployment with automated certificate management and DNS configuration.

## Components and Interfaces

### Cert-Manager Bootstrap Composition Interface

```typescript
interface CertManagerBootstrapConfig {
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
  installCRDs?: boolean;  // Note: Best practice is to install CRDs separately
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
    args?: string[];
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

interface CertManagerBootstrapStatus {
  // Overall status
  phase: 'Installing' | 'Ready' | 'Failed' | 'Upgrading';
  ready: boolean;
  version: string;
  
  // Component readiness (derived from actual resource status)
  controllerReady: boolean;
  webhookReady: boolean;
  cainjectorReady: boolean;
  
  // Integration endpoints (derived from actual service status)
  endpoints: {
    webhook: string;        // From webhook service status: `https://${webhookService.status.clusterIP}:10250/mutate`
    metrics: string;        // From controller service status: `http://${controllerService.status.clusterIP}:9402/metrics`
    healthz: string;        // From controller service status: `http://${controllerService.status.clusterIP}:9402/healthz`
  };
  
  // CRD status
  crds: {
    installed: boolean;
    version: string;
    count: number;
  };
  
  // Certificate authority readiness
  issuers: {
    ready: number;
    total: number;
  };
  
  // Certificate status summary
  certificates: {
    ready: number;
    total: number;
    expiringSoon: number;  // Certificates expiring within 30 days
  };
}
```

### External-DNS Bootstrap Composition Interface

```typescript
interface ExternalDnsBootstrapConfig {
  // Basic configuration
  name: string;
  namespace?: string;
  version?: string;
  
  // Provider configuration (following current external-dns helm chart structure)
  provider: {
    name: 'aws' | 'azure' | 'cloudflare' | 'google' | 'digitalocean' | 'linode' | 'rfc2136' | 'webhook' | 'akamai' | 'ns1' | 'plural';
    // Provider-specific configuration using new provider.{name}.{key} structure
    aws?: {
      region?: string;
      zoneType?: 'public' | 'private';
      assumeRole?: string;
      batchChangeSize?: number;
      batchChangeInterval?: string;
      evaluateTargetHealth?: boolean;
      preferCNAME?: boolean;
      zoneTagFilter?: Record<string, string>;
      credentials?: {
        secretName: string;
        accessKeyIdKey?: string;
        secretAccessKeyKey?: string;
      };
    };
    azure?: {
      resourceGroup?: string;
      tenantId?: string;
      subscriptionId?: string;
      aadClientId?: string;
      aadClientSecret?: string;
      useManagedIdentityExtension?: boolean;
      userAssignedIdentityID?: string;
      credentials?: {
        secretName: string;
        clientIdKey?: string;
        clientSecretKey?: string;
        tenantIdKey?: string;
        subscriptionIdKey?: string;
      };
    };
    cloudflare?: {
      apiToken?: string;
      apiKey?: string;
      email?: string;
      proxied?: boolean;
      credentials?: {
        secretName: string;
        apiTokenKey?: string;
        apiKeyKey?: string;
        emailKey?: string;
      };
    };
    google?: {
      project?: string;
      serviceAccountSecret?: string;
      batchChangeSize?: number;
      batchChangeInterval?: string;
      credentials?: {
        secretName: string;
        serviceAccountKey?: string;
      };
    };
  };
  
  // Domain configuration
  domainFilters?: string[];
  excludeDomains?: string[];
  regexDomainFilter?: string;
  regexDomainExclusion?: string;
  
  // Ownership configuration
  txtOwnerId?: string;
  txtPrefix?: string;
  txtSuffix?: string;
  
  // Source configuration
  sources?: ('service' | 'ingress' | 'node' | 'pod' | 'istio-gateway' | 'istio-virtualservice' | 'crd')[];
  
  // Policy configuration
  policy?: 'sync' | 'upsert-only' | 'create-only';
  registry?: 'txt' | 'aws-sd' | 'noop';
  
  // Sync configuration
  interval?: string;
  triggerLoopOnEvent?: boolean;
  
  // Deployment configuration
  replicaCount?: number;
  image?: {
    repository?: string;
    tag?: string;
    pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  };
  
  // Resource configuration
  resources?: ResourceRequirements;
  nodeSelector?: Record<string, string>;
  tolerations?: Toleration[];
  affinity?: Affinity;
  
  // Security configuration
  securityContext?: SecurityContext;
  containerSecurityContext?: SecurityContext;
  podSecurityContext?: SecurityContext;
  
  // Service account configuration
  serviceAccount?: {
    create?: boolean;
    name?: string;
    annotations?: Record<string, string>;
  };
  
  // RBAC configuration
  rbac?: {
    create?: boolean;
    additionalPermissions?: RBACRule[];
  };
  
  // Monitoring configuration
  metrics?: {
    enabled?: boolean;
    port?: number;
    serviceMonitor?: {
      enabled?: boolean;
      additionalLabels?: Record<string, string>;
      interval?: string;
      scrapeTimeout?: string;
    };
  };
  
  // Logging configuration
  logLevel?: 'panic' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  logFormat?: 'text' | 'json';
  
  // Advanced configuration
  dryRun?: boolean;
  annotationFilter?: string;
  labelFilter?: string;
  ingressClass?: string;
  
  // Custom Helm values override
  customValues?: Record<string, any>;
  
  // TypeKro specific
  id?: string;
}

interface ExternalDnsBootstrapStatus {
  // Overall status
  phase: 'Installing' | 'Ready' | 'Failed' | 'Upgrading';
  ready: boolean;
  version: string;
  
  // Component readiness (derived from actual deployment status)
  deploymentReady: boolean;
  
  // Provider status (derived from actual external-dns logs/metrics)
  provider: {
    name: string;
    connected: boolean;
    lastSync: string;
    errors: number;
  };
  
  // DNS management status (derived from actual external-dns metrics)
  dns: {
    managedDomains: string[];
    recordsManaged: number;
    recordsCreated: number;
    recordsUpdated: number;
    recordsDeleted: number;
    lastSyncDuration: string;
  };
  
  // Integration endpoints (derived from actual service status)
  endpoints: {
    metrics: string;        // From external-dns service status: `http://${externalDnsService.status.clusterIP}:7979/metrics`
    healthz: string;        // From external-dns service status: `http://${externalDnsService.status.clusterIP}:7979/healthz`
  };
  
  // Configuration status
  configuration: {
    policy: string;
    registry: string;
    txtOwnerId: string;
    interval: string;
    dryRun: boolean;
  };
}
```

### CRD Factory Interfaces

#### Certificate Resources

```typescript
// Certificate (following cert-manager.io/v1 API)
interface CertificateConfig {
  name: string;
  namespace?: string;
  spec: {
    // Required fields
    secretName: string;
    issuerRef: {
      name: string;
      kind: 'Issuer' | 'ClusterIssuer';
      group?: string;  // Defaults to cert-manager.io
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
    duration?: string;  // e.g., "2160h" (90 days)
    renewBefore?: string;  // e.g., "360h" (15 days)
    
    // Key usage
    usages?: (
      'signing' | 'digital signature' | 'content commitment' | 
      'key encipherment' | 'key agreement' | 'data encipherment' | 
      'cert sign' | 'crl sign' | 'encipher only' | 'decipher only' | 
      'any' | 'server auth' | 'client auth' | 'code signing' | 
      'email protection' | 's/mime' | 'ipsec end system' | 
      'ipsec tunnel' | 'ipsec user' | 'timestamping' | 'ocsp signing' | 
      'microsoft sgc' | 'netscape sgc'
    )[];
    
    // Private key configuration
    privateKey?: {
      algorithm?: 'RSA' | 'ECDSA' | 'Ed25519';
      encoding?: 'PKCS1' | 'PKCS8';
      size?: number;  // RSA: 2048, 3072, 4096; ECDSA: 256, 384, 521
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

// ClusterIssuer (following cert-manager.io/v1 API)
interface ClusterIssuerConfig {
  name: string;
  spec: {
    // ACME issuer (Let's Encrypt, etc.)
    acme?: {
      server: string;  // e.g., "https://acme-v02.api.letsencrypt.org/directory"
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
            secretAccessKeySecretRef?: {
              name: string;
              key: string;
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
            environment?: 'AzurePublicCloud' | 'AzureChinaCloud' | 'AzureGermanCloud' | 'AzureUSGovernmentCloud';
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
```

### Webapp Integration Composition Interface

```typescript
interface WebappWithCertsConfig {
  // Application configuration
  name: string;
  namespace?: string;
  domain: string;
  image: string;
  replicas?: number;
  port?: number;
  
  // Certificate configuration
  certificate?: {
    issuerRef?: {
      name: string;
      kind: 'Issuer' | 'ClusterIssuer';
    };
    additionalDomains?: string[];
    duration?: string;
    renewBefore?: string;
  };
  
  // DNS configuration
  dns?: {
    provider: 'aws' | 'azure' | 'cloudflare' | 'google';
    txtOwnerId?: string;
    annotations?: Record<string, string>;
  };
  
  // Ingress configuration
  ingress?: {
    className?: string;
    annotations?: Record<string, string>;
    tls?: boolean;
  };
  
  // Infrastructure dependencies
  infrastructure?: {
    certManagerNamespace?: string;
    externalDnsNamespace?: string;
    createIssuer?: boolean;
    issuerConfig?: ClusterIssuerConfig['spec'];
  };
  
  // TypeKro specific
  id?: string;
}

interface WebappWithCertsStatus {
  // Overall status
  ready: boolean;
  url: string;
  
  // Component readiness
  applicationReady: boolean;
  certificateReady: boolean;
  dnsReady: boolean;
  ingressReady: boolean;
  
  // Certificate status (derived from actual Certificate resource status)
  certificate: {
    issued: boolean;
    expirationDate: string;
    renewalDate: string;
    issuer: string;
    serialNumber: string;
  };
  
  // DNS status (derived from actual external-dns status)
  dns: {
    recordsCreated: string[];
    lastSync: string;
    provider: string;
  };
  
  // Application status (derived from actual Deployment status)
  application: {
    replicas: number;
    readyReplicas: number;
    version: string;
  };
}
```

## Data Models

### Core Type Definitions

```typescript
// Common Kubernetes types
interface ResourceRequirements {
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

interface Toleration {
  key?: string;
  operator?: 'Exists' | 'Equal';
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  tolerationSeconds?: number;
}

interface Affinity {
  nodeAffinity?: NodeAffinity;
  podAffinity?: PodAffinity;
  podAntiAffinity?: PodAntiAffinity;
}

interface SecurityContext {
  runAsUser?: number;
  runAsGroup?: number;
  runAsNonRoot?: boolean;
  fsGroup?: number;
  seLinuxOptions?: SELinuxOptions;
  windowsOptions?: WindowsSecurityContextOptions;
  fsGroupChangePolicy?: 'Always' | 'OnRootMismatch';
  supplementalGroups?: number[];
}

interface EnvVar {
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

interface Volume {
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

interface VolumeMount {
  name: string;
  mountPath: string;
  subPath?: string;
  readOnly?: boolean;
  mountPropagation?: 'None' | 'HostToContainer' | 'Bidirectional';
}

// Cert-manager specific types
interface WebhookConfig {
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

// External-DNS specific types
interface RBACRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
  resourceNames?: string[];
  nonResourceURLs?: string[];
}

// Certificate status types
interface CertificateCondition {
  type: 'Ready' | 'Issuing';
  status: 'True' | 'False' | 'Unknown';
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

interface CertificateStatus {
  conditions?: CertificateCondition[];
  lastFailureTime?: string;
  notAfter?: string;
  notBefore?: string;
  renewalTime?: string;
  revision?: number;
  nextPrivateKeySecretName?: string;
}

// Issuer status types
interface IssuerCondition {
  type: 'Ready';
  status: 'True' | 'False' | 'Unknown';
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

interface IssuerStatus {
  conditions?: IssuerCondition[];
  acme?: {
    uri?: string;
    lastRegisteredEmail?: string;
  };
}
```

## Error Handling

### Validation Errors

```typescript
class CertManagerConfigurationError extends TypeKroError {
  constructor(message: string, public configPath: string, public validationErrors: string[]) {
    super(`Cert-manager configuration error at ${configPath}: ${message}`, 'CERT_MANAGER_CONFIGURATION_ERROR', {
      configPath,
      validationErrors,
    });
  }
}

class ExternalDnsConfigurationError extends TypeKroError {
  constructor(message: string, public configPath: string, public validationErrors: string[]) {
    super(`External-DNS configuration error at ${configPath}: ${message}`, 'EXTERNAL_DNS_CONFIGURATION_ERROR', {
      configPath,
      validationErrors,
    });
  }
}

class CertificateValidationError extends TypeKroError {
  constructor(message: string, public certificateName: string, public namespace: string) {
    super(`Certificate validation error for ${certificateName} in ${namespace}: ${message}`, 'CERTIFICATE_VALIDATION_ERROR', {
      certificateName,
      namespace,
    });
  }
}
```

### Runtime Errors

```typescript
class CertificateIssuanceError extends TypeKroError {
  constructor(message: string, public certificateName: string, public issuerName: string, public challenge?: string) {
    super(`Certificate issuance error for ${certificateName} with issuer ${issuerName}: ${message}`, 'CERTIFICATE_ISSUANCE_ERROR', {
      certificateName,
      issuerName,
      challenge,
    });
  }
}

class DnsRecordError extends TypeKroError {
  constructor(message: string, public domain: string, public provider: string, public recordType: string) {
    super(`DNS record error for ${domain} with ${provider} (${recordType}): ${message}`, 'DNS_RECORD_ERROR', {
      domain,
      provider,
      recordType,
    });
  }
}

class WebappDeploymentError extends TypeKroError {
  constructor(message: string, public webappName: string, public component: string) {
    super(`Webapp deployment error for ${webappName} in component ${component}: ${message}`, 'WEBAPP_DEPLOYMENT_ERROR', {
      webappName,
      component,
    });
  }
}
```

## Testing Strategy

### Early Integration Testing Approach

**Core Principle:** Integration tests are written immediately after type definitions, before factory implementations. This ensures that functionality works end-to-end from the beginning and avoids the iteration issues experienced with Cilium.

### Test-Driven Development Workflow

1. **Define Types** → **Write Integration Test Scaffolds** → **Implement Factories** → **Validate with Real Deployments**
2. **Every factory function includes integration tests with both `kro` and `direct` deployment strategies**
3. **All tests use real Kubernetes clusters via `scripts/e2e-setup.sh`**
4. **Tests validate actual resource creation, not just factory instantiation**

### Unit Tests (Co-located with Implementation)

**Location**: `test/factories/cert-manager/` and `test/factories/external-dns/` directories

1. **Factory Function Tests**
   - Test each factory function as it's implemented
   - Validate resource creation with various configurations
   - Test TypeScript type safety and compilation
   - Test wrapper functions properly delegate to generic factories
   - Validate configuration schema and default values

2. **Configuration Validation Tests**
   - Test schema validation for each configuration interface
   - Test error handling for invalid configurations
   - Test default value application and override behavior
   - Test TypeScript type checking and IDE experience

3. **Status Expression Tests**
   - Test CEL expression generation for each status field
   - Test status field mapping and serialization using actual resource status
   - Test integration endpoint exposure derived from real service status
   - Validate cross-resource reference resolution

### Integration Tests (Written Before Implementation)

**Location**: `test/integration/cert-manager/` and `test/integration/external-dns/` directories
**Setup**: Use `scripts/e2e-setup.sh` for test cluster setup
**Execution**: Use `bun run test:integration` command

1. **Bootstrap Composition Integration Tests**
   - Test cert-manager bootstrap composition with real Helm deployments using `.deploy()` method
   - Test external-dns bootstrap composition with real Helm deployments using `.deploy()` method
   - Test BOTH `kro` and `direct` factory patterns
   - Validate complete installations and readiness evaluation
   - Test status reporting accuracy with live resources derived from actual resource status
   - **CRITICAL**: Test with `waitForReady: true` (no shortcuts)

2. **CRD Factory Integration Tests**
   - Test each CRD factory with actual Kubernetes API calls
   - Test certificate issuance with real ACME providers (Let's Encrypt staging)
   - Test DNS record creation with real DNS providers (or test providers)
   - Test readiness evaluation with real resource states
   - Test cross-resource dependencies and references

3. **Webapp Integration Tests**
   - Test complete webapp composition with real deployments using `.deploy()` method
   - Validate end-to-end certificate issuance and DNS record creation
   - Test with real ingress controllers and TLS termination
   - Test certificate renewal scenarios
   - Test DNS propagation and validation

### End-to-End Tests (Continuous Validation)

**Location**: `test/integration/webapp/` directory
**Setup**: Use `scripts/e2e-setup.sh` for test environment

1. **Complete Webapp Deployment Tests**
   - Deploy actual web applications with cert-manager and external-dns using `.deploy()` method
   - Validate HTTPS connectivity and certificate validity
   - Test DNS resolution and record propagation
   - Test certificate renewal and DNS updates

2. **Multi-Provider Tests**
   - Test with different DNS providers (AWS Route53, Cloudflare, etc.)
   - Test with different certificate authorities (Let's Encrypt, private CA)
   - Test provider isolation and conflict prevention

3. **Failure and Recovery Tests**
   - Test certificate issuance failures and recovery
   - Test DNS provider failures and fallback
   - Test application deployment failures and rollback

### Testing Infrastructure Requirements

1. **Test Cluster Management**
   - Use `scripts/e2e-setup.sh` for automated cluster setup
   - Automated test cluster provisioning and cleanup
   - Support for multiple Kubernetes versions
   - Isolated test environments for parallel testing
   - Resource cleanup and state management

2. **External Service Integration**
   - Test DNS providers (using test domains or staging environments)
   - Test certificate authorities (using Let's Encrypt staging)
   - Mock external services for unit tests
   - Real external services for integration tests

3. **Test Data and Fixtures**
   - Comprehensive test configuration sets
   - Real-world scenario test cases
   - Error condition and edge case scenarios
   - Certificate and DNS provider test credentials

## Implementation Phases

### Phase 1: Foundation with Early Integration Testing
- Set up directory structures for both cert-manager and external-dns
- Define comprehensive type interfaces
- **IMMEDIATELY** create integration test scaffolds for all planned functionality
- Implement Helm integration wrappers with embedded readiness evaluators
- Validate basic deployment end-to-end with both kro and direct strategies

### Phase 2: Cert-Manager Bootstrap with Live Testing
- Implement complete cert-manager bootstrap composition using kubernetesComposition
- Add comprehensive configuration schema and Helm values mapping
- Implement CEL-based status expressions using actual resource status fields
- Test with real cert-manager deployments in test clusters
- Validate CRD installation and controller readiness

### Phase 3: External-DNS Bootstrap with Live Testing
- Implement complete external-dns bootstrap composition using kubernetesComposition
- Add comprehensive DNS provider configuration and validation
- Implement CEL-based status expressions using actual resource status fields
- Test with real external-dns deployments in test clusters
- Validate DNS provider connectivity and record management

### Phase 4: Certificate CRD Factories with Real Certificate Testing
- Implement Certificate, ClusterIssuer, and Issuer factories with embedded readiness evaluators
- Test each CRD with real Kubernetes API interactions
- Validate certificate issuance with Let's Encrypt staging environment
- Test readiness evaluation with actual certificate lifecycle events
- Ensure seamless integration with existing TypeKro features

### Phase 5: Webapp Integration Composition with End-to-End Testing
- Implement comprehensive webapp composition demonstrating cert-manager + external-dns integration
- Test complete end-to-end scenarios with real applications
- Validate HTTPS connectivity, certificate validity, and DNS resolution
- Test certificate renewal and DNS update scenarios
- Create comprehensive documentation with working examples

**Key Principle:** Each phase includes complete functional testing validation with real Kubernetes clusters and external services before proceeding to the next phase. No implementation is considered complete without working end-to-end tests.

## Performance Considerations

### Resource Creation Optimization
- Lazy evaluation of complex configurations
- Efficient CEL expression generation using actual resource status
- Minimal resource overhead
- Optimized Helm values mapping

### Certificate and DNS Management Optimization
- Efficient certificate renewal tracking
- Batched DNS record updates
- Caching of certificate and DNS status
- Optimized readiness checking intervals

### Memory Usage
- Efficient type definitions
- Minimal runtime overhead
- Proper resource cleanup
- Optimized status field derivation from actual resources

## Security Considerations

### Certificate Security
- Secure private key handling
- Certificate rotation and renewal
- Proper secret management
- RBAC for certificate resources

### DNS Security
- Secure DNS provider credential handling
- Domain ownership validation
- DNS record conflict prevention
- Provider isolation

### Webapp Security
- TLS configuration validation
- Certificate chain validation
- Secure ingress configuration
- Security header configuration

## Monitoring and Observability

### Metrics Exposure
- Expose cert-manager metrics through status (derived from actual service endpoints)
- Expose external-dns metrics through status (derived from actual service endpoints)
- Certificate expiration monitoring
- DNS record management metrics

### Logging Integration
- Structured logging for all operations
- Certificate issuance tracking
- DNS record change tracking
- Error tracking and reporting

### Alerting Integration
- Certificate expiration alerts
- DNS record failure alerts
- Component health monitoring
- Performance threshold alerts

## Future Extensibility

### Template Pattern
This implementation serves as a template for future ecosystem integrations:

1. **Directory Structure**: Consistent organization pattern with embedded readiness evaluators
2. **Configuration Schema**: Comprehensive type-safe configuration with ArkType integration
3. **Status Outputs**: CEL-based integration points using actual resource status fields
4. **Early Integration Testing**: Integration tests written before implementation
5. **Dual Deployment Support**: Both kro and direct strategies supported throughout
6. **Error Handling**: Structured error types and messages with clear troubleshooting
7. **Documentation**: Clear API documentation with working examples and real deployments

**Key Template Principles:**
- **Status-driven integration**: Use actual resource status fields for endpoints and integration points
- **Early testing**: Write integration tests immediately after type definitions
- **Dual deployment**: Support both kro and direct strategies from the beginning
- **Real-world validation**: All examples and tests use actual deployments, not mocks
- **Embedded readiness**: Readiness evaluators co-located with factory functions

### Ecosystem Roadmap
Following this pattern, future ecosystems can be implemented:

- **ArgoCD**: GitOps and application delivery with certificate management
- **Istio**: Service mesh with automatic certificate provisioning
- **Prometheus**: Monitoring with TLS and DNS integration
- **Vault**: Secret management with certificate authority integration
- **Grafana**: Observability with automated certificate and DNS setup

Each ecosystem will follow the same structural patterns while providing ecosystem-specific functionality and integration points, with early integration testing and status-driven endpoints.

## Critical Implementation Requirements

### Development Standards Compliance
This implementation MUST follow all established TypeKro development standards:

1. **Production Quality from Day One**: No placeholder implementations, TODO comments, or incomplete features
2. **Context-First Development**: Understand existing patterns before implementing new ones
3. **Fix Root Problems**: Address underlying issues, not symptoms
4. **Type Safety**: No `any` types without explicit justification, all factories return `Enhanced<TSpec, TStatus>`
5. **Testing Standards**: Integration tests use real deployments with `.deploy()` method, no type assertions in tests

### TypeKro Pattern Compliance
1. **Factory Creation**: Use `createResource` from `shared.ts` for all resource factories
2. **Readiness Evaluators**: Embed in factory files, use `withReadinessEvaluator()` method
3. **Export Structure**: Follow Cilium ecosystem pattern for consistency
4. **ArkType Schemas**: Follow KroCompatibleType constraints (basic types, nested objects, optional fields only)
5. **Status Expressions**: Use JavaScript expressions that auto-convert to CEL, reference actual resource status

## Key Design Decisions

### 1. Follow Established TypeKro Patterns
- **Decision**: Use the same factory creation patterns as existing ecosystems (Cilium, Kubernetes)
- **Rationale**: Maintains consistency with established TypeKro conventions and shared utilities
- **Implementation**: Use `createResource` from `shared.ts`, follow same export patterns, use same readiness evaluator embedding approach

### 2. Status-Driven Integration Points
- **Decision**: Use actual resource status fields for integration endpoints rather than inferring from inputs
- **Rationale**: Provides accurate, real-time integration information based on actual resource state
- **Implementation**: CEL expressions reference actual service status, deployment status, etc.

### 2. Early Integration Testing Strategy
- **Decision**: Write integration tests immediately after type definitions, before implementations
- **Rationale**: Avoids the iteration issues experienced with Cilium implementation
- **Implementation**: Test scaffolds created with type definitions, validated with real deployments

### 3. Dual Deployment Strategy Support
- **Decision**: Support both kro and direct deployment strategies throughout development
- **Rationale**: Ensures compatibility and prevents deployment strategy lock-in
- **Implementation**: All tests validate both strategies, all factories support both patterns

### 4. Embedded Readiness Evaluators
- **Decision**: Co-locate readiness evaluators with factory functions
- **Rationale**: Simplifies maintenance and ensures readiness logic stays synchronized with factory logic
- **Implementation**: Readiness evaluators defined in the same files as factory functions

### 5. Comprehensive Webapp Composition
- **Decision**: Create a complete webapp composition demonstrating cert-manager + external-dns integration
- **Rationale**: Provides a practical example and validates the integration patterns
- **Implementation**: End-to-end composition with real certificate issuance and DNS management

This design addresses all the lessons learned from the Cilium implementation while providing comprehensive support for certificate management and DNS automation in TypeKro.