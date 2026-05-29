---
title: Ory Factories
description: Factory functions and compositions for Ory Hydra, Kratos, Keto, Oathkeeper, and Maester resources
---

# Ory

TypeKro's Ory factories install the official Ory Helm charts and expose typed Maester resources for self-hosted identity stacks.

```ts
import * as ory from 'typekro/ory';
```

## What Is Included

- `oryHelmRepository` for the official Ory Helm repository.
- `hydraHelmRelease`, `kratosHelmRelease`, `ketoHelmRelease`, and `oathkeeperHelmRelease` for Flux-managed Ory charts.
- `oauth2Client` for Hydra Maester `OAuth2Client` resources.
- `oathkeeperRule` for Oathkeeper Maester `Rule` resources.
- `oryIdentityStack` for a high-level composition that wires the repository, Helm releases, Maester values, optional starter resources, and stack status.
- `oryPlatformStack` for a locally runnable graph that can create managed CNPG databases, Kubernetes Secrets, APISIX routes, a sample upstream, and then wire them into `oryIdentityStack`.
- `mapOryConfigToHelmValues`, `validateOryConfig`, health checks, metric signals, and typed chart/CRD schemas.

## Dependency Sources

Ory dependencies are explicit. Provide external values when another platform owns databases, secrets, routes, or courier infrastructure. Otherwise use `oryPlatformStack` to create managed local defaults as graph resources.

External Secret references are preferred for sensitive values:

```ts
const stack = ory.oryIdentityStack.factory('direct', {
  namespace: 'ory-system',
  waitForReady: true,
});

await stack.deploy({
  name: 'identity',
  namespace: 'ory-system',
  dependencySources: {
    hydra: {
      database: { dsn: { mode: 'external', value: { secretRef: { name: 'ory-dsns', key: 'hydra' } } } },
      systemSecret: { mode: 'external', value: { secretRef: { name: 'ory-secrets', key: 'hydra-system' } } },
    },
    kratos: {
      database: { dsn: { mode: 'external', value: { secretRef: { name: 'ory-dsns', key: 'kratos' } } } },
      secrets: {
        cookie: { mode: 'external', value: { secretRef: { name: 'ory-secrets', key: 'kratos-cookie' } } },
      },
    },
    keto: {
      database: { dsn: { mode: 'external', value: { secretRef: { name: 'ory-dsns', key: 'keto' } } } },
    },
    oathkeeper: {
      mutatorIdTokenJwks: {
        mode: 'external',
        value: { secretRef: { name: 'ory-secrets', key: 'oathkeeper-jwks' } },
      },
    },
  },
  hydra: {
    dsn: { secretRef: { name: 'ory-dsns', key: 'hydra' } },
    systemSecret: { secretRef: { name: 'ory-secrets', key: 'hydra-system' } },
    issuerUrl: 'https://hydra.example.com',
    loginUrl: 'https://login.example.com/login',
    consentUrl: 'https://login.example.com/consent',
  },
  kratos: {
    dsn: { secretRef: { name: 'ory-dsns', key: 'kratos' } },
    publicBaseUrl: 'https://kratos.example.com',
    secrets: {
      cookie: { secretRef: { name: 'ory-secrets', key: 'kratos-cookie' } },
    },
  },
  keto: {
    dsn: { secretRef: { name: 'ory-dsns', key: 'keto' } },
    namespaces: [{ id: 1, name: 'documents' }],
  },
  oathkeeper: {
    managedAccessRules: true,
    mutatorIdTokenJwks: { secretRef: { name: 'ory-secrets', key: 'oathkeeper-jwks' } },
  },
});
```

Explicit literal value sources are supported for controlled environments, but TypeKro rejects unsafe literals supplied through unapproved chart escape hatches.

## Managed Local Platform

Use `oryPlatformStack` for CI and local clusters when you want TypeKro to create local infrastructure instead of manually provisioning it first. The platform graph can create managed databases, local-only Secrets, routes, and a sample upstream before deploying Ory.

Managed Secrets are annotated with `typekro.dev/local-default: "true"` and are intended for local and CI bootstrap only. For production, provide external Secret references through `dependencySources` and disable `managed.secrets` so TypeKro does not create local default secret material.

```ts
const platform = ory.oryPlatformStack.factory('direct', {
  namespace: 'ory-test',
  waitForReady: true,
});

await platform.deploy({
  name: 'identity-test',
  namespace: 'ory-test',
  managed: {
    databases: true,
    secrets: true,
    routes: true,
    sampleUpstream: true,
  },
  maester: {
    hydra: { enabled: true, singleNamespaceMode: true },
    oathkeeper: { enabled: true, singleNamespaceMode: true },
  },
});
```

The ACK/SES courier path is planned and explicit: enable `managed.courierSes` only when you also provide the corresponding managed or external courier dependency source. Baseline local e2e does not create ACK/SES resources and does not require AWS.

## Maester Resources

Create Hydra OAuth2 clients and Oathkeeper rules as typed TypeKro resources:

```ts
ory.oauth2Client({
  id: 'consoleOAuth2Client',
  name: 'console',
  namespace: 'ory-system',
  spec: {
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    redirectUris: ['https://console.example.com/callback'],
    secretName: 'console-oauth2-client',
  },
});

ory.oathkeeperRule({
  id: 'apiRule',
  name: 'api-rule',
  namespace: 'ory-system',
  spec: {
    match: { methods: ['GET'], url: 'https://api.example.com/<.*>' },
    upstream: { url: 'http://api.default.svc.cluster.local' },
    authorizer: { handler: 'allow' },
  },
});
```

The factories include readiness evaluators for Hydra Maester Ready/reconciliation status and Oathkeeper Maester validation status.

## Operations

`validateOryConfig` reports unresolved dependency sources before manifests are emitted. `getOryHelmValueWarnings`, `getOryHealthChecks`, and `getOryMetricSignals` expose safe diagnostics without logging secret values, DSNs, or tokens.

If Helm resources fail, inspect the corresponding `HelmRelease` status and Flux controller logs, then verify Secret references and chart values with `validateOryConfig`. If Maester resources do not reconcile, verify that `oauth2clients.hydra.ory.sh` and `rules.oathkeeper.ory.sh` CRDs exist and inspect the Maester controller pods. If CNPG databases fail, inspect the `Cluster` status and the generated `*-db-app` Secret used for the DSN URI. If APISIX routes fail or the CRD is absent, disable `managed.routes` for baseline Ory validation or install APISIX before enabling managed routes.

Run the Ory e2e test with the integration suite when a Kubernetes test cluster is available:

```sh
bun run test:integration
```

The e2e flow deploys the managed platform stack, verifies managed dependencies, Helm resources, pods, and Maester CRDs, and creates representative `OAuth2Client` and `Rule` resources.
