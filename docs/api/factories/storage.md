# Storage API

Storage factory functions create Kubernetes storage resources with type safety and intelligent readiness evaluation. These functions handle Persistent Volumes, Persistent Volume Claims, Storage Classes, and related storage components.

## Overview

TypeKro storage factories provide:
- **Simplified persistent storage** with PVC creation
- **Storage class configuration** for different storage types
- **Automatic volume provisioning** and binding
- **Cross-resource storage references** in deployments and StatefulSets

## Core Storage Types

### `simplePvc()`

Creates a Kubernetes Persistent Volume Claim with simplified configuration.

```typescript
function simplePvc(config: SimplePvcConfig): Enhanced<V1PersistentVolumeClaimSpec, V1PersistentVolumeClaimStatus>
```

#### Parameters

- **`config`**: Simplified PVC configuration

```typescript
interface SimplePvcConfig {
  name: string;
  namespace?: string;
  size: string;
  accessModes?: string[];
  storageClass?: string;
}
```

#### Returns

Enhanced PersistentVolumeClaim with automatic readiness evaluation.

#### Example: Basic PVC

```typescript
import { toResourceGraph, simplePvc, simpleDeployment, type } from 'typekro';

const StorageAppSpec = type({
  name: 'string',
  storageSize: 'string'
});

const storageApp = toResourceGraph(
  {
    name: 'storage-app',
    apiVersion: 'storage.example.com/v1',
    kind: 'StorageApp',
    spec: StorageAppSpec,
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Persistent storage
    storage: simplePvc({
      name: Cel.template('%s-storage', schema.spec.name),
      size: schema.spec.storageSize,
      accessModes: ['ReadWriteOnce'],
      storageClass: 'fast-ssd'
    }),
    
    // Application that uses the storage
    app: simpleDeployment({
      name: schema.spec.name,
      image: 'nginx:1.21',
      ports: [80],
      volumeMounts: [{
        name: 'data',
        mountPath: '/var/www/html'
      }],
      volumes: [{
        name: 'data',
        persistentVolumeClaim: {
          claimName: schema.spec.name + '-storage'  // References PVC above
        }
      }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.storage.status.phase, ' == "Bound" && ',
      resources.app.status.readyReplicas, ' > 0'
    )
  })
);
```

#### Example: Database with Persistent Storage

```typescript
import { toResourceGraph, simplePvc, simpleStatefulSet, type } from 'typekro';

const DatabaseSpec = type({
  name: 'string',
  storageSize: 'string',
  replicas: 'number'
});

const databaseWithStorage = toResourceGraph(
  {
    name: 'database-storage',
    apiVersion: 'data.example.com/v1', 
    kind: 'DatabaseStorage',
    spec: DatabaseSpec,
    status: type({ ready: 'boolean', storageStatus: 'string' })
  },
  (schema) => ({
    // Database with persistent storage
    database: simpleStatefulSet({
      name: schema.spec.name,
      image: 'postgres:15',
      replicas: schema.spec.replicas,
      serviceName: 'postgres-headless',
      ports: [5432],
      env: {
        POSTGRES_DB: 'myapp',
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'secret'
      },
      volumeClaimTemplates: [{
        metadata: { name: 'postgres-storage' },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: 'fast-ssd',
          resources: {
            requests: { storage: schema.spec.storageSize }
          }
        }
      }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(resources.database.status.readyReplicas, ' >= ', schema.spec.replicas),
    storageStatus: Cel.expr('string(', resources.database.status.collisionCount, ')')
  })
);
```

## Advanced Storage Functions

For scenarios requiring complete control, TypeKro provides full storage factory functions:

### `persistentVolume()`

Creates a Kubernetes Persistent Volume with complete specification.

```typescript
function persistentVolume(resource: V1PersistentVolume): Enhanced<V1PersistentVolumeSpec, V1PersistentVolumeStatus>
```

#### Example: Custom Persistent Volume

```typescript
import { persistentVolume } from 'typekro';

const customPV = persistentVolume({
  metadata: { name: 'nfs-storage' },
  spec: {
    capacity: { storage: '100Gi' },
    accessModes: ['ReadWriteMany'],
    persistentVolumeReclaimPolicy: 'Retain',
    storageClassName: 'nfs',
    nfs: {
      server: 'nfs-server.example.com',
      path: '/exports/data'
    }
  }
});
```

### `storageClass()`

Creates a Kubernetes Storage Class for dynamic provisioning.

```typescript
function storageClass(resource: V1StorageClass): Enhanced<V1StorageClassSpec, unknown>
```

#### Example: Custom Storage Class

```typescript
import { storageClass } from 'typekro';

const fastStorage = storageClass({
  metadata: { name: 'fast-ssd' },
  provisioner: 'kubernetes.io/aws-ebs',
  parameters: {
    type: 'gp3',
    iops: '3000',
    throughput: '125',
    encrypted: 'true'
  },
  reclaimPolicy: 'Delete',
  allowVolumeExpansion: true,
  volumeBindingMode: 'WaitForFirstConsumer'
});
```

## Storage Patterns

### Multi-Tier Storage

Configure different storage classes for different performance needs:

```typescript
const multiTierApp = toResourceGraph(
  {
    name: 'multi-tier-storage',
    apiVersion: 'storage.example.com/v1',
    kind: 'MultiTierApp', 
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // Fast storage for database
    dbStorage: simplePvc({
      name: 'database-storage',
      size: '50Gi',
      storageClass: 'fast-ssd',
      accessModes: ['ReadWriteOnce']
    }),
    
    // Slower storage for backups
    backupStorage: simplePvc({
      name: 'backup-storage', 
      size: '500Gi',
      storageClass: 'standard',
      accessModes: ['ReadWriteOnce']
    }),
    
    // Shared storage for files
    sharedStorage: simplePvc({
      name: 'shared-storage',
      size: '100Gi', 
      storageClass: 'nfs',
      accessModes: ['ReadWriteMany']
    }),
    
    // Database using fast storage
    database: simpleStatefulSet({
      name: 'postgres',
      image: 'postgres:15',
      volumeMounts: [{
        name: 'db-data',
        mountPath: '/var/lib/postgresql/data'
      }],
      volumes: [{
        name: 'db-data',
        persistentVolumeClaim: { claimName: 'database-storage' }
      }]
    }),
    
    // Application using shared storage
    app: simpleDeployment({
      name: 'web-app',
      image: 'nginx:1.21',
      replicas: 3,
      volumeMounts: [{
        name: 'shared-files',
        mountPath: '/var/www/html/shared'
      }],
      volumes: [{
        name: 'shared-files', 
        persistentVolumeClaim: { claimName: 'shared-storage' }
      }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.dbStorage.status.phase, ' == "Bound" && ',
      resources.backupStorage.status.phase, ' == "Bound" && ',
      resources.sharedStorage.status.phase, ' == "Bound" && ',
      resources.database.status.readyReplicas, ' > 0 && ',
      resources.app.status.readyReplicas, ' > 0'
    )
  })
);
```

### Dynamic Provisioning with CSI

Configure Container Storage Interface (CSI) drivers:

```typescript
const csiStorage = toResourceGraph(
  {
    name: 'csi-storage',
    apiVersion: 'storage.example.com/v1',
    kind: 'CSIStorage',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean' })
  },
  (schema) => ({
    // CSI Storage Class
    csiStorageClass: storageClass({
      metadata: { name: 'csi-cephfs' },
      provisioner: 'cephfs.csi.ceph.com',
      parameters: {
        clusterID: 'ceph-cluster',
        fsName: 'cephfs',
        pool: 'cephfs-data'
      },
      reclaimPolicy: 'Delete',
      allowVolumeExpansion: true
    }),
    
    // PVC using CSI storage class
    appStorage: simplePvc({
      name: 'csi-storage',
      size: '20Gi',
      storageClass: 'csi-cephfs',
      accessModes: ['ReadWriteMany']
    }),
    
    // Application using CSI storage
    app: simpleDeployment({
      name: schema.spec.name,
      image: 'nginx:1.21',
      replicas: 3,
      volumeMounts: [{
        name: 'csi-volume',
        mountPath: '/data'
      }],
      volumes: [{
        name: 'csi-volume',
        persistentVolumeClaim: { claimName: 'csi-storage' }
      }]
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.appStorage.status.phase, ' == "Bound" && ',
      resources.app.status.readyReplicas, ' > 0'
    )
  })
);
```

### Backup and Snapshot Management

Integrate storage snapshots and backup workflows:

```typescript
const backupEnabledApp = toResourceGraph(
  {
    name: 'backup-enabled-app',
    apiVersion: 'backup.example.com/v1',
    kind: 'BackupEnabledApp',
    spec: type({
      name: 'string',
      backupSchedule: 'string'
    }),
    status: type({ 
      ready: 'boolean',
      lastBackup: 'string'
    })
  },
  (schema) => ({
    // Snapshotable storage class
    snapshotStorage: storageClass({
      metadata: { name: 'snapshot-enabled' },
      provisioner: 'ebs.csi.aws.com',
      parameters: {
        type: 'gp3',
        encrypted: 'true'
      },
      allowVolumeExpansion: true
    }),
    
    // Application storage
    appStorage: simplePvc({
      name: 'app-storage',
      size: '10Gi',
      storageClass: 'snapshot-enabled'
    }),
    
    // Application
    app: simpleStatefulSet({
      name: schema.spec.name,
      image: 'postgres:15',
      volumeMounts: [{
        name: 'data',
        mountPath: '/var/lib/postgresql/data'
      }],
      volumes: [{
        name: 'data',
        persistentVolumeClaim: { claimName: 'app-storage' }
      }]
    }),
    
    // Backup CronJob
    backup: simpleCronJob({
      name: 'backup-job',
      image: 'snapshot-tool:latest',
      schedule: schema.spec.backupSchedule,
      command: ['create-snapshot'],
      env: {
        PVC_NAME: 'app-storage',
        NAMESPACE: 'default'
      }
    })
  }),
  (schema, resources) => ({
    ready: Cel.expr(
      resources.appStorage.status.phase, ' == "Bound" && ',
      resources.app.status.readyReplicas, ' > 0'
    ),
    lastBackup: Cel.expr('string(', resources.backup.status.lastScheduleTime, ')')
  })
);
```

## Type Definitions

### Input Types

```typescript
interface SimplePvcConfig {
  name: string;
  namespace?: string;
  size: string;
  accessModes?: string[];
  storageClass?: string;
}
```

### Enhanced Output Types

```typescript
import type { Enhanced } from 'typekro';
import type { 
  V1PersistentVolumeClaim, 
  V1PersistentVolume,
  V1StorageClass 
} from '@kubernetes/client-node';

type EnhancedPVC = Enhanced<V1PersistentVolumeClaimSpec, V1PersistentVolumeClaimStatus>;
type EnhancedPV = Enhanced<V1PersistentVolumeSpec, V1PersistentVolumeStatus>;
type EnhancedStorageClass = Enhanced<V1StorageClassSpec, unknown>;
```

## Storage Best Practices

### 1. Choose Appropriate Access Modes

Select the right access mode for your use case:

```typescript
// Single pod access
accessModes: ['ReadWriteOnce']

// Multiple pods, single node
accessModes: ['ReadOnlyMany', 'ReadWriteOnce']

// Multiple pods, multiple nodes (requires NFS/CephFS)
accessModes: ['ReadWriteMany']
```

### 2. Set Resource Limits

Always specify storage resource requirements:

```typescript
const storage = simplePvc({
  name: 'app-storage',
  size: '10Gi',  // Specific size requirement
  storageClass: 'fast-ssd'  // Performance class
});
```

### 3. Use Appropriate Storage Classes

Match storage classes to workload requirements:

```typescript
// Database - high IOPS
storageClass: 'fast-ssd'  // gp3, io1, etc.

// File sharing - network storage
storageClass: 'nfs'       // NFS, CephFS, etc.

// Backup/archival - cost optimized
storageClass: 'standard'  // gp2, standard, etc.
```

### 4. Plan for Backup and Recovery

Include backup strategies in your storage design:

```typescript
// Use storage classes that support snapshots
storageClass: 'snapshot-enabled'

// Include backup jobs
backup: simpleCronJob({
  name: 'backup',
  schedule: '0 2 * * *',  // Daily backups
  image: 'backup-tool:latest'
})
```

### 5. Monitor Storage Usage

Include monitoring for storage resources:

```typescript
// Add labels for monitoring
metadata: {
  name: 'app-storage',
  labels: {
    app: 'myapp',
    tier: 'storage',
    backup: 'enabled'
  }
}
```

## Related APIs

- [Workloads API](/api/factories/workloads) - StatefulSets and persistent workloads
- [Configuration API](/api/factories/config) - ConfigMaps and Secrets
- [Types API](/api/types) - TypeScript type definitions
- [Database Example](/examples/database) - Real-world storage patterns