---
title: SearXNG
description: Privacy-respecting metasearch engine integration
---

# SearXNG

Deploy [SearXNG](https://docs.searxng.org/) — a privacy-respecting metasearch engine that aggregates results from multiple providers (Google, Bing, DuckDuckGo, Brave, etc.).

## Requirements

- **KRO 0.9.2+** with the `CELOmitFunction` feature gate enabled. The composition uses `omit()` in its CEL expressions to drop optional fields that the user leaves unset — KRO 0.8.x will reject the resulting RGD at reconciliation time.
- TypeKro's bundled runtime already pins KRO 0.9.2 and enables the feature gate, so no manual configuration is needed if you bootstrap your cluster via `typeKroRuntimeBootstrap().factory(...)` from the root `typekro` package. If you install KRO yourself, add this to your Helm values:
  ```yaml
  config:
    featureGates:
      CELOmitFunction: true
  ```

## Known Limitations

- **`search.formats` is direct-mode only.** In KRO mode the user-supplied `formats` array is currently ignored and the composition falls back to the literal default `['html', 'json']`. This is because KRO's CEL mixed templates don't yet support iterating a schema array into a YAML list. If you need a custom `formats` list, deploy via direct mode. Array-valued CEL templating is tracked in [yehudacohen/typekro#57](https://github.com/yehudacohen/typekro/issues/57) and this limitation will be removed once it lands.
- **Optional generated settings fields are direct-mode only.** `server.bind_address`, `server.method`, `search.default_lang`, `search.autocomplete`, and `search.safe_search` are emitted into generated `settings.yml` when the spec is concrete. In KRO mode those optional fields are schema proxies, so the composition omits them rather than emitting invalid YAML for absent values.
- **KRO credentials are reference-only.** KRO instances require `secretKeyRef`; inline
  `server.secret_key` is supported only in direct mode. This keeps plaintext credentials out of the
  custom resource. Raw GitOps instances that omit `secretKeyRef` fail closed and create no SearXNG
  workload resources.
- **KRO 0.9.2+ required.** See [Requirements](#requirements) above.

## Quick Start

```typescript
import { searxngBootstrap } from 'typekro/searxng';

const factory = searxngBootstrap.factory('direct', {
  namespace: 'search',
  waitForReady: true,
  kubeConfig,
});

await factory.deploy({
  name: 'searxng',
  // Passing namespace uses this externally owned namespace. Omit it to let
  // TypeKro create and own the default `searxng` namespace.
  namespace: 'search',
  server: { secret_key: process.env.SEARXNG_SECRET_KEY!, limiter: false },
  // search.formats only takes effect in direct mode — see "Known Limitations" above
  search: { formats: ['html', 'json'] },
});
```

## What Gets Deployed

| Resource | Name | Type |
|----------|------|------|
| Namespace | `searxng` | Namespace, created only when `namespace` is omitted |
| Settings | `{name}-config` | ConfigMap |
| Secret key | `{name}-secret` | Secret, created from inline `server.secret_key` in direct mode only |
| Search engine | `{name}` | Deployment |
| Service | `{name}` | Service (port 8080) |

## Configuration Reference

### Bootstrap Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | required | Instance name |
| `namespace` | `string` | — | Existing target namespace. Omit it to create and own the default `searxng` namespace. A supplied namespace is never deleted with the installation. |
| `enabled` | `boolean` | `true` | Direct-mode only. When `false`, direct mode creates no SearXNG resources. KRO mode rejects disabled instances because status depends on the Deployment; omit the KRO instance instead. |
| `image` | `string` | `'searxng/searxng:2026.3.29-7ac4ff39f'` | Container image (pinned to avoid breaking config changes between releases) |
| `replicas` | `number` | `1` | Number of replicas |
| `instanceName` | `string` | `name` | Displayed in the UI |
| `baseUrl` | `string` | auto | Base URL for links |
| `server` | object | — | Server configuration |
| `search` | object | — | Search configuration |
| `redisUrl` | `string` | — | Redis/Valkey URL for rate limiter |
| `secretKeyRef` | `{ name: string; key: string }` | — | Existing Secret key to use for `SEARXNG_SECRET`; required in KRO mode and skips the direct-mode auto-created Secret workflow |
| `settingsYaml` | `string` | — | Complete `settings.yml` content. In direct mode this overrides generated settings and is useful when KRO array templating limits apply |
| `env` | `Record<string, string>` | — | Extra environment variables |
| `resources` | object | — | CPU/memory requests and limits |

### Server Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `secret_key` | `string` | required in direct mode unless `secretKeyRef` is set | Session encryption key used for the direct-mode auto-created Secret; not accepted as the KRO credential source |
| `limiter` | `boolean` | — | Enable built-in rate limiter |
| `bind_address` | `string` | `'0.0.0.0:8080'` | Bind address |
| `method` | `string` | `'GET'` | HTTP method |

### Search Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `formats` | `string[]` | `['html', 'json']` | Response formats (`'html'`, `'json'`, `'csv'`, `'rss'`) |
| `default_lang` | `string` | — | Default language |
| `autocomplete` | `string` | — | Autocomplete provider |
| `safe_search` | `number` | — | Safe search (0=off, 1=moderate, 2=strict) |

> **Known limitation (KRO mode):** `search.formats` is a JavaScript array, and the composition serializes it by iterating the array at composition time. In **direct mode** the user-supplied value flows through correctly. In **KRO mode**, the field is a schema-proxy reference rather than a real array, so the composition can't enumerate it at composition time and falls back to the literal default `['html', 'json']`. `settingsYaml` is also direct-mode only because KRO mode sees it as a schema proxy, not a concrete string. Optional generated settings fields (`server.bind_address`, `server.method`, `search.default_lang`, `search.autocomplete`, `search.safe_search`) are also direct-mode only. If you need non-default formats or optional settings fields, deploy via direct mode. Array-valued CEL templating support is tracked in [yehudacohen/typekro#57](https://github.com/yehudacohen/typekro/issues/57) — once it lands, this limitation will be removed.

## Rate Limiter

SearXNG has a built-in rate limiter that uses Redis/Valkey. Pass both `redisUrl` and `server.limiter: true` to enable it in the bootstrap composition:

```typescript
await factory.deploy({
  name: 'searxng',
  redisUrl: 'redis://valkey:6379/0',
  server: { secret_key: process.env.SEARXNG_SECRET_KEY!, limiter: true },
});
```

The bootstrap composition automatically configures `redis.url` in settings.yml when `redisUrl` is provided, but it does not infer rate limiting from that URL. If you want Redis for another reason (e.g., as a shared cache backend) but don't want rate limiting, omit `server.limiter` or pass `server.limiter: false` explicitly:

```typescript
await factory.deploy({
  name: 'searxng',
  redisUrl: 'redis://valkey:6379/0',
  server: { secret_key: process.env.SEARXNG_SECRET_KEY!, limiter: false },
});
```

The lower-level `buildSearxngSettings()` helper still auto-enables the limiter when `redisUrl` is provided and `server.limiter` is omitted. The bootstrap composition does not use that helper for KRO-compatible templating, so set `server.limiter: true` explicitly when deploying with the composition.

## Using with Web App Composition

SearXNG works well alongside `webAppWithProcessing` — the Valkey cache can double as the rate limiter backend:

```typescript
import { searxngBootstrap } from 'typekro/searxng';
import { webAppWithProcessing } from 'typekro/webapp';

// Build the factories for each composition
const searchFactory = searxngBootstrap.factory('direct', { namespace: 'my-app', kubeConfig });
const appFactory = webAppWithProcessing.factory('direct', { namespace: 'my-app', kubeConfig });

// Deploy search engine
const search = await searchFactory.deploy({
  name: 'searxng',
  namespace: 'my-app',
  redisUrl: 'redis://my-app-cache:6379/0',
  secretKeyRef: { name: 'searxng-secret', key: 'secret_key' },
  search: { formats: ['html', 'json'] }, // ⚠️ direct mode only — see "Known Limitations"
});

// Deploy app stack with SEARXNG_URL
const app = await appFactory.deploy({
  name: 'my-app',
  app: {
    image: 'my-app:latest',
    port: 3000,
    env: { SEARXNG_URL: 'http://searxng.my-app:8080' },
  },
  // ...
});
```

## Status Fields

| Field | Type | Description |
|-------|------|-------------|
| `ready` | `boolean` | All replicas ready |
| `phase` | `'Ready' \| 'Installing' \| 'Disabled'` | Current phase |
| `failed` | `boolean` | Deployment failed |
| `url` | `string` | Internal service URL |

## Health Probes

SearXNG exposes `/healthz` for liveness and readiness probes. The deployment is configured with:
- **Liveness**: `GET /healthz` every 10s (5s initial delay)
- **Readiness**: `GET /healthz` every 5s (5s initial delay)
