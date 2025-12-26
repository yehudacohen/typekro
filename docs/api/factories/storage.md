# Storage API

Factory functions for persistent storage.

## Quick Reference

| Factory | Import | Description |
|---------|--------|-------------|
| `Pvc()` | `typekro/simple` | PersistentVolumeClaim - request storage |
| `PersistentVolume()` | `typekro/simple` | PersistentVolume - provision storage |
| `persistentVolumeClaim()` | `typekro` | Full PVC API |
| `persistentVolume()` | `typekro` | Full PV API |
| `storageClass()` | `typekro` | StorageClass definition |

## Simple Factories

### Pvc()

Request storage with minimal configuration.

```typescript
import { Pvc } from 'typekro/simple';

const storage = Pvc({
  id: 'storage',
  name: 'app-storage',
  size: '10Gi',
  accessModes: ['ReadWriteOnce'],
  storageClass: 'fast-ssd'
});

// Status reference
return { bound: storage.status.phase === 'Bound' };
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Resource ID for references |
| `name` | `string` | Yes | PVC name |
| `size` | `string` | Yes | Storage size (e.g., `10Gi`) |
| `namespace` | `string` | No | Target namespace |
| `accessModes` | `string[]` | No | Access modes (default: `['ReadWriteOnce']`) |
| `storageClass` | `string` | No | StorageClass name |

### PersistentVolume()

Provision storage directly.

```typescript
import { PersistentVolume } from 'typekro/simple';

const volume = PersistentVolume({
  id: 'volume',
  name: 'nfs-volume',
  size: '100Gi',
  accessModes: ['ReadWriteMany'],
  nfs: {
    server: '192.168.1.100',
    path: '/exports/data'
  }
});
```

## Core Factories

For full Kubernetes API access, use core factories:

```typescript
import { persistentVolumeClaim, persistentVolume, storageClass } from 'typekro';

// Full PVC configuration
const pvc = persistentVolumeClaim({
  metadata: { name: 'data-pvc', namespace: 'default' },
  spec: {
    accessModes: ['ReadWriteOnce'],
    resources: { requests: { storage: '10Gi' } },
    storageClassName: 'fast-ssd',
    volumeMode: 'Filesystem'
  }
});

// StorageClass definition
const sc = storageClass({
  metadata: { name: 'fast-ssd' },
  provisioner: 'kubernetes.io/aws-ebs',
  parameters: { type: 'gp3', iopsPerGB: '50' },
  reclaimPolicy: 'Delete',
  volumeBindingMode: 'WaitForFirstConsumer'
});
```

## Complete Example

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { StatefulSet, Service, Pvc } from 'typekro/simple';

const database = kubernetesComposition({
  name: 'database',
  apiVersion: 'data.example.com/v1',
  kind: 'Database',
  spec: type({ name: 'string', storageSize: 'string' }),
  status: type({ ready: 'boolean', bound: 'boolean' })
}, (spec) => {
  const storage = Pvc({
    id: 'storage',
    name: `${spec.name}-data`,
    size: spec.storageSize,
    storageClass: 'fast-ssd'
  });

  const db = StatefulSet({
    id: 'db',
    name: spec.name,
    image: 'postgres:15',
    serviceName: `${spec.name}-headless`,
    ports: [{ containerPort: 5432 }],
    volumeMounts: [{
      name: 'data',
      mountPath: '/var/lib/postgresql/data'
    }],
    volumes: [{
      name: 'data',
      persistentVolumeClaim: { claimName: storage.metadata.name }
    }]
  });

  Service({
    id: 'headless',
    name: `${spec.name}-headless`,
    selector: { app: spec.name },
    ports: [{ port: 5432 }],
    clusterIP: 'None'
  });

  return {
    ready: db.status.readyReplicas > 0,
    bound: storage.status.phase === 'Bound'
  };
});
```

## Access Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `ReadWriteOnce` | Single pod, single node | Databases, single-instance apps |
| `ReadOnlyMany` | Multiple pods, read-only | Shared config, static assets |
| `ReadWriteMany` | Multiple pods, read-write | Shared data (requires NFS/CephFS) |
| `ReadWriteOncePod` | Single pod only (K8s 1.22+) | Strict single-writer guarantee |

## Volume Modes

| Mode | Description |
|------|-------------|
| `Filesystem` | Mount as directory (default) |
| `Block` | Raw block device |

## Reclaim Policies

| Policy | Description |
|--------|-------------|
| `Retain` | Keep PV after PVC deletion |
| `Delete` | Delete PV when PVC is deleted |
| `Recycle` | Basic scrub (`rm -rf /volume/*`) - deprecated |

## Status Fields

PVC status fields available for references:

```typescript
storage.status.phase           // 'Pending' | 'Bound' | 'Lost'
storage.status.capacity        // Actual provisioned capacity
storage.status.accessModes     // Actual access modes
```

## Next Steps

- [Workloads](./workloads.md) - StatefulSets with storage
- [Config](./config.md) - ConfigMaps and Secrets

