# RBAC API

RBAC (Role-Based Access Control) factory functions create Kubernetes security resources with type safety and intelligent permission management. These functions handle ServiceAccounts, Roles, RoleBindings, ClusterRoles, and ClusterRoleBindings.

## Overview

TypeKro RBAC factories provide:
- **Service account management** for pod identity
- **Role-based permissions** with fine-grained control
- **Cross-resource security bindings** between accounts and roles
- **Namespace and cluster-wide security patterns**

## Core RBAC Types

### `serviceAccount()`

Creates a Kubernetes ServiceAccount for pod identity and authentication.

```typescript
function serviceAccount(resource: V1ServiceAccount): Enhanced<V1ServiceAccountSpec, V1ServiceAccountStatus>
```

#### Example: Basic Service Account

```typescript
import { toResourceGraph, serviceAccount, simpleDeployment, type } from 'typekro';

const SecureAppSpec = type({
  name: 'string',
  permissions: 'string[]'
});

const secureApp = toResourceGraph(
  {
    name: 'secure-app',
    apiVersion: 'security.example.com/v1',
    kind: 'SecureApp',
    spec: SecureAppSpec,
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Service account for the application
    serviceAccount: serviceAccount({
      metadata: {
        name: schema.spec.name,
        labels: { app: schema.spec.name }
      },
      automountServiceAccountToken: true
    }),
    
    // Application using the service account
    app: simpleDeployment({
      name: schema.spec.name,
      image: 'myapp:latest',
      ports: [8080],
      serviceAccountName: schema.spec.name  // References service account above
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0')
  })
);
```

### `role()`

Creates a Kubernetes Role with namespace-scoped permissions.

```typescript
function role(resource: V1Role): Enhanced<V1RoleSpec, unknown>
```

#### Example: Application Role with Permissions

```typescript
import { toResourceGraph, role, roleBinding, serviceAccount, simpleDeployment, type } from 'typekro';

const MicroserviceSpec = type({
  name: 'string',
  needsConfigAccess: 'boolean',
  needsSecretAccess: 'boolean'
});

const microservice = toResourceGraph(
  {
    name: 'microservice-rbac',
    apiVersion: 'apps.example.com/v1',
    kind: 'Microservice',
    spec: MicroserviceSpec,
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Service account
    serviceAccount: serviceAccount({
      metadata: { name: schema.spec.name }
    }),
    
    // Role with conditional permissions
    appRole: role({
      metadata: { name: Cel.expr(schema.spec.name, '-role') },
      rules: [
        // Always allow reading pods
        {
          apiGroups: [''],
          resources: ['pods'],
          verbs: ['get', 'list', 'watch']
        },
        
        // Conditional ConfigMap access
        ...(schema.spec.needsConfigAccess ? [{
          apiGroups: [''],
          resources: ['configmaps'],
          verbs: ['get', 'list']
        }] : []),
        
        // Conditional Secret access
        ...(schema.spec.needsSecretAccess ? [{
          apiGroups: [''],
          resources: ['secrets'],
          verbs: ['get']
        }] : [])
      ]
    }),
    
    // Role binding
    roleBinding: roleBinding({
      metadata: { name: Cel.expr(schema.spec.name, '-binding') },
      subjects: [{
        kind: 'ServiceAccount',
        name: schema.spec.name,
        namespace: 'default'
      }],
      roleRef: {
        kind: 'Role',
        name: Cel.expr(schema.spec.name, '-role'),
        apiGroup: 'rbac.authorization.k8s.io'
      }
    }),
    
    // Application with service account
    app: simpleDeployment({
      name: schema.spec.name,
      image: 'microservice:latest',
      ports: [8080],
      serviceAccountName: schema.spec.name
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.app.status.readyReplicas, ' > 0')
  })
);
```

### `clusterRole()`

Creates a Kubernetes ClusterRole with cluster-wide permissions.

```typescript
function clusterRole(resource: V1ClusterRole): Enhanced<V1ClusterRoleSpec, unknown>
```

#### Example: Monitoring Service with Cluster Access

```typescript
const monitoringService = toResourceGraph(
  {
    name: 'monitoring-service',
    apiVersion: 'monitoring.example.com/v1',
    kind: 'MonitoringService',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Service account for monitoring
    monitoringAccount: serviceAccount({
      metadata: {
        name: 'monitoring-service',
        namespace: 'monitoring'
      }
    }),
    
    // Cluster role for reading metrics across all namespaces
    metricsClusterRole: clusterRole({
      metadata: { name: 'metrics-reader' },
      rules: [
        {
          apiGroups: [''],
          resources: ['nodes', 'nodes/metrics', 'nodes/stats', 'nodes/proxy'],
          verbs: ['get', 'list', 'watch']
        },
        {
          apiGroups: [''],
          resources: ['pods', 'services', 'endpoints'],
          verbs: ['get', 'list', 'watch']
        },
        {
          apiGroups: ['apps'],
          resources: ['deployments', 'replicasets', 'statefulsets', 'daemonsets'],
          verbs: ['get', 'list', 'watch']
        },
        {
          apiGroups: ['metrics.k8s.io'],
          resources: ['nodes', 'pods'],
          verbs: ['get', 'list']
        }
      ]
    }),
    
    // Cluster role binding
    metricsBinding: clusterRoleBinding({
      metadata: { name: 'metrics-reader-binding' },
      subjects: [{
        kind: 'ServiceAccount',
        name: 'monitoring-service',
        namespace: 'monitoring'
      }],
      roleRef: {
        kind: 'ClusterRole',
        name: 'metrics-reader',
        apiGroup: 'rbac.authorization.k8s.io'
      }
    }),
    
    // Monitoring deployment
    prometheus: simpleDeployment({
      name: 'prometheus',
      image: 'prom/prometheus:latest',
      ports: [9090],
      serviceAccountName: 'monitoring-service'
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.prometheus.status.readyReplicas, ' > 0')
  })
);
```

## Advanced RBAC Patterns

### Multi-Tenant Security

Create isolated permissions for different tenants:

```typescript
const multiTenantPlatform = toResourceGraph(
  {
    name: 'multi-tenant-platform',
    apiVersion: 'platform.example.com/v1',
    kind: 'MultiTenantPlatform',
    spec: type({
      tenants: 'string[]'
    }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Create service accounts for each tenant
    tenantAccounts: schema.spec.tenants.map(tenant =>
      serviceAccount({
        metadata: {
          name: Cel.expr(tenant, '-service-account'),
          labels: { tenant }
        }
      })
    ),
    
    // Create roles for each tenant (namespace-scoped)
    tenantRoles: schema.spec.tenants.map(tenant =>
      role({
        metadata: { name: Cel.expr(tenant, '-role') },
        rules: [
          {
            apiGroups: [''],
            resources: ['pods', 'services', 'configmaps'],
            verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']
          },
          {
            apiGroups: ['apps'],
            resources: ['deployments'],
            verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']
          },
          // Restrict secrets to only their own
          {
            apiGroups: [''],
            resources: ['secrets'],
            resourceNames: [Cel.expr(tenant, '-secrets')],
            verbs: ['get', 'list']
          }
        ]
      })
    ),
    
    // Bind roles to service accounts
    tenantBindings: schema.spec.tenants.map(tenant =>
      roleBinding({
        metadata: { name: Cel.expr(tenant, '-binding') },
        subjects: [{
          kind: 'ServiceAccount',
          name: Cel.expr(tenant, '-service-account'),
          namespace: 'default'
        }],
        roleRef: {
          kind: 'Role',
          name: Cel.expr(tenant, '-role'),
          apiGroup: 'rbac.authorization.k8s.io'
        }
      })
    ),
    
    // Tenant applications
    tenantApps: schema.spec.tenants.map(tenant =>
      simpleDeployment({
        name: Cel.expr(tenant, '-app'),
        image: 'tenant-app:latest',
        ports: [8080],
        serviceAccountName: Cel.expr(tenant, '-service-account'),
        env: {
          TENANT_NAME: tenant
        }
      })
    )
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.tenantApps.map(app => 
        Cel.expr(app.status.readyReplicas, ' > 0')
      ).join(' && ')
    )
  })
);
```

### Operator Permissions

Create RBAC for Kubernetes operators:

```typescript
const customOperator = toResourceGraph(
  {
    name: 'custom-operator',
    apiVersion: 'operators.example.com/v1',
    kind: 'CustomOperator',
    spec: type({
      name: 'string',
      watchedNamespaces: 'string[]'
    }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Operator service account
    operatorAccount: serviceAccount({
      metadata: {
        name: 'custom-operator',
        namespace: 'operator-system'
      }
    }),
    
    // Cluster role for operator permissions
    operatorClusterRole: clusterRole({
      metadata: { name: 'custom-operator-manager' },
      rules: [
        // Custom resource permissions
        {
          apiGroups: ['custom.example.com'],
          resources: ['customresources', 'customresources/status', 'customresources/finalizers'],
          verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']
        },
        // Core Kubernetes resources the operator manages
        {
          apiGroups: [''],
          resources: ['pods', 'services', 'configmaps', 'secrets'],
          verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']
        },
        {
          apiGroups: ['apps'],
          resources: ['deployments', 'statefulsets'],
          verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']
        },
        // Events for status reporting
        {
          apiGroups: [''],
          resources: ['events'],
          verbs: ['create', 'patch']
        },
        // Leader election
        {
          apiGroups: ['coordination.k8s.io'],
          resources: ['leases'],
          verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']
        }
      ]
    }),
    
    // Cluster role binding
    operatorBinding: clusterRoleBinding({
      metadata: { name: 'custom-operator-manager-binding' },
      subjects: [{
        kind: 'ServiceAccount',
        name: 'custom-operator',
        namespace: 'operator-system'
      }],
      roleRef: {
        kind: 'ClusterRole',
        name: 'custom-operator-manager',
        apiGroup: 'rbac.authorization.k8s.io'
      }
    }),
    
    // Operator deployment
    operatorDeployment: simpleDeployment({
      name: 'custom-operator-controller',
      image: 'custom-operator:latest',
      ports: [8080, 9443],
      serviceAccountName: 'custom-operator',
      env: {
        WATCHED_NAMESPACES: schema.spec.watchedNamespaces.join(',')
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.operatorDeployment.status.readyReplicas, ' > 0')
  })
);
```

### Pod Security Standards

Implement Pod Security Standards with RBAC:

```typescript
const securePlatform = toResourceGraph(
  {
    name: 'secure-platform',
    apiVersion: 'security.example.com/v1',
    kind: 'SecurePlatform',
    spec: type({
      securityLevel: '"restricted" | "baseline" | "privileged"'
    }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Restricted service account (no special permissions)
    restrictedAccount: serviceAccount({
      metadata: { name: 'restricted-workload' },
      automountServiceAccountToken: false  // Don't mount tokens for security
    }),
    
    // Baseline service account (limited permissions)
    baselineAccount: serviceAccount({
      metadata: { name: 'baseline-workload' }
    }),
    
    // Baseline role (limited permissions)
    baselineRole: role({
      metadata: { name: 'baseline-permissions' },
      rules: [
        {
          apiGroups: [''],
          resources: ['configmaps'],
          verbs: ['get', 'list']
        },
        {
          apiGroups: [''],
          resources: ['secrets'],
          resourceNames: ['app-config'],
          verbs: ['get']
        }
      ]
    }),
    
    // Baseline role binding
    baselineBinding: roleBinding({
      metadata: { name: 'baseline-binding' },
      subjects: [{
        kind: 'ServiceAccount',
        name: 'baseline-workload',
        namespace: 'default'
      }],
      roleRef: {
        kind: 'Role',
        name: 'baseline-permissions',
        apiGroup: 'rbac.authorization.k8s.io'
      }
    }),
    
    // Security-conscious application
    secureApp: simpleDeployment({
      name: 'secure-application',
      image: 'secure-app:latest',
      ports: [8080],
      serviceAccountName: Cel.conditional(
        schema.spec.securityLevel === 'restricted',
        'restricted-workload',
        'baseline-workload'
      ),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        readOnlyRootFilesystem: true,
        allowPrivilegeEscalation: false,
        capabilities: {
          drop: ['ALL']
        },
        seccompProfile: {
          type: 'RuntimeDefault'
        }
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.secureApp.status.readyReplicas, ' > 0')
  })
);
```

## Full Factory Functions

For complete control over RBAC resources:

### `roleBinding()`

```typescript
function roleBinding(resource: V1RoleBinding): Enhanced<V1RoleBindingSpec, unknown>
```

### `clusterRoleBinding()` 

```typescript
function clusterRoleBinding(resource: V1ClusterRoleBinding): Enhanced<V1ClusterRoleBindingSpec, unknown>
```

#### Example: Complex Permission Structure

```typescript
import { role, roleBinding, clusterRole, clusterRoleBinding, serviceAccount } from 'typekro';

// Service accounts for different components
const apiAccount = serviceAccount({
  metadata: { name: 'api-service' }
});

const workerAccount = serviceAccount({
  metadata: { name: 'worker-service' }
});

// API role (namespace-scoped)
const apiRole = role({
  metadata: { name: 'api-role' },
  rules: [
    {
      apiGroups: [''],
      resources: ['configmaps', 'secrets'],
      verbs: ['get', 'list']
    },
    {
      apiGroups: [''],
      resources: ['pods'],
      verbs: ['get', 'list', 'watch']
    }
  ]
});

// Worker cluster role (cluster-wide)
const workerClusterRole = clusterRole({
  metadata: { name: 'worker-cluster-role' },
  rules: [
    {
      apiGroups: ['batch'],
      resources: ['jobs'],
      verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']
    },
    {
      apiGroups: [''],
      resources: ['events'],
      verbs: ['create']
    }
  ]
});

// Role bindings
const apiBinding = roleBinding({
  metadata: { name: 'api-binding' },
  subjects: [{
    kind: 'ServiceAccount',
    name: 'api-service',
    namespace: 'default'
  }],
  roleRef: {
    kind: 'Role',
    name: 'api-role',
    apiGroup: 'rbac.authorization.k8s.io'
  }
});

const workerBinding = clusterRoleBinding({
  metadata: { name: 'worker-cluster-binding' },
  subjects: [{
    kind: 'ServiceAccount',
    name: 'worker-service',
    namespace: 'default'
  }],
  roleRef: {
    kind: 'ClusterRole',
    name: 'worker-cluster-role',
    apiGroup: 'rbac.authorization.k8s.io'
  }
});
```

## Type Definitions

### Input Types

```typescript
import type {
  V1ServiceAccount,
  V1Role,
  V1RoleBinding,
  V1ClusterRole,
  V1ClusterRoleBinding
} from '@kubernetes/client-node';
```

### Enhanced Output Types

```typescript
import type { Enhanced } from 'typekro';

type EnhancedServiceAccount = Enhanced<V1ServiceAccountSpec, V1ServiceAccountStatus>;
type EnhancedRole = Enhanced<V1RoleSpec, unknown>;
type EnhancedRoleBinding = Enhanced<V1RoleBindingSpec, unknown>;
type EnhancedClusterRole = Enhanced<V1ClusterRoleSpec, unknown>;
type EnhancedClusterRoleBinding = Enhanced<V1ClusterRoleBindingSpec, unknown>;
```

## RBAC Best Practices

### 1. Principle of Least Privilege

Grant only the minimum permissions required:

```typescript
// Good: Specific permissions
rules: [
  {
    apiGroups: [''],
    resources: ['configmaps'],
    resourceNames: ['app-config'],  // Specific resource
    verbs: ['get']                  // Specific action
  }
]

// Avoid: Overly broad permissions
rules: [
  {
    apiGroups: ['*'],
    resources: ['*'],
    verbs: ['*']
  }
]
```

### 2. Use Namespace Isolation

Prefer namespace-scoped roles when possible:

```typescript
// Good: Namespace-scoped role
const appRole = role({
  metadata: { name: 'app-role' },
  rules: [/* namespace permissions */]
});

// Only use cluster roles when necessary
const operatorClusterRole = clusterRole({
  metadata: { name: 'operator-role' },
  rules: [/* cluster-wide permissions */]
});
```

### 3. Group Related Permissions

Organize permissions logically:

```typescript
rules: [
  // Read permissions
  {
    apiGroups: [''],
    resources: ['pods', 'services'],
    verbs: ['get', 'list', 'watch']
  },
  // Write permissions
  {
    apiGroups: ['apps'],
    resources: ['deployments'],
    verbs: ['create', 'update', 'patch']
  }
]
```

### 4. Use Descriptive Names

Choose clear, descriptive names for RBAC resources:

```typescript
// Good
const databaseReaderRole = role({
  metadata: { name: 'database-reader-role' }
});

// Avoid
const role1 = role({
  metadata: { name: 'role1' }
});
```

### 5. Regular Permission Audits

Include tooling to audit permissions:

```typescript
// Add labels for permission auditing
metadata: {
  name: 'api-service-account',
  labels: {
    'security.example.com/audit': 'true',
    'security.example.com/level': 'standard'
  }
}
```

## Related APIs

- [Workloads API](/api/factories/workloads) - Using service accounts in deployments
- [Configuration API](/api/factories/config) - RBAC for accessing configuration
- [Types API](/api/types) - TypeScript type definitions
- [Security Best Practices](/guide/security) - Comprehensive security guide