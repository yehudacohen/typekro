# Collections & forEach

Deploy multiple instances of a resource from a single spec using KRO's `forEach` directive. This is how you model worker pools, multi-region deployments, and sidecar patterns declaratively.

## Worker Pool

Deploy N workers from a spec array — KRO creates one Deployment per entry:

```typescript
import { type } from 'arktype';
import { kubernetesComposition, Deployment, Service } from 'typekro';

const WorkerPool = kubernetesComposition({
  name: 'worker-pool',
  kind: 'WorkerPool',
  spec: type({
    name: 'string',
    workers: type({
      name: 'string',
      image: 'string',
      replicas: 'number',
      'queue?': 'string',
    }).array(),
  }),
  status: type({
    ready: 'boolean',
    workerCount: 'number',
  }),
}, (spec) => {
  // forEach: one Deployment per worker in the array
  for (const worker of spec.workers) {
    Deployment({
      id: `worker-${worker.name}`,
      name: `${spec.name}-${worker.name}`,
      image: worker.image,
      replicas: worker.replicas,
      env: worker.queue ? [{ name: 'QUEUE_NAME', value: worker.queue }] : [],
    });
  }

  return {
    ready: true,
    workerCount: spec.workers.length,
  };
});
```

### Deploy it

```typescript
const factory = WorkerPool.factory('direct', { namespace: 'processing' });

await factory.deploy({
  name: 'email-pipeline',
  workers: [
    { name: 'ingest',  image: 'worker:latest', replicas: 3, queue: 'ingest' },
    { name: 'process', image: 'worker:latest', replicas: 5, queue: 'process' },
    { name: 'deliver', image: 'worker:latest', replicas: 2, queue: 'deliver' },
  ],
});
// Creates: email-pipeline-ingest (3 replicas)
//          email-pipeline-process (5 replicas)
//          email-pipeline-deliver (2 replicas)
```

### Generated KRO YAML

TypeKro generates a `forEach` directive in the ResourceGraphDefinition:

```yaml
apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
spec:
  schema:
    spec:
      name: string
      workers:
        - name: string
          image: string
          replicas: integer
          queue: string
  resources:
    - id: worker
      forEach: schema.spec.workers
      template:
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: ${schema.spec.name + "-" + worker.name}
        spec:
          replicas: ${worker.replicas}
          template:
            spec:
              containers:
                - name: worker
                  image: ${worker.image}
                  env:
                    - name: QUEUE_NAME
                      value: ${worker.queue}
```

KRO handles the iteration at runtime — one Deployment per array element, with automatic cleanup when elements are removed.

## Multi-Region Deployment

Same pattern, different use case — deploy to multiple regions from config:

```typescript
const MultiRegion = kubernetesComposition({
  name: 'multi-region',
  kind: 'MultiRegion',
  spec: type({
    app: 'string',
    image: 'string',
    regions: type({ name: 'string', replicas: 'number' }).array(),
  }),
  status: type({ ready: 'boolean' }),
}, (spec) => {
  for (const region of spec.regions) {
    Deployment({
      id: `region-${region.name}`,
      name: `${spec.app}-${region.name}`,
      image: spec.image,
      replicas: region.replicas,
      labels: { region: region.name },
    });

    Service({
      id: `svc-${region.name}`,
      name: `${spec.app}-${region.name}`,
      selector: { app: spec.app, region: region.name },
      ports: [{ port: 80, targetPort: 8080 }],
    });
  }

  return { ready: true };
});
```

```typescript
await factory.deploy({
  app: 'api',
  image: 'api:v2.1.0',
  regions: [
    { name: 'us-east', replicas: 5 },
    { name: 'eu-west', replicas: 3 },
    { name: 'ap-south', replicas: 2 },
  ],
});
```

## Key Points

- **Write JavaScript loops** — TypeKro converts them to KRO `forEach` directives
- **Each iteration creates independent resources** — Deployments, Services, ConfigMaps, etc.
- **Adding/removing array elements** adds/removes the corresponding resources
- **Works in both modes** — `direct` mode creates resources in a loop, `kro` mode generates forEach YAML
- **Resource IDs must be unique per iteration** — use the array item's name or index in the `id`
