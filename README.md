# TypeKro

<div align="center">
  <img src="docs/public/typekro-logo.svg" alt="TypeKro Logo" width="200" />
  
  **Write TypeScript. Deploy Kubernetes. Runtime intelligence included.**
</div>

[![NPM Version](https://img.shields.io/npm/v/typekro.svg)](https://www.npmjs.com/package/typekro)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/yehudacohen/typekro)](https://github.com/yehudacohen/typekro)
[![Build Status](https://img.shields.io/github/actions/workflow/status/yehudacohen/typekro/deploy.yml?branch=master)](https://github.com/yehudacohen/typekro/actions)

📚 **[Documentation](https://typekro.run)** • 💬 **[Discord](https://discord.gg/kKNSDDjW)** • 🚀 **[Getting Started](https://typekro.run/guide/getting-started)**

---

## What is TypeKro?

TypeKro is a TypeScript-first framework for orchestrating Kubernetes resources with type safety and runtime intelligence. Write infrastructure in pure TypeScript with full IDE support, then deploy directly to clusters or generate deterministic YAML for GitOps workflows.

## Quick Start

```bash
bun add typekro arktype
```

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

// Define a reusable WebApp composition
const WebApp = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({ name: 'string', image: 'string', replicas: 'number' }),
  status: type({ ready: 'boolean', endpoint: 'string' })
}, (spec) => {
  const deploy = Deployment({ id: 'app', name: spec.name, image: spec.image, replicas: spec.replicas });
  const svc = Service({ id: 'svc', name: `${spec.name}-svc`, selector: { app: spec.name }, ports: [{ port: 80 }] });

  return {
    ready: deploy.status.readyReplicas > 0,     // ✨ JavaScript → CEL
    endpoint: `http://${svc.status.clusterIP}`  // ✨ Template → CEL
  };
});

// Deploy multiple instances with a simple loop
const apps = [
  { name: 'frontend', image: 'nginx', replicas: 3 },
  { name: 'api', image: 'node:20', replicas: 2 }
];

const factory = WebApp.factory('direct', { namespace: 'production' });
for (const app of apps) await factory.deploy(app);
```

**What this demonstrates:**
- **Reusable compositions** - Define once, deploy many times
- **Type-safe schemas** - ArkType validates at compile-time and runtime
- **Cross-resource references** - `svc.status.clusterIP` references live cluster state
- **JavaScript-to-CEL** - Status expressions become runtime CEL
- **Native loops** - Just `for...of` to deploy multiple apps

## Why TypeKro?

| Feature | TypeKro | Pulumi | CDK8s | Helm |
|---------|---------|--------|-------|------|
| **Type Safety** | ✅ Full TypeScript | ✅ Multi-lang | ✅ TypeScript | ❌ Templates |
| **GitOps Ready** | ✅ Deterministic YAML | ❌ State backend | ✅ YAML output | ✅ Charts |
| **Runtime Refs** | ✅ CEL expressions | ❌ Deploy-time | ❌ Static | ❌ Templates |
| **Learning Curve** | 🟢 Just TypeScript | 🔴 New concepts | 🟡 TS + K8s | 🔴 Templates |
| **Stateless** | ✅ | ❌ State backend | ✅ | ✅ |
| **Cross-Resource** | ✅ Runtime resolution | ❌ Deploy-time | ❌ Manual | ❌ Manual |

## Deployment Modes

TypeKro supports multiple deployment strategies from the same code:

```typescript
// 1. Direct deployment - immediate, no Kro required
const factory = graph.factory('direct', { namespace: 'dev' });
await factory.deploy(spec);

// 2. Kro deployment - runtime CEL evaluation
const kroFactory = graph.factory('kro', { namespace: 'prod' });
await kroFactory.deploy(spec);

// 3. YAML generation - GitOps workflows
const yaml = kroFactory.toYaml();
writeFileSync('k8s/app.yaml', yaml);
```

## Core Features

### Type-Safe Schemas with ArkType

```typescript
const AppSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  'environment?': '"dev" | "staging" | "prod"'
});
```

### Cross-Resource References

```typescript
const db = Deployment({ id: 'database', name: 'postgres', image: 'postgres:15' });
const api = Deployment({
  id: 'api',
  name: 'api-server',
  image: 'node:20',
  env: {
    DB_HOST: db.metadata.name  // Runtime reference
  }
});
```

### JavaScript-to-CEL Conversion

Write natural JavaScript - TypeKro converts to CEL:

```typescript
return {
  ready: deploy.status.readyReplicas > 0,           // → ${app.status.readyReplicas > 0}
  url: `http://${svc.status.clusterIP}`,            // → http://${svc.status.clusterIP}
  phase: deploy.status.phase === 'Running' ? 'up' : 'down'
};
```

### Helm Integration

```typescript
import { helmRelease, helmRepository } from 'typekro';

const repo = helmRepository({
  name: 'bitnami',
  url: 'https://charts.bitnami.com/bitnami'
});

const release = helmRelease({
  name: 'nginx',
  repository: repo,
  chart: 'nginx',
  values: {
    replicaCount: spec.replicas  // Type-safe values
  }
});
```

### YAML File Integration

```typescript
import { yamlFile } from 'typekro';

const existing = yamlFile({
  path: './k8s/existing-deployment.yaml',
  namespace: 'default'
});
```

## Factory Functions

TypeKro provides 50+ factory functions for Kubernetes resources:

**Workloads:** `Deployment`, `StatefulSet`, `DaemonSet`, `Job`, `CronJob`

**Networking:** `Service`, `Ingress`, `NetworkPolicy`

**Config:** `ConfigMap`, `Secret`

**Storage:** `PersistentVolumeClaim`, `PersistentVolume`, `StorageClass`

**RBAC:** `ServiceAccount`, `Role`, `RoleBinding`, `ClusterRole`, `ClusterRoleBinding`

**[View Complete API Reference →](https://typekro.run/api/)**

## What is Kro?

[Kubernetes Resource Orchestrator (Kro)](https://kro.run/) is an open-source project by AWS Labs that enables resources to reference each other's runtime state using CEL expressions.

TypeKro works in **Direct Mode** (no Kro required) for simple deployments, or **Kro Mode** for advanced orchestration with runtime dependencies.

## Documentation

- **[Getting Started](https://typekro.run/guide/getting-started)** - 5-minute quick start
- **[Core Concepts](https://typekro.run/guide/imperative-composition)** - kubernetesComposition API
- **[API Reference](https://typekro.run/api/)** - Complete API documentation
- **[Examples](https://typekro.run/examples/)** - Real-world patterns

## Installation

```bash
# Using bun (recommended)
bun add typekro arktype

# Using npm
npm install typekro arktype

# Using yarn
yarn add typekro arktype
```

## Requirements

- Node.js 18+ or Bun
- TypeScript 5.0+
- Kubernetes cluster (for deployment)
- Kro controller (optional, for runtime features)

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
# Clone the repository
git clone https://github.com/yehudacohen/typekro.git
cd typekro

# Install dependencies
bun install

# Run tests
bun run test

# Build
bun run build
```

## License

Apache 2.0 - See [LICENSE](LICENSE) for details.

---

<div align="center">
  <strong>Built with ❤️ for the Kubernetes community</strong>
  
  [Documentation](https://typekro.run) • [Discord](https://discord.gg/kKNSDDjW) • [GitHub](https://github.com/yehudacohen/typekro)
</div>
