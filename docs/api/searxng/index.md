---
title: SearXNG
description: Privacy-respecting metasearch engine integration
---

# SearXNG

Deploy [SearXNG](https://docs.searxng.org/) — a privacy-respecting metasearch engine that aggregates results from multiple providers (Google, Bing, DuckDuckGo, Brave, etc.).

## Requirements

- **KRO 0.9.1+** with the `CELOmitFunction` feature gate enabled. The composition uses `omit()` in its CEL expressions to drop optional fields that the user leaves unset — KRO 0.8.x will reject the resulting RGD at reconciliation time.
- TypeKro's bundled `typekro-runtime` already pins KRO 0.9.1 and enables the feature gate, so no manual configuration is needed if you bootstrap your cluster via `typekroRuntime.factory(...)`. If you install KRO yourself, add this to your Helm values:
  ```yaml
  config:
    featureGates:
      CELOmitFunction: true
  ```

## Known Limitations

- **`search.formats` is direct-mode only.** In KRO mode the user-supplied `formats` array is currently ignored and the composition falls back to the literal default `['html', 'json']`. This is because KRO's CEL mixed templates don't yet support iterating a schema array into a YAML list. If you need a custom `formats` list in KRO mode, deploy via direct mode, or provide a pre-built `settingsYaml` string with your desired formats. Array-valued CEL templating is tracked in [yehudacohen/typekro#57](https://github.com/yehudacohen/typekro/issues/57) and this limitation will be removed once it lands.
- **KRO 0.9.1+ required.** See [Requirements](#requirements) above.

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
  server: { secret_key: 'change-me-in-production', limiter: false },
  // search.formats only takes effect in direct mode — see "Known Limitations" above
  search: { formats: ['html', 'json'] },
});
```

## What Gets Deployed

| Resource | Name | Type |
|----------|------|------|
| Namespace | `searxng` | Namespace |
| Settings | `{name}-config` | ConfigMap |
| Search engine | `{name}` | Deployment |
| Service | `{name}` | Service (port 8080) |

## Configuration Reference

### Bootstrap Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | required | Instance name |
| `namespace` | `string` | `'searxng'` | Target namespace |
| `image` | `string` | `'searxng/searxng:2026.3.29-7ac4ff39f'` | Container image (pinned to avoid breaking config changes between releases) |
| `replicas` | `number` | `1` | Number of replicas |
| `instanceName` | `string` | `name` | Displayed in the UI |
| `baseUrl` | `string` | auto | Base URL for links |
| `server` | object | — | Server configuration |
| `search` | object | — | Search configuration |
| `redisUrl` | `string` | — | Redis/Valkey URL for rate limiter |
| `env` | `Record<string, string>` | — | Extra environment variables |
| `resources` | object | — | CPU/memory requests and limits |

### Server Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `secret_key` | `string` | — | Session encryption key |
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

> **Known limitation (KRO mode):** `search.formats` is a JavaScript array, and the composition serializes it by iterating the array at composition time. In **direct mode** the user-supplied value flows through correctly. In **KRO mode**, the field is a schema-proxy reference rather than a real array, so the composition can't enumerate it at composition time and falls back to the literal default `['html', 'json']`. If you need non-default formats in KRO mode, deploy via direct mode or pass a pre-built `settingsYaml` that contains the formats list you want. Array-valued CEL templating support is tracked in [yehudacohen/typekro#57](https://github.com/yehudacohen/typekro/issues/57) — once it lands, this limitation will be removed.

## Rate Limiter

SearXNG has a built-in rate limiter that uses Redis/Valkey. Pass a `redisUrl` to enable it:

```typescript
await factory.deploy({
  name: 'searxng',
  redisUrl: 'redis://valkey:6379/0',
  server: { limiter: true },
});
```

The composition automatically configures `redis.url` in settings.yml when `redisUrl` is provided.

### Auto-enable behavior

When you pass `redisUrl` without explicitly setting `server.limiter`, the limiter is **automatically enabled**. This matches the expectation that most users who provision Redis for SearXNG want rate limiting. If you want Redis for another reason (e.g., as a shared cache backend) but don't want rate limiting, pass `server.limiter: false` explicitly:

```typescript
await factory.deploy({
  name: 'searxng',
  redisUrl: 'redis://valkey:6379/0',
  server: { limiter: false }, // explicit opt-out — limiter stays off
});
```

The override is one-way — an explicit `false` always wins over the auto-enable. `undefined` or a missing `limiter` field triggers the auto-enable.

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
| `phase` | `'Ready' \| 'Installing'` | Current phase |
| `failed` | `boolean` | Deployment failed |
| `url` | `string` | Internal service URL |

## Health Probes

SearXNG exposes `/healthz` for liveness and readiness probes. The deployment is configured with:
- **Liveness**: `GET /healthz` every 10s (5s initial delay)
- **Readiness**: `GET /healthz` every 5s (5s initial delay)
