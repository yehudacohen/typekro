# Networking API

TypeKro provides simple factory functions for creating Kubernetes networking resources with type safety and intelligent readiness evaluation. These functions simplify common networking patterns while maintaining full TypeScript support.

## Overview

TypeKro networking factories provide:
- **Simplified service configuration** with sensible defaults
- **Type-safe network policy creation**
- **Ingress configuration with schema references**
- **Cross-resource networking patterns**

All networking factories return `Enhanced<TSpec, TStatus>` objects that integrate seamlessly with workloads and other resources.

## Core Networking Types

### `simpleService()`

Creates a Kubernetes Service with simplified configuration.

```typescript
function simpleService(config: SimpleServiceConfig): Enhanced<V1ServiceSpec, V1ServiceStatus>
```

#### Parameters

- **`config`**: Simplified service configuration

```typescript
interface SimpleServiceConfig {
  name: string;
  selector: Record<string, string | RefOrValue<string>>;
  ports: Array<{ port: number; targetPort?: number; name?: string }>;
  type?: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  clusterIP?: string;
}
```

#### Returns

Enhanced Service with automatic readiness evaluation based on service type.

#### Example: ClusterIP Service

```typescript
import { toResourceGraph, simpleService, simpleDeployment, type } from 'typekro';

const WebAppSpec = type({
  name: 'string',
  image: 'string'
});

const webService = toResourceGraph(
  {
    name: 'web-service',
    apiVersion: 'example.com/v1',
    kind: 'WebService',
    spec: WebAppSpec,
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      ports: [80]
    }),

    service: simpleService({
      name: schema.spec.name,
      selector: { app: schema.spec.name },  // Matches deployment labels
      ports: [{ port: 80, targetPort: 80 }],
      type: 'ClusterIP'
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.deployment.status.readyReplicas, ' > 0')
  })
);
```

#### Example: LoadBalancer Service

```typescript
const publicService = simpleService({
  name: 'api-public',
  selector: { app: 'api' },
  ports: [
    { port: 443, targetPort: 8443, name: 'https' },
    { port: 80, targetPort: 8080, name: 'http' }
  ],
  type: 'LoadBalancer'
});
```

#### Readiness Logic

- **ClusterIP/NodePort**: Always ready when created
- **LoadBalancer**: Ready when external IP/hostname is assigned
- **ExternalName**: Ready when externalName is configured

### `simpleIngress()`

Creates a Kubernetes Ingress with simplified configuration for HTTP/HTTPS traffic routing.

```typescript
function simpleIngress(config: SimpleIngressConfig): Enhanced<V1IngressSpec, V1IngressStatus>
```

#### Parameters

- **`config`**: Simplified ingress configuration

```typescript
interface SimpleIngressConfig {
  name: string;
  host: string;
  serviceName: string | RefOrValue<string>;
  servicePort: number;
  path?: string;
  tls?: boolean;
  ingressClassName?: string;
}
```

#### Returns

Enhanced Ingress with automatic readiness evaluation.

#### Example: Basic HTTP Ingress

```typescript
import { toResourceGraph, simpleIngress, simpleService, simpleDeployment, type } from 'typekro';

const WebAppSpec = type({
  name: 'string',
  host: 'string'
});

const webIngress = toResourceGraph(
  {
    name: 'web-ingress',
    apiVersion: 'example.com/v1',
    kind: 'WebIngress',
    spec: WebAppSpec,
    status: type({ url: 'string' })
  },
  (schema) => ({
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: 'nginx:1.21',
      ports: [80]
    }),

    service: simpleService({
      name: schema.spec.name,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 80 }]
    }),

    ingress: simpleIngress({
      name: schema.spec.name,
      host: schema.spec.host,                    // Schema reference
      serviceName: schema.spec.name,             // References service above
      servicePort: 80,
      path: '/',
      ingressClassName: 'nginx'
    })
  }),
  (schema, resources) => ({
    url: Cel.template('http://%s', schema.spec.host)
  })
);
```

#### Example: HTTPS Ingress with TLS

```typescript
import { ingress, secret } from 'typekro';

const httpsIngress = createResourceGraph('https-ingress', (schema) => {
  const tlsSecret = secret({
    metadata: { name: 'web-tls-cert' },
    type: 'kubernetes.io/tls',
    data: {
      'tls.crt': 'LS0tLS1CRUdJTi...', // Base64 encoded certificate
      'tls.key': 'LS0tLS1CRUdJTi...'  // Base64 encoded private key
    }
  });

  const secureIngress = ingress({
    metadata: {
      name: 'secure-web-ingress',
      annotations: {
        'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
        'nginx.ingress.kubernetes.io/ssl-redirect': 'true'
      }
    },
    spec: {
      ingressClassName: 'nginx',
      tls: [{
        hosts: ['secure.example.com'],
        secretName: tlsSecret.metadata.name
      }],
      rules: [{
        host: 'secure.example.com',
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: {
              service: {
                name: 'web-service',
                port: { number: 80 }
              }
            }
          }]
        }
      }]
    }
  });

  return { tlsSecret, ingress: secureIngress };
});
```

#### Readiness Logic

- **Ready**: When `status.loadBalancer.ingress` has at least one endpoint
- **Not Ready**: When waiting for load balancer assignment

### `networkPolicy()`

Creates a Kubernetes NetworkPolicy for traffic control and security.

```typescript
function networkPolicy(resource: V1NetworkPolicy): Enhanced<V1NetworkPolicySpec, unknown>
```

#### Parameters

- **`resource`**: Kubernetes NetworkPolicy specification following the `V1NetworkPolicy` interface

#### Returns

Enhanced NetworkPolicy that is ready when created (configuration-only resource).

#### Example: Namespace Isolation

```typescript
import { networkPolicy } from 'typekro';

const namespaceIsolation = networkPolicy({
  metadata: {
    name: 'default-deny-all',
    namespace: 'production'
  },
  spec: {
    podSelector: {}, // Select all pods in namespace
    policyTypes: ['Ingress', 'Egress'],
    ingress: [],     // Deny all ingress
    egress: []       // Deny all egress
  }
});
```

#### Example: Database Access Policy

```typescript
import { networkPolicy } from 'typekro';

const databaseAccess = networkPolicy({
  metadata: {
    name: 'database-access-policy',
    namespace: 'production'
  },
  spec: {
    podSelector: {
      matchLabels: { app: 'postgres' }
    },
    policyTypes: ['Ingress'],
    ingress: [{
      from: [
        {
          podSelector: {
            matchLabels: { tier: 'backend' }
          }
        },
        {
          namespaceSelector: {
            matchLabels: { name: 'monitoring' }
          }
        }
      ],
      ports: [{
        protocol: 'TCP',
        port: 5432
      }]
    }]
  }
});
```

#### Example: Multi-tier Application Policy

```typescript
import { networkPolicy } from 'typekro';

const multiTierPolicies = createResourceGraph('multi-tier-policies', (schema) => {
  // Frontend can receive traffic from anywhere
  const frontendPolicy = networkPolicy({
    metadata: { name: 'frontend-policy' },
    spec: {
      podSelector: { matchLabels: { tier: 'frontend' } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{
        ports: [{ protocol: 'TCP', port: 80 }]
      }],
      egress: [{
        to: [{ podSelector: { matchLabels: { tier: 'backend' } } }],
        ports: [{ protocol: 'TCP', port: 8080 }]
      }]
    }
  });

  // Backend can only receive from frontend
  const backendPolicy = networkPolicy({
    metadata: { name: 'backend-policy' },
    spec: {
      podSelector: { matchLabels: { tier: 'backend' } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{
        from: [{ podSelector: { matchLabels: { tier: 'frontend' } } }],
        ports: [{ protocol: 'TCP', port: 8080 }]
      }],
      egress: [{
        to: [{ podSelector: { matchLabels: { tier: 'database' } } }],
        ports: [{ protocol: 'TCP', port: 5432 }]
      }]
    }
  });

  // Database can only receive from backend
  const databasePolicy = networkPolicy({
    metadata: { name: 'database-policy' },
    spec: {
      podSelector: { matchLabels: { tier: 'database' } },
      policyTypes: ['Ingress'],
      ingress: [{
        from: [{ podSelector: { matchLabels: { tier: 'backend' } } }],
        ports: [{ protocol: 'TCP', port: 5432 }]
      }]
    }
  });

  return { 
    frontend: frontendPolicy, 
    backend: backendPolicy, 
    database: databasePolicy 
  };
});
```

#### Readiness Logic

- **Always Ready**: NetworkPolicies are configuration objects applied by the CNI plugin

## Additional Networking Components

### `endpoints()`

Creates Kubernetes Endpoints for manual service endpoint management.

```typescript
function endpoints(resource: V1Endpoints): Enhanced<V1Endpoints, object>
```

#### Example

```typescript
import { endpoints, service } from 'typekro';

const manualEndpoints = createResourceGraph('manual-endpoints', (schema) => {
  const svc = service({
    metadata: { name: 'external-api' },
    spec: {
      type: 'ClusterIP',
      ports: [{ port: 80, targetPort: 80 }]
      // No selector - manual endpoints
    }
  });

  const eps = endpoints({
    metadata: { name: svc.metadata.name },
    subsets: [{
      addresses: [
        { ip: '10.0.1.100' },
        { ip: '10.0.1.101' }
      ],
      ports: [{ port: 80, protocol: 'TCP' }]
    }]
  });

  return { service: svc, endpoints: eps };
});
```

### `ingressClass()`

Creates an IngressClass for configuring Ingress controllers.

```typescript
function ingressClass(resource: V1IngressClass): Enhanced<V1IngressClassSpec, unknown>
```

#### Example

```typescript
import { ingressClass } from 'typekro';

const customIngressClass = ingressClass({
  metadata: {
    name: 'custom-nginx',
    annotations: {
      'ingressclass.kubernetes.io/is-default-class': 'false'
    }
  },
  spec: {
    controller: 'k8s.io/ingress-nginx',
    parameters: {
      apiGroup: 'networking.k8s.io',
      kind: 'IngressClass',
      name: 'nginx-configuration'
    }
  }
});
```

## Advanced Patterns

### Service Discovery with Cross-References

Services can reference deployments and be referenced by ingress resources:

```typescript
import { deployment, service, ingress, Cel } from 'typekro';

const fullStackApp = createResourceGraph('full-stack-app', (schema) => {
  const backend = deployment({
    metadata: { name: 'api-server' },
    spec: {
      replicas: 3,
      selector: { matchLabels: { app: 'api' } },
      template: {
        metadata: { labels: { app: 'api' } },
        spec: {
          containers: [{
            name: 'api',
            image: 'myapp/api:v1.0',
            ports: [{ containerPort: 8080 }]
          }]
        }
      }
    }
  });

  const backendService = service({
    metadata: { name: 'api-service' },
    spec: {
      selector: { app: 'api' },
      ports: [{ port: 80, targetPort: 8080 }]
    }
  });

  const apiIngress = ingress({
    metadata: { name: 'api-ingress' },
    spec: {
      rules: [{
        host: 'api.example.com',
        http: {
          paths: [{
            path: '/api',
            pathType: 'Prefix',
            backend: {
              service: {
                name: backendService.metadata.name,
                port: { number: 80 }
              }
            }
          }]
        }
      }]
    }
  });

  return {
    deployment: backend,
    service: backendService,
    ingress: apiIngress,
    status: {
      // Compute service endpoint from cluster IP
      internalEndpoint: Cel.template(
        'http://%{ip}:%{port}',
        {
          ip: backendService.spec.clusterIP,
          port: backendService.spec.ports[0].port
        }
      ),
      
      // Compute external endpoint from ingress
      externalEndpoint: Cel.conditional(
        Cel.expr('size(', apiIngress.status.loadBalancer.ingress, ') > 0'),
        Cel.template(
          'https://%{host}/api',
          { host: apiIngress.spec.rules[0].host }
        ),
        'pending'
      )
    }
  };
});
```

### Load Balancer with Health Checks

Configure advanced load balancer features:

```typescript
import { service } from 'typekro';

const advancedLB = service({
  metadata: {
    name: 'advanced-loadbalancer',
    annotations: {
      // AWS-specific annotations
      'service.beta.kubernetes.io/aws-load-balancer-type': 'nlb',
      'service.beta.kubernetes.io/aws-load-balancer-backend-protocol': 'tcp',
      'service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled': 'true',
      'service.beta.kubernetes.io/aws-load-balancer-healthcheck-healthy-threshold': '2',
      'service.beta.kubernetes.io/aws-load-balancer-healthcheck-unhealthy-threshold': '2',
      'service.beta.kubernetes.io/aws-load-balancer-healthcheck-interval': '10',
      'service.beta.kubernetes.io/aws-load-balancer-healthcheck-timeout': '6',
      'service.beta.kubernetes.io/aws-load-balancer-healthcheck-port': '8080',
      'service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol': 'HTTP',
      'service.beta.kubernetes.io/aws-load-balancer-healthcheck-path': '/health'
    }
  },
  spec: {
    type: 'LoadBalancer',
    selector: { app: 'web' },
    ports: [{
      name: 'http',
      port: 80,
      targetPort: 8080,
      protocol: 'TCP'
    }],
    externalTrafficPolicy: 'Local',
    sessionAffinity: 'ClientIP'
  }
});
```

### Ingress with Multiple Backends

Configure ingress with path-based routing:

```typescript
import { ingress, service } from 'typekro';

const multiServiceIngress = createResourceGraph('multi-service', (schema) => {
  const apiService = service({
    metadata: { name: 'api-service' },
    spec: {
      selector: { app: 'api' },
      ports: [{ port: 80, targetPort: 8080 }]
    }
  });

  const webService = service({
    metadata: { name: 'web-service' },
    spec: {
      selector: { app: 'web' },
      ports: [{ port: 80, targetPort: 3000 }]
    }
  });

  const multiIngress = ingress({
    metadata: {
      name: 'multi-service-ingress',
      annotations: {
        'nginx.ingress.kubernetes.io/rewrite-target': '/$2',
        'nginx.ingress.kubernetes.io/configuration-snippet': |
          rewrite ^(/api)$ $1/ redirect;
          rewrite ^(/web)$ $1/ redirect;
      }
    },
    spec: {
      ingressClassName: 'nginx',
      rules: [{
        host: 'app.example.com',
        http: {
          paths: [
            {
              path: '/api(/|$)(.*)',
              pathType: 'ImplementationSpecific',
              backend: {
                service: {
                  name: apiService.metadata.name,
                  port: { number: 80 }
                }
              }
            },
            {
              path: '/web(/|$)(.*)',
              pathType: 'ImplementationSpecific',
              backend: {
                service: {
                  name: webService.metadata.name,
                  port: { number: 80 }
                }
              }
            },
            {
              path: '/',
              pathType: 'Prefix',
              backend: {
                service: {
                  name: webService.metadata.name,
                  port: { number: 80 }
                }
              }
            }
          ]
        }
      }]
    }
  });

  return { 
    apiService, 
    webService, 
    ingress: multiIngress 
  };
});
```

### Network Segmentation Strategy

Implement comprehensive network security:

```typescript
import { networkPolicy, namespace } from 'typekro';

const networkSegmentation = createResourceGraph('network-security', (schema) => {
  // Default deny-all policy
  const defaultDeny = networkPolicy({
    metadata: { name: 'default-deny-all' },
    spec: {
      podSelector: {},
      policyTypes: ['Ingress', 'Egress']
    }
  });

  // Allow DNS resolution
  const allowDNS = networkPolicy({
    metadata: { name: 'allow-dns' },
    spec: {
      podSelector: {},
      policyTypes: ['Egress'],
      egress: [{
        to: [{
          namespaceSelector: {
            matchLabels: { name: 'kube-system' }
          },
          podSelector: {
            matchLabels: { 'k8s-app': 'kube-dns' }
          }
        }],
        ports: [
          { protocol: 'UDP', port: 53 },
          { protocol: 'TCP', port: 53 }
        ]
      }]
    }
  });

  // Allow ingress controller access
  const allowIngress = networkPolicy({
    metadata: { name: 'allow-ingress' },
    spec: {
      podSelector: {
        matchLabels: { 'network-policy': 'ingress-allowed' }
      },
      policyTypes: ['Ingress'],
      ingress: [{
        from: [{
          namespaceSelector: {
            matchLabels: { name: 'ingress-nginx' }
          }
        }]
      }]
    }
  });

  return { 
    defaultDeny, 
    allowDNS, 
    allowIngress 
  };
});
```

## Type Definitions

### Input Types

```typescript
import type {
  V1Service,
  V1Ingress,
  V1NetworkPolicy,
  V1Endpoints,
  V1IngressClass
} from '@kubernetes/client-node';
```

### Enhanced Output Types

```typescript
import type { Enhanced } from 'typekro';

type EnhancedService = Enhanced<V1ServiceSpec, V1ServiceStatus>;
type EnhancedIngress = Enhanced<V1IngressSpec, V1IngressStatus>;
type EnhancedNetworkPolicy = Enhanced<V1NetworkPolicySpec, unknown>;
type EnhancedEndpoints = Enhanced<V1Endpoints, object>;
type EnhancedIngressClass = Enhanced<V1IngressClassSpec, unknown>;
```

## Best Practices

### 1. Service Configuration

Always specify appropriate service types and configurations:

```typescript
// Good: Explicit service configuration
const webService = service({
  metadata: { name: 'web-service' },
  spec: {
    type: 'ClusterIP',
    selector: { app: 'web' },
    ports: [{
      name: 'http',
      port: 80,
      targetPort: 8080,
      protocol: 'TCP'
    }],
    sessionAffinity: 'None'
  }
});
```

### 2. Ingress Best Practices

Use proper annotations and TLS configuration:

```typescript
// Good: Secure ingress with proper annotations
const secureIngress = ingress({
  metadata: {
    name: 'secure-ingress',
    annotations: {
      'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
      'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
      'nginx.ingress.kubernetes.io/force-ssl-redirect': 'true',
      'nginx.ingress.kubernetes.io/proxy-body-size': '10m'
    }
  },
  spec: {
    ingressClassName: 'nginx',
    tls: [{ hosts: ['app.example.com'], secretName: 'app-tls' }],
    rules: [{ /* rules */ }]
  }
});
```

### 3. Network Security

Implement least-privilege network policies:

```typescript
// Good: Specific ingress/egress rules
const restrictivePolicy = networkPolicy({
  metadata: { name: 'api-access-policy' },
  spec: {
    podSelector: { matchLabels: { app: 'api' } },
    policyTypes: ['Ingress', 'Egress'],
    ingress: [{
      from: [{ podSelector: { matchLabels: { tier: 'frontend' } } }],
      ports: [{ protocol: 'TCP', port: 8080 }]
    }],
    egress: [{
      to: [{ podSelector: { matchLabels: { app: 'database' } } }],
      ports: [{ protocol: 'TCP', port: 5432 }]
    }]
  }
});
```

### 4. Resource Naming

Use consistent and descriptive naming:

```typescript
// Good: Descriptive names with prefixes
const userApiService = service({
  metadata: { name: 'user-api-service' },
  // ...
});

const userApiIngress = ingress({
  metadata: { name: 'user-api-ingress' },
  // ...
});
```

## Related APIs

- [Workloads API](/api/factories/workloads) - Deployments and workloads that services expose
- [Configuration API](/api/factories/config) - ConfigMaps and Secrets for network configuration
- [RBAC API](/api/factories/rbac) - Service accounts and permissions
- [Types API](/api/types) - TypeScript type definitions
- [Direct Deployment Guide](/guide/direct-deployment) - Deploying complete network architectures