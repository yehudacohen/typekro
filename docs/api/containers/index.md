---
title: Container Build
description: Build Docker images and push to registries from TypeScript
---

# Container Build

Build Docker images and push them to container registries. Returns an image URI for use in TypeKro compositions.

```typescript
import { buildContainer } from 'typekro/containers';

const { imageUri } = await buildContainer({
  context: './apps/my-app',
  imageName: 'my-app',
  registry: { type: 'orbstack' },
});

// Use in a composition
await factory.deploy({ app: { image: imageUri, port: 3000 } });
```

## Registries

### Orbstack (Local Development)

Images are automatically available to the local Kubernetes cluster. No push needed.

```typescript
const result = await buildContainer({
  context: './apps/api',
  imageName: 'api',
  registry: { type: 'orbstack' },
});
// result.imageUri → 'api:latest'
// result.pushed → false
```

### Amazon ECR

Authenticates via the AWS SDK's credential chain — env vars, profiles, SSO sessions, instance roles, and role assumption all work automatically.

```typescript
const result = await buildContainer({
  context: './apps/api',
  imageName: 'api',
  tag: 'content-hash',
  platform: 'linux/amd64',
  registry: {
    type: 'ecr',
    region: 'us-west-2',
    // Optional: auto-detected from STS if omitted
    accountId: '374080338393',
    // Optional: create repo if it doesn't exist (default: true)
    createRepository: true,
    // Optional: pass any AWS credential option
    credentials: {
      profile: 'production',
      roleArn: 'arn:aws:iam::374080338393:role/deploy',
    },
  },
});
// result.imageUri → '374080338393.dkr.ecr.us-west-2.amazonaws.com/api:sha-abc123def456'
// result.pushed → true
```

### GCR / ACR

Interfaces defined for future implementation. Currently throws with a clear message.

## Content-Hash Tagging

Use `tag: 'content-hash'` for deterministic, content-based tags. The hash is computed from the Dockerfile and all files in the build context (respecting `.dockerignore`).

```typescript
const result = await buildContainer({
  context: './apps/api',
  imageName: 'api',
  tag: 'content-hash',
  registry: { type: 'orbstack' },
});
// result.tag → 'sha-a1b2c3d4e5f6'
```

- Same content always produces the same tag
- Changing any source file produces a different tag
- `.dockerignore` is respected — ignored files don't affect the hash
- Docker's layer cache means unchanged builds return instantly

## Full Stack Example

Build a container and deploy it with the full infrastructure stack:

```typescript
import { buildContainer } from 'typekro/containers';
import { webAppWithProcessing } from 'typekro/webapp';

// Build the app image
const { imageUri } = await buildContainer({
  context: './apps/my-app',
  imageName: 'my-app',
  tag: 'content-hash',
  registry: { type: 'orbstack' },
});

// Deploy: PostgreSQL + Valkey + Inngest + App
const factory = webAppWithProcessing.factory('direct', {
  namespace: 'production',
  waitForReady: true,
  kubeConfig,
});

await factory.deploy({
  name: 'my-app',
  namespace: 'my-app',
  app: { image: imageUri, port: 3000 },
  database: { storageSize: '10Gi', database: 'myapp', owner: 'app' },
  cache: { shards: 3 },
  processing: {
    eventKey: process.env.INNGEST_EVENT_KEY!,
    signingKey: process.env.INNGEST_SIGNING_KEY!,
  },
});
```

## Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `context` | `string` | required | Path to build context directory |
| `imageName` | `string` | required | Image name (lowercase, no registry prefix) |
| `dockerfile` | `string` | `'Dockerfile'` | Dockerfile path relative to context |
| `tag` | `string` | `'latest'` | Tag or `'content-hash'` for SHA-based |
| `platform` | `string` | native | Target platform (e.g., `'linux/amd64'`) |
| `buildArgs` | `Record<string, string>` | — | Docker build arguments |
| `target` | `string` | — | Multi-stage build target |
| `extraDockerArgs` | `string[]` | — | Extra CLI args (`--secret`, `--ssh`, etc.) |
| `quiet` | `boolean` | `false` | Suppress build output |
| `timeout` | `number` | `300000` | Build timeout in ms |
| `registry` | `RegistryConfig` | required | Registry configuration |

## Security

- Build-arg values are redacted in logs and error messages
- Docker login uses `--password-stdin` (no credentials in process list)
- Build-arg keys are validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` to prevent flag injection
- Image names are validated to prevent malformed Docker URIs
