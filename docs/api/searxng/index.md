---
title: SearXNG
description: Privacy-respecting metasearch engine integration
---

# SearXNG

Deploy [SearXNG](https://docs.searxng.org/) — a privacy-respecting metasearch engine that aggregates results from multiple providers (Google, Bing, DuckDuckGo, Brave, etc.).

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
| `formats` | `string[]` | `['html']` | Response formats (`'html'`, `'json'`, `'csv'`, `'rss'`) |
| `default_lang` | `string` | — | Default language |
| `autocomplete` | `string` | — | Autocomplete provider |
| `safe_search` | `number` | — | Safe search (0=off, 1=moderate, 2=strict) |

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

## Using with Web App Composition

SearXNG works well alongside `webAppWithProcessing` — the Valkey cache can double as the rate limiter backend:

```typescript
import { searxngBootstrap } from 'typekro/searxng';
import { webAppWithProcessing } from 'typekro/webapp';

// Deploy search engine
const search = await searchFactory.deploy({
  name: 'searxng',
  namespace: 'my-app',
  redisUrl: 'redis://my-app-cache:6379/0',
  search: { formats: ['html', 'json'] },
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
