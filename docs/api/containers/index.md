---
title: Container Images
description: Build, publish, and verify immutable OCI images from TypeScript
---

# Container Images

`container()` is the supported front door for content-addressed image builds. Remote registries are
authenticated in an isolated Docker session, pushed through BuildKit, inspected through the registry,
and returned as immutable digest references. `buildContainer()` exposes the same operation without
process-local memoization.

```typescript
import { container } from 'typekro/containers';

const image = await container({
  context: './apps/my-app',
  imageName: 'my-app',
  registry: { type: 'orbstack' },
});

// Use in a composition
await factory.deploy({ app: { image: image.imageUri, port: 3000 } });
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
// result.taggedImageUri → '374080338393.dkr.ecr.us-west-2.amazonaws.com/api:sha-abc123def456'
// result.imageUri → '374080338393.dkr.ecr.us-west-2.amazonaws.com/api@sha256:…'
// result.digest → 'sha256:…' (verified from ECR)
// result.pushed → true
```

### Generic OCI and Harbor

Any OCI Distribution-compatible registry can use the generic handler. Harbor is a thin helper that
maps its project to the repository prefix; Harbor project and robot-account lifecycle stays in
`typekro/harbor`, not in the transport.

```typescript
import {
  container,
  harbor,
  kubernetesSecretRegistryCredentials,
} from 'typekro/containers';

const image = await container({
  context: './apps/api',
  imageName: 'api',
  platforms: ['linux/amd64', 'linux/arm64'],
  registry: harbor({
    registry: 'https://registry.example.com',
    project: 'chirp',
    credentialProvider: kubernetesSecretRegistryCredentials({
      context: 'production',
      namespace: 'harbor-system',
      name: 'chirp-push-robot',
      registry: 'registry.example.com',
    }),
    tls: { caFile: './platform-ca.pem' },
  }),
});

// Always deploy the immutable URI.
Deployment({ name: 'api', image: image.imageUri });
```

Without an explicit credential provider, TypeKro copies `DOCKER_CONFIG/config.json` (or
`~/.docker/config.json`) into the isolated session so native Docker credential helpers continue to
work. For conventional TLS, explicit credentials are passed to `docker login` with
`--password-stdin`. For `caFile`, `caCertificate`, `insecure`, or `plainHttp`, Docker has no safe
per-command trust override, so TypeKro writes the standard auth entry directly into the isolated
configuration and gives the transport settings to a dedicated BuildKit configuration. It never
depends on a developer machine's global daemon trust. The temporary config, copied custom CA, and
temporary Buildx builder are removed after success, failure, timeout, or cancellation.

Plain HTTP and unverified TLS are explicit development-only switches:

```typescript
registry: {
  type: 'oci',
  registry: 'localhost:5000',
  repositoryPrefix: 'development',
  tls: { plainHttp: true },
}
```

### GCR / ACR

Interfaces defined for future implementation. Currently throws with a clear message.

## Content-Hash Tagging

`container()` defaults to deterministic content-hash tags. The hash is computed from the Dockerfile
and every readable file in the build context while respecting `.dockerignore`; an unreadable included
file fails closed instead of silently reusing an older identity.

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

The built-in content hash deliberately identifies source content only. It does **not** cover build
arguments, targets, platforms, extra Docker arguments, file modes, or symlink metadata, so it is not
a complete build identity and cannot safely authorize registry-side adoption.

## Retry-safe immutable tag adoption

For a remote registry that enforces immutable tags, an interrupted deployment can adopt an image
that was already published by the same complete build instead of trying to push the tag again:

```typescript
const image = await container({
  context: './apps/api',
  imageName: 'api',
  // Produced by your build pipeline from every build input, not TypeKro's
  // context-only `content-hash`.
  tag: completeBuildIdentity,
  existingTagPolicy: 'adopt',
  platform: 'linux/amd64',
  registry: harbor({
    registry: 'registry.example.com',
    project: 'production',
  }),
});
```

`adopt` is fail-closed and has two non-negotiable preconditions:

1. The explicit tag must identify the complete build: context bytes and paths, Dockerfile, build
   arguments, target, platforms, extra Docker arguments, and relevant file/symlink metadata.
2. The registry must enforce tag immutability.

TypeKro rejects `adopt` with an omitted tag or `tag: 'content-hash'`. It builds only after the
registry positively reports `manifest unknown`; authentication, TLS, registry, Docker, timeout,
cancellation, and malformed-digest failures are returned to the caller without attempting a push.

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
| `existingTagPolicy` | `'replace' \| 'adopt'` | `'replace'` | Adopt an existing immutable explicit tag; requires a complete caller-derived build identity |
| `platform` | `string` | native | Target platform (e.g., `'linux/amd64'`) |
| `platforms` | `string[]` | — | Multi-platform Buildx manifest; remote registries only |
| `buildArgs` | `Record<string, string>` | — | Docker build arguments |
| `target` | `string` | — | Multi-stage build target |
| `extraDockerArgs` | `string[]` | — | Extra CLI args (`--secret`, `--ssh`, etc.) |
| `quiet` | `boolean` | `false` | Suppress build output |
| `progress` | `auto \| plain \| tty \| rawjson` | `auto` | BuildKit progress mode |
| `timeout` | `number` | `300000` | Build timeout in ms |
| `signal` | `AbortSignal` | — | Cancel authentication, build, push, and verification |
| `registry` | `RegistryConfig` | required | Registry configuration |

Remote results include `taggedImageUri`, `repository`, `tag`, `digest`, and the canonical immutable
`imageUri`. TypeKro compares BuildKit's pushed digest with a registry-side manifest inspection and
fails closed if they differ.

## Registry extension contract

Provider packages can implement one `RegistryHandler` and pass it through
`{ type: 'custom', handler }`. The core build path remains responsible for hashing, bounds, Buildx,
cleanup, and result shaping; an extension only resolves a URI and opens a short-lived session. The
conformance test suite exercises this boundary so adding a provider does not require changes throughout
`container()`.

## Security

- Build-arg values are redacted in logs and error messages
- Conventional-TLS Docker login uses `--password-stdin`; custom transports write credentials only
  into the mode-restricted isolated Docker config (no credentials in process arguments)
- Docker configuration and custom trust are isolated with mode-restricted temporary files and deleted
- Kubernetes Secret credentials are resolved only when the registry session opens and are never returned in build results
- Remote workloads receive only immutable digest references; the human-readable tag is retained separately for inspection and retention
- Build-arg keys are validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` to prevent flag injection
- Image names are validated to prevent malformed Docker URIs
- Captured subprocess output is bounded and timeout/cancellation escalates from SIGTERM to SIGKILL
