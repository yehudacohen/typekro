---
title: Creating TypeKro Integrations with AI
description: Agentic prompt for generating complete TypeKro integrations in a single shot
---

# TypeKro Integration Generation Skill

This document provides a structured prompt that an AI agent can follow to generate a complete TypeKro integration for any Kubernetes operator or CRD.

## Prerequisites

Before generating an integration, gather:

1. **Operator CRD API reference** — the spec and status fields for each custom resource. Read the Go types file (`api/v1/types.go`) if available — it's the source of truth.
2. **Helm chart details**:
   - Repository URL — is it HTTPS or OCI (`oci://`)? OCI requires `type: 'oci'` on the HelmRepository.
   - Chart name — for OCI, Flux constructs `{repo_url}/{chart_name}:{version}`, so verify the path.
   - Default version — check the exact tag format from GitHub releases (e.g., `v0.0.61-chart` vs `0.23.0`).
3. **Readiness semantics** — how each resource reports readiness (conditions, phase, top-level boolean, custom).

## Generation Prompt

Use the following as a system prompt or task description:

---

### Task: Generate a TypeKro integration for `{OPERATOR_NAME}`

**API Group:** `{API_GROUP}/{VERSION}` (e.g., `postgresql.cnpg.io/v1`)
**CRD Resources:** `{LIST_RESOURCES}` (e.g., Cluster, Backup, ScheduledBackup, Pooler)
**Helm Chart:** `{REPO_URL}` / `{CHART_NAME}` / `{DEFAULT_VERSION}`
**Helm Type:** HTTPS or OCI

#### Step 1: Create directory structure

```
src/factories/{name}/
├── types.ts
├── resources/
│   ├── {resource1}.ts
│   ├── {resource2}.ts
│   ├── helm.ts
│   └── index.ts
├── compositions/
│   ├── {name}-bootstrap.ts
│   └── index.ts
├── utils/
│   ├── helm-values-mapper.ts
│   └── index.ts
└── index.ts

test/factories/{name}/
├── {resource1}.test.ts
├── {resource2}.test.ts
├── helm.test.ts
└── ...

test/integration/{name}/
├── bootstrap-composition.test.ts
└── {resource}-resources.test.ts

docs/api/{name}/
└── index.md
```

#### Step 2: types.ts

```typescript
import { type Type, type } from 'arktype';

// 1. Common Kubernetes types (SecretKeyRef, LocalObjectReference, ResourceRequirements, Toleration)
//    Use precise union types: 'Exists' | 'Equal', 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'

// 2. Bootstrap Config/Status
//    Config: name, namespace?, version?, customValues?
//    Status: phase ('Ready' | 'Installing'), ready (boolean), failed (boolean), version? (string)
//    ⚠️ phase is two-state only — nested CEL ternaries break (#48)
//    ⚠️ Use `failed` boolean for failure detection (single .exists() is valid CEL)
//    MUST have ArkType schemas: BootstrapConfigSchema, BootstrapStatusSchema

// 3. For each CRD resource:
//    - Config interface with name, namespace?, id?, spec: { ... }
//    - Status interface with observable fields
//    - ArkType schema: ConfigSchema
//    ⚠️ CRITICAL: Go field-by-field through the interface and verify the schema matches.
//    ⚠️ Extract shared schema shapes (e.g., barmanObjectStoreSchemaShape) for types
//       used in multiple places to prevent drift.

// 4. Helm integration types
//    HelmRepositoryConfig (include type?: 'default' | 'oci' if operator uses OCI)
//    HelmReleaseConfig
```

**ArkType syntax reference:**
- Basic types: `'string'`, `'number'`, `'boolean'`
- Optional: `'fieldName?': 'string'`
- Arrays: `'string[]'` or `type({ name: 'string' }).array()`
- Records: `'Record<string, string>'`
- Unions: `'"value1" | "value2" | "value3"'`
- Nested objects: inline `{ field: 'string', 'optional?': 'number' }`

**Defaults rule:** If a field has a default, make it optional in both the interface and schema, and apply the default in the factory. Never have a required type with a `?? default` in the factory — the type and runtime must agree.

#### Step 3: Resource factories

Each resource factory follows this exact pattern:

```typescript
import { createConditionBasedReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { MyConfig, MyStatus } from '../types.js';

// Readiness evaluator — choose one:
// A) Condition-based (standard k8s): createConditionBasedReadinessEvaluator({ kind: 'MyKind' })
// B) Phase-based (custom): function that checks status.phase with named constants
// C) Top-level boolean + condition fallback (Hyperspike pattern)
// D) Hybrid: phase-based with condition fallback (CNPG pattern)

function createMyResource(config: MyConfig): Enhanced<MyConfig['spec'], MyStatus> {
  return createResource(
    {
      apiVersion: '{api_group}/{version}',
      kind: '{Kind}',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
      },
      spec: config.spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(evaluator) as Enhanced<MyConfig['spec'], MyStatus>;
}

export const myResource = createMyResource;
```

**If the operator has human-readable phase strings**, extract them as named constants:
```typescript
export const MY_OPERATOR_PHASES = {
  HEALTHY: 'Cluster in healthy state',
  SETTING_UP: 'Setting up primary',
} as const;
```

#### Step 4: Helm resources (helm.ts)

**Export shared constants** — version, repo URL, repo name. These must be used everywhere, never duplicated as string literals:

```typescript
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import {
  createHelmRepositoryReadinessEvaluator,
  helmRepository,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { helmRelease } from '../../helm/helm-release.js';

export const DEFAULT_MY_REPO_URL = 'https://charts.example.com';  // or 'oci://...'
export const DEFAULT_MY_VERSION = '1.0.0';
export const DEFAULT_MY_REPO_NAME = 'my-operator-repo';

// sanitizeHelmValues — MUST use type guards, not raw property checks
// Note: JSON round-trip also drops Date, functions, Infinity, NaN
function sanitizeHelmValues(values: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(values, (_key, value) => {
      if (isKubernetesRef(value)) return undefined;
      if (isCelExpression(value)) return undefined;
      return value;
    })
  );
}
```

**For OCI registries**, pass `type: 'oci'` to `helmRepository()`:
```typescript
helmRepository({
  name: config.name || DEFAULT_MY_REPO_NAME,
  namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
  url: config.url || DEFAULT_MY_REPO_URL,
  type: 'oci',  // ⚠️ Required for OCI — without this, Flux rejects the URL
  interval: config.interval || '5m',
});
```

#### Step 5: Bootstrap composition

```typescript
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { DEFAULT_MY_REPO_NAME, DEFAULT_MY_VERSION, myHelmRelease, myHelmRepository } from '../resources/helm.js';

// ⚠️ If the chart version differs from the app version (e.g., 'v0.0.61-chart' vs 'v0.0.61'),
//    strip the suffix for labels:
function stripChartSuffix(version: string): string {
  return version.replace(/-chart$/, '');
}

// Pattern: namespace + HelmRepository + HelmRelease
// Resources are _-prefixed — registered via side effects in the composition callback.

// Status pattern — ALWAYS include all three fields:
return {
  ready: Cel.expr<boolean>(
    _helmRelease.status.conditions,
    '.exists(c, c.type == "Ready" && c.status == "True")'
  ),
  // ⚠️ Phase is two-state only — nested CEL ternaries break (#48)
  phase: Cel.expr<'Ready' | 'Installing'>(
    _helmRelease.status.conditions,
    '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
  ),
  // ⚠️ Use separate failed boolean for failure detection
  failed: Cel.expr<boolean>(
    _helmRelease.status.conditions,
    '.exists(c, c.type == "Ready" && c.status == "False")'
  ),
  // ⚠️ Static — reflects deploy-time version, not runtime.
  // Document this limitation.
  version: appVersion,
};
```

**Labels:** Use `app.kubernetes.io/version` with the app version, not the chart version tag.

#### Step 6: Tests

**Unit tests** — for each resource:
- Create with minimal config
- Create with comprehensive config (all fields populated)
- Verify defaults applied (if any)
- Readiness evaluator: test EVERY possible state (ready, not-ready variants, missing status, intermediate states)
- Authentication/TLS configuration variants

**Unit tests** — for helm:
- HelmRepository with defaults (verify URL, namespace, type)
- HelmRelease with defaults and custom values
- `sanitizeHelmValues`: plain values survive intact (strings, numbers, booleans, nested objects, arrays), empty input returns defined object. ⚠️ This is consistently flagged in reviews — always include these tests.
- mapConfigToHelmValues with various inputs (including verifying bootstrap-only fields like `name`/`namespace`/`version` are NOT passed through)
- Version override test must assert the actual version value, not just other fields
- getHelmValueWarnings (if any)

**Integration tests:**
- Deploy operator via bootstrap composition with `waitForReady: true`
- Assert ALL status fields: `ready`, `phase`, `failed`, `version`
- Test YAML generation for KRO mode
- Test both `'kro'` and `'direct'` factory mode creation
- Clean up with `deleteInstance` and `deleteNamespaceAndWait`
- ⚠️ Run with parallel kubectl monitoring via a background Bash command (not a subagent — subagents can't run Bash). Monitor HelmRepository, HelmRelease, HelmChart, and pods every 15s to catch OCI pull errors, CrashLoopBackOff, or SourceNotReady early.

#### Step 7: Documentation

`docs/api/{name}/index.md`:
- Import examples
- Quick example with real-world config
- Factory reference with all options
- Readiness state table
- Bootstrap composition with status field docs
- Note about `phase` limitation and `failed` field for failure detection
- Note about `'kro'` vs `'direct'` factory modes
- Prerequisites (operator install, cert-manager for TLS, etc.)
- Links to upstream docs

Also update:
- `docs/.vitepress/config.ts` — sidebar nav entry (alphabetical in Ecosystems)
- `package.json` — `"./{name}"` export with `import` and `types` paths

#### Step 8: Self-review checklist

Before submitting, verify each item:

**Type safety:**
- [ ] Every interface field has a corresponding ArkType schema field (go field-by-field)
- [ ] Shared nested types extracted as `const schemaShape = { ... } as const` to prevent duplication drift
- [ ] No `as any` in source code
- [ ] Toleration uses proper union types
- [ ] `exactOptionalPropertyTypes`: never pass `undefined` explicitly to optional fields in tests

**Constants & coupling:**
- [ ] All string literals that appear more than once are extracted as exported constants
- [ ] Helm repo name, version, URL are constants used by both the factory and the composition
- [ ] `DEFAULT_FLUX_NAMESPACE` imported from core, not redeclared locally

**Status & CEL:**
- [ ] Bootstrap status has: `ready`, `phase` ('Ready' | 'Installing'), `failed`, `version?`
- [ ] Phase uses simple two-state ternary (no nested `.exists()`)
- [ ] `failed` uses separate single `.exists()` expression
- [ ] Status type exactly matches what the CEL actually produces
- [ ] `version` is documented as deploy-time, not runtime
- [ ] Labels use app version (stripped of `-chart` suffix if needed)

**Helm:**
- [ ] `sanitizeHelmValues` uses `isKubernetesRef`/`isCelExpression` type guards
- [ ] OCI registries have `type: 'oci'` on HelmRepository
- [ ] Chart version tag format verified from operator's GitHub releases

**Tests:**
- [ ] Every readiness state has a unit test
- [ ] Integration test asserts ALL status fields
- [ ] Helm unit tests verify defaults, custom values, readiness evaluators

**Docs & exports:**
- [ ] API reference page exists with readiness table and limitations noted
- [ ] Sidebar nav entry added (alphabetical order)
- [ ] `package.json` export added
- [ ] JSDoc on all public APIs with `@example`
- [ ] JSDoc version strings match the `DEFAULT_*_VERSION` constant exactly (no `v` prefix mismatch)

### Code Style Rules

- 2 spaces, single quotes, 100 char lines, trailing commas ES5, semicolons
- `type` keyword for type-only imports
- External imports first, internal second, types last
- camelCase functions/variables, PascalCase types/interfaces, UPPER_SNAKE constants
- Use `createResource` pattern (never raw k8s client in factories)
- Use `bun` (never npm)

### Common Mistakes to Avoid

1. **ArkType schema drift** — The #1 issue across both CNPG and Valkey PRs. Go field-by-field. Extract shared schema shapes for types used in multiple places.
2. **Raw property checks in sanitizeHelmValues** — Use `isKubernetesRef()`/`isCelExpression()`.
3. **String types for enums** — Use union types (`'Exists' | 'Equal'`).
4. **Missing `id` parameter** — Every resource in a composition MUST have `id: 'camelCase'`.
5. **Forgetting docs/exports** — Docs page, sidebar entry, package.json export.
6. **Testing only happy path** — Test ALL readiness states.
7. **Dead-code defaults contradicting types** — Type and runtime must agree.
8. **DRY violation with constants** — Import `DEFAULT_FLUX_NAMESPACE` from core. Extract repo name/version/URL as exported constants.
9. **Status type wider than CEL expression** — Type must match runtime output.
10. **Missing `conditions` on status types** — If using condition-based evaluator, status needs `conditions?`.
11. **sanitizeHelmValues drops more than proxies** — Document that custom values must be JSON-serializable.
12. **Incomplete nested schemas** — Each nested schema reference is independent.
13. **Nested CEL ternaries** — Only simple two-state ternaries work. Use `failed` boolean for failure detection. See [#48](https://github.com/yehudacohen/typekro/issues/48).
14. **OCI Helm repositories** — Need `type: 'oci'`, have no status field, version tag format varies per operator.
15. **String literal coupling** — After writing, grep for any string that appears in both a factory default and a composition. Extract as a constant.
16. **Chart version in labels** — `app.kubernetes.io/version` should be the app version, not the chart tag. Strip `-chart` suffix.
17. **Missing `sanitizeHelmValues` tests** — Every review flags this. Always test that plain values survive and proxy objects are stripped. This is the safety barrier between the magic proxy and Helm YAML.
18. **JSDoc version prefix mismatch** — If `DEFAULT_VERSION = '0.3.1'`, don't write `@default 'v0.3.1'` in JSDoc. Users copy from docs and pass the wrong value.
19. **Spreading the magic proxy in compositions** — `{ ...spec }` doesn't work for nested proxy objects. Access fields explicitly: `{ name: spec.name, inngest: spec.inngest }`. Use `Object.assign` with conditional spreads for optional fields to satisfy `exactOptionalPropertyTypes`.
20. **Hex key format for Inngest** — `eventKey` and `signingKey` must be hex strings. Test keys like `'test-key'` will crash the container. Use `'deadbeef0123456789abcdef01234567'` in tests.
