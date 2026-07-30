---
title: Envoy AI Gateway Factories
description: Production Envoy AI Gateway platform, logical model routing, token accounting, and MCP resources
---

# Envoy AI Gateway Factories

TypeKro installs and composes the official Envoy AI Gateway rather than
reimplementing its controllers. The reviewed default tuple is:

- Envoy AI Gateway `v0.6.0`;
- Envoy Gateway `v1.7.0`;
- Gateway API `v1.4.1`;
- Kubernetes `1.32` or newer.

The integration uses the stable Envoy AI Gateway
`aigateway.envoyproxy.io/v1beta1` APIs and keeps the upstream CRD structures
behind a typed TypeKro adapter.

## Import

```typescript
import {
  makeEnvoyAIGateway,
  makeEnvoyAIGatewayPlatformInstallation,
} from 'typekro/envoy-ai-gateway';
```

## Logical model gateway

Provider topology and logical model routing are build-time inputs. Instance
identity, Namespace lifecycle, and listener port remain typed deployment
fields:

```typescript
const inference = makeEnvoyAIGateway({
  providers: [
    {
      name: 'reasoning-primary',
      kind: 'anthropic',
      credential: {
        name: 'anthropic-api-key',
      },
    },
    {
      name: 'reasoning-fallback',
      kind: 'openai',
      credential: {
        name: 'openai-api-key',
        namespace: 'platform-credentials',
      },
    },
  ],
  models: [
    {
      model: 'reasoning',
      targets: [
        {
          provider: 'reasoning-primary',
          model: 'claude-sonnet',
          priority: 0,
          weight: 100,
        },
        {
          provider: 'reasoning-fallback',
          model: 'gpt',
          priority: 1,
          weight: 100,
        },
      ],
    },
  ],
});

await inference.factory('kro', {
  namespace: 'ai-control',
}).deploy({
  name: 'research',
  namespace: 'research-ai',
  lifecycle: 'owned',
  listenerPort: 8080,
});
```

The resulting graph contains `GatewayConfig`, `Gateway`,
`AIServiceBackend`, `BackendSecurityPolicy`, `BackendTLSPolicy`,
`AIGatewayRoute`, and bounded retry/fallback policy resources. Credential
values remain in Kubernetes Secrets and never enter generated manifests.

`openai-compatible` backends support internal or third-party OpenAI protocol
services. Setting `tls: false` is intended for trusted in-cluster development
services; production vendor backends default to TLS with system CA
verification.

## Token accounting and rate limits

Common input, output, total, cached-input, cache-creation, and reasoning token
dimensions are captured by default as Envoy dynamic metadata. Override
`requestCosts` only when a provider requires another reviewed calculation.

Global token or request budgets use Envoy Gateway's global rate-limit service:

```typescript
const limited = makeEnvoyAIGateway({
  providers,
  models,
  rateLimit: {
    redisUrl: 'valkey.valkey-system.svc.cluster.local:6379',
    rules: [
      {
        identityHeader: 'x-applik8s-principal',
        requests: 100_000,
        unit: 'Hour',
        cost: 'total-tokens',
      },
      {
        requests: 100,
        unit: 'Minute',
        cost: 'request',
      },
    ],
  },
});
```

The Redis endpoint is protected platform configuration and participates in
the singleton installation fingerprint. Two application graphs cannot
silently reconfigure the same shared platform with different rate-limit
backends.

## Shared platform lifecycle

Application gateways reference one singleton platform owner. Deleting an
application instance cannot uninstall Envoy Gateway, its CRDs, or the AI
Gateway controller.

Use the explicit installation only for deliberate platform teardown:

```typescript
await makeEnvoyAIGatewayPlatformInstallation()
  .factory('kro', {
    namespace: 'typekro-singletons',
  })
  .deleteInstance('envoy-ai-gateway-platform');
```

Owned Namespaces are hoisted outside the RGD child graph and deleted only
after the owning instance has finalized. Use `factory.deleteInstance()` for
teardown; do not manually delete the RGD while instances remain.

`lifecycle: 'external'` omits the application Namespace when another platform
owns it.

## MCP routing

`envoyMCPRoute()` exposes the reviewed v1beta1 `MCPRoute` seam for a higher
level MCP adapter. It supports backend aggregation, exact or RE2 tool filters,
Secret-backed API keys, and explicit forwarded headers. Inline API keys are
intentionally not represented.

Application-facing MCP catalogs, authorization, protocol-version admission,
and operation execution remain responsibilities of the consuming framework;
the TypeKro factory only owns Kubernetes routing resources.

## Status

Direct and KRO factories expose the same complete status:

```typescript
{
  ready: boolean;
  failed: boolean;
  phase: 'Installing' | 'Ready' | 'Failed';
  endpoint: string;
  gatewayClassName: string;
  providerCount: number;
  acceptedProviderCount: number;
  routeAccepted: boolean;
  gatewayProgrammed: boolean;
  aiGatewayVersion: string;
}
```

Readiness requires the current observed generation for the platform,
`GatewayConfig`, `Gateway`, route, and every provider policy. Stale successful
conditions from an earlier generation cannot complete an update.
