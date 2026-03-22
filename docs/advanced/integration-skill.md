---
title: Creating TypeKro Integrations with AI
description: Agentic prompt for generating complete TypeKro integrations in a single shot
---

# TypeKro Integration Generation Skill

This document provides a structured prompt that an AI agent can follow to generate a complete TypeKro integration for any Kubernetes operator or CRD.

## Prerequisites

Before generating an integration, gather:

1. **Operator CRD API reference** — the spec and status fields for each custom resource
2. **Helm chart details** — repository URL, chart name, default version
3. **Readiness semantics** — how each resource reports readiness (conditions, phase, custom)

## Generation Prompt

Use the following as a system prompt or task description:

---

### Task: Generate a TypeKro integration for `{OPERATOR_NAME}`

**API Group:** `{API_GROUP}/{VERSION}` (e.g., `postgresql.cnpg.io/v1`)
**CRD Resources:** `{LIST_RESOURCES}` (e.g., Cluster, Backup, ScheduledBackup, Pooler)
**Helm Chart:** `{REPO_URL}` / `{CHART_NAME}` / `{DEFAULT_VERSION}`

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
└── cluster-resources.test.ts

docs/api/{name}/
└── index.md
```

#### Step 2: types.ts

Follow this exact pattern for every type:

```typescript
import { type Type, type } from 'arktype';

// 1. Common Kubernetes types (SecretKeyRef, LocalObjectReference, ResourceRequirements, Toleration)
//    Use precise union types for enums: 'Exists' | 'Equal', 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'

// 2. Bootstrap Config/Status (for Helm operator install)
//    Config: name, namespace?, version?, installCRDs?, replicaCount?, resources?, customValues?
//    Status: phase (union), ready (boolean), version? (string)
//    MUST have ArkType schemas: BootstrapConfigSchema, BootstrapStatusSchema

// 3. For each CRD resource:
//    - Config interface with name, namespace?, id?, spec: { ... }
//    - Status interface with observable fields
//    - ArkType schema: ConfigSchema
//    CRITICAL: The ArkType schema MUST cover ALL fields in the Config interface.
//    Every optional field in the interface must have a corresponding 'field?' in the schema.
//    Test this by going field-by-field through the interface and checking the schema matches.

// 4. Helm integration types
//    HelmRepositoryConfig, HelmReleaseConfig
```

**ArkType syntax reference:**
- Basic types: `'string'`, `'number'`, `'boolean'`
- Optional: `'fieldName?': 'string'`
- Arrays: `'string[]'` or `type({ name: 'string' }).array()`
- Records: `'Record<string, string>'`
- Unions: `'"value1" | "value2" | "value3"'`
- Nested objects: inline `{ field: 'string', 'optional?': 'number' }`

#### Step 3: Resource factories

Each resource factory follows this exact pattern:

```typescript
import { createConditionBasedReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { MyConfig, MyStatus } from '../types.js';

// Readiness evaluator — choose one:
// A) Condition-based (standard k8s pattern): createConditionBasedReadinessEvaluator({ kind: 'MyKind' })
// B) Phase-based (custom): function that checks status.phase
// C) Hybrid: condition-based with phase fallback (recommended for operators with both)

function createMyResource(config: MyConfig): Enhanced<MyConfig['spec'], MyStatus> {
  const fullConfig = {
    ...config,
    spec: { ...config.spec, /* apply defaults */ },
  };

  return createResource(
    {
      apiVersion: '{api_group}/{version}',
      kind: '{Kind}',
      metadata: {
        name: fullConfig.name,
        ...(fullConfig.namespace && { namespace: fullConfig.namespace }),
      },
      spec: fullConfig.spec,
      ...(fullConfig.id && { id: fullConfig.id }),
    },
    { scope: 'namespaced' }  // or 'cluster' for cluster-scoped
  ).withReadinessEvaluator(evaluator) as Enhanced<MyConfig['spec'], MyStatus>;
}

export const myResource = createMyResource;
```

#### Step 4: Helm resources (helm.ts)

```typescript
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

// sanitizeHelmValues — MUST use isKubernetesRef/isCelExpression type guards
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

#### Step 5: Bootstrap composition

```typescript
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { namespace } from '../../kubernetes/core/namespace.js';

// Pattern: namespace + HelmRepository + HelmRelease
// Status: Cel.expr for ready/phase from HelmRelease conditions
return {
  ready: Cel.expr<boolean>(
    _helmRelease.status.conditions,
    '.exists(c, c.type == "Ready" && c.status == "True")'
  ),
  phase: Cel.expr<'Ready' | 'Installing'>(
    _helmRelease.status.conditions,
    '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
  ),
  version: resolvedVersion,
};
```

#### Step 6: Tests

**Unit tests** — for each resource:
- Create with minimal config
- Create with comprehensive config
- Verify defaults applied
- Readiness evaluator: test EVERY possible state (ready, not-ready variants, missing status)

**Unit tests** — for helm:
- HelmRepository with defaults
- HelmRelease with defaults and custom values
- mapConfigToHelmValues with various inputs
- getHelmValueWarnings

**Integration tests:**
- Deploy operator via bootstrap composition with `waitForReady: true`
- Assert ALL status fields (ready, phase, version)
- Verify CRDs are available after operator deploy
- Create actual CRD resources and verify readiness
- Test YAML generation for KRO mode
- Clean up with deleteInstance and deleteNamespaceAndWait

#### Step 7: Documentation

- `docs/api/{name}/index.md` — API reference with import examples, factory docs, readiness tables, composition usage, prerequisites
- `docs/.vitepress/config.ts` — add sidebar nav entry in Ecosystems section
- `package.json` — add `"./{name}"` export with import and types paths

#### Step 8: Validation checklist

Before submitting:
- [ ] `bun run typecheck:lib` passes
- [ ] `bun run test` passes (no regressions)
- [ ] `bun test test/factories/{name}/` passes
- [ ] `bun test test/integration/{name}/` passes against real cluster
- [ ] Every interface field has a corresponding ArkType schema field
- [ ] Every readiness state has a unit test
- [ ] sanitizeHelmValues uses type guards, not raw property checks
- [ ] Toleration uses proper union types (Exists|Equal, NoSchedule|PreferNoSchedule|NoExecute)
- [ ] Docs page exists with sidebar nav entry
- [ ] Package.json export exists
- [ ] No `as any` in source code
- [ ] JSDoc on all public APIs with @example

### Code Style Rules

- 2 spaces, single quotes, 100 char lines, trailing commas ES5, semicolons
- `type` keyword for type-only imports
- External imports first, internal second, types last
- camelCase functions/variables, PascalCase types, UPPER_SNAKE constants
- Use `createResource` pattern (never raw k8s client in factories)
- Use `bun` (never npm)

### Common Mistakes to Avoid

1. **ArkType schema drift** — The #1 issue. Go field-by-field through every interface and verify the schema matches. Missing fields = silent validation failures for users. Check nested types too (e.g., if `ExternalCluster` has a `barmanObjectStore` field, the schema's `externalClusters` entry must also validate it).
2. **Raw property checks in sanitizeHelmValues** — Always use `isKubernetesRef()`/`isCelExpression()` from `utils/type-guards.js`. Never use `'__isKubernetesRef' in value`.
3. **String types for enums** — Use proper union types (`'Exists' | 'Equal'`) not `string`. This applies to Kubernetes types like Toleration.operator/effect, imagePullPolicy, etc.
4. **Missing `id` parameter** — Every resource in a composition MUST have `id: 'camelCase'`.
5. **Forgetting docs/exports** — Every integration needs: docs page, sidebar entry, package.json export.
6. **Testing only happy path** — Test ALL readiness states including failure, intermediate, and missing status.
7. **Dead-code defaults contradicting types** — If a field is required in the interface, don't add `?? defaultValue` in the factory. Either make it optional (with documented default) or don't add a fallback. The type and runtime must agree.
8. **DRY violation with `DEFAULT_FLUX_NAMESPACE`** — Import from `'../../../core/config/defaults.js'`, never redeclare locally.
9. **Status type wider than CEL expression** — If your CEL can only produce `'Ready' | 'Installing'`, don't type the status field as `'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading'`. The type must match what the runtime actually produces.
10. **Missing `conditions` on status types** — If your readiness evaluator uses `createConditionBasedReadinessEvaluator`, the status type must include `conditions?: Condition[]` even if the upstream docs don't prominently list it.
11. **sanitizeHelmValues drops more than proxies** — The JSON round-trip also drops Date, undefined, functions, Infinity, NaN. Add a comment noting custom values must be JSON-serializable.
12. **Incomplete nested schemas** — If an interface references a shared type (like `BarmanObjectStoreConfiguration`), every usage in the schema must include all the fields, not just a subset. Don't assume "the main schema covers it" — each nested reference in the schema is independent.
