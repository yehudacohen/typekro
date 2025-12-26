# RBAC API

Factory functions for Kubernetes Role-Based Access Control (RBAC) resources.

## Quick Reference

| Factory | Scope | Description |
|---------|-------|-------------|
| `role()` | Namespace | Permission rules within a namespace |
| `roleBinding()` | Namespace | Bind roles to users/groups/service accounts |
| `clusterRole()` | Cluster | Cluster-wide permission rules |
| `clusterRoleBinding()` | Cluster | Cluster-wide role bindings |
| `serviceAccount()` | Namespace | Identity for pods |

## Import

```typescript
import { role, roleBinding, clusterRole, clusterRoleBinding, serviceAccount } from 'typekro';
```

## role()

Creates a namespace-scoped Role with permission rules.

```typescript
import { role } from 'typekro';

const podReader = role({
  metadata: { name: 'pod-reader', namespace: 'default' },
  rules: [{
    apiGroups: [''],
    resources: ['pods'],
    verbs: ['get', 'list', 'watch']
  }]
});
```

### Common Permission Patterns

```typescript
// Read-only access to pods and logs
const debugRole = role({
  metadata: { name: 'pod-debugger', namespace: 'default' },
  rules: [
    {
      apiGroups: [''],
      resources: ['pods', 'pods/log'],
      verbs: ['get', 'list', 'watch']
    },
    {
      apiGroups: [''],
      resources: ['pods/exec'],
      verbs: ['create']
    }
  ]
});

// ConfigMap and Secret read access
const configRole = role({
  metadata: { name: 'config-reader', namespace: 'default' },
  rules: [{
    apiGroups: [''],
    resources: ['configmaps', 'secrets'],
    verbs: ['get', 'list', 'watch']
  }]
});
```

## roleBinding()

Binds a Role to subjects (users, groups, or service accounts).

```typescript
import { roleBinding } from 'typekro';

const binding = roleBinding({
  metadata: { name: 'read-pods', namespace: 'default' },
  roleRef: {
    apiGroup: 'rbac.authorization.k8s.io',
    kind: 'Role',
    name: 'pod-reader'
  },
  subjects: [{
    kind: 'ServiceAccount',
    name: 'my-app',
    namespace: 'default'
  }]
});
```

### Subject Types

```typescript
// Bind to a ServiceAccount
subjects: [{
  kind: 'ServiceAccount',
  name: 'my-app',
  namespace: 'default'
}]

// Bind to a User
subjects: [{
  kind: 'User',
  name: 'jane@example.com',
  apiGroup: 'rbac.authorization.k8s.io'
}]

// Bind to a Group
subjects: [{
  kind: 'Group',
  name: 'developers',
  apiGroup: 'rbac.authorization.k8s.io'
}]
```

## clusterRole()

Creates cluster-wide permission rules.

```typescript
import { clusterRole } from 'typekro';

const nodeReader = clusterRole({
  metadata: { name: 'node-reader' },
  rules: [{
    apiGroups: [''],
    resources: ['nodes'],
    verbs: ['get', 'list', 'watch']
  }]
});
```

### Aggregated ClusterRoles

```typescript
// Base role with aggregation label
const baseRole = clusterRole({
  metadata: {
    name: 'monitoring-base',
    labels: { 'rbac.example.com/aggregate-to-monitoring': 'true' }
  },
  rules: [{
    apiGroups: [''],
    resources: ['pods', 'services'],
    verbs: ['get', 'list', 'watch']
  }]
});

// Aggregated role that combines labeled roles
const aggregatedRole = clusterRole({
  metadata: { name: 'monitoring' },
  aggregationRule: {
    clusterRoleSelectors: [{
      matchLabels: { 'rbac.example.com/aggregate-to-monitoring': 'true' }
    }]
  }
});
```

## clusterRoleBinding()

Binds a ClusterRole to subjects cluster-wide.

```typescript
import { clusterRoleBinding } from 'typekro';

const binding = clusterRoleBinding({
  metadata: { name: 'node-reader-binding' },
  roleRef: {
    apiGroup: 'rbac.authorization.k8s.io',
    kind: 'ClusterRole',
    name: 'node-reader'
  },
  subjects: [{
    kind: 'ServiceAccount',
    name: 'monitoring',
    namespace: 'monitoring'
  }]
});
```

## serviceAccount()

Creates a ServiceAccount for pod identity.

```typescript
import { serviceAccount } from 'typekro';

const sa = serviceAccount({
  metadata: { name: 'my-app', namespace: 'default' }
});
```

### With Image Pull Secrets

```typescript
const sa = serviceAccount({
  metadata: { name: 'my-app', namespace: 'default' },
  imagePullSecrets: [{ name: 'registry-credentials' }]
});
```

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition, role, roleBinding, serviceAccount } from 'typekro';
import { Deployment } from 'typekro/simple';

const SecureAppSpec = type({
  name: 'string',
  image: 'string'
});

const secureApp = kubernetesComposition({
  name: 'secure-app',
  apiVersion: 'example.com/v1',
  kind: 'SecureApp',
  spec: SecureAppSpec,
  status: type({ ready: 'boolean' })
}, (spec) => {
  // Create service account for the app
  const sa = serviceAccount({
    metadata: { name: spec.name, namespace: 'default' }
  });

  // Create role with minimal permissions
  role({
    metadata: { name: `${spec.name}-role`, namespace: 'default' },
    rules: [{
      apiGroups: [''],
      resources: ['configmaps'],
      verbs: ['get', 'list']
    }]
  });

  // Bind role to service account
  roleBinding({
    metadata: { name: `${spec.name}-binding`, namespace: 'default' },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'Role',
      name: `${spec.name}-role`
    },
    subjects: [{
      kind: 'ServiceAccount',
      name: spec.name,
      namespace: 'default'
    }]
  });

  // Deploy with service account
  const deploy = Deployment({
    id: 'app',
    name: spec.name,
    image: spec.image,
    serviceAccountName: sa.metadata.name
  });

  return { ready: deploy.status.readyReplicas > 0 };
});
```

## Common Verbs Reference

| Verb | Description |
|------|-------------|
| `get` | Read a single resource |
| `list` | List resources |
| `watch` | Watch for changes |
| `create` | Create new resources |
| `update` | Update existing resources |
| `patch` | Partially update resources |
| `delete` | Delete resources |
| `deletecollection` | Delete multiple resources |

## Readiness Behavior

RBAC resources are configuration objects without status conditions. They're considered ready immediately upon creation.

## Next Steps

- [Workloads](./workloads.md) - Using service accounts in deployments
- [Config](./config.md) - ConfigMaps and Secrets

