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

**CRD field names:** ⚠️ ArkType schema field names MUST match the CRD's OpenAPI schema field names exactly. KRO validates CEL paths against the CRD's schema — mismatches cause the RGD to be rejected as `Inactive`. Check the CRD: `kubectl get crd {name} -o jsonpath='{.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties}'`. For example, CNPG uses `storageClass` (not `storageClassName`).

#### Step 3: Resource factories

Each resource factory follows this exact pattern:

```typescript
import { createConditionBasedReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { MyConfig, MyStatus } from '../types.js';

// Readiness evaluator — choose one:
// A) Condition-based (standard k8s): createConditionBasedReadinessEvaluator({ kind: 'MyKind' })
// B) Phase-based (custom): function that checks status.phase with named constants
// C) Top-level boolean + condition fallback (Hyperspike pattern)
// D) Hybrid: phase-based with condition fallback (CNPG pattern)

// ⚠️ Use Composable<MyConfig> — not MyConfig — to accept composition proxy objects.
function createMyResource(config: Composable<MyConfig>): Enhanced<MyConfig['spec'], MyStatus> {
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
    // Use 'cluster' for cluster-scoped resources (Namespace, ClusterRole, etc.)
    { scope: 'namespaced' }
  ).withReadinessEvaluator(evaluator) as Enhanced<MyConfig['spec'], MyStatus>;
}

export const myResource = createMyResource;
```

**Cluster-scoped resources:** Use `{ scope: 'cluster' }` for Namespaces, ClusterRoles, CRDs, etc. This is needed for readiness polling (omits namespace from API calls) and deletion ordering.

**Operator-required labels:** Some operators (e.g., Hyperspike Valkey) panic if labels are nil. Always include `app.kubernetes.io/name`, `app.kubernetes.io/instance`, and `app.kubernetes.io/managed-by: typekro` on resources where the operator copies labels to child resources.

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

**Shared resource lifecycle:** HelmRepositories that live in shared namespaces like `flux-system` must be marked with `lifecycle: 'shared'` so they survive instance deletion:
```typescript
import { setMetadataField } from '../../../core/metadata/index.js';

const repo = myHelmRepository({ ... });
setMetadataField(repo, 'lifecycle', 'shared');
```

**Custom values merge:** The helm-values-mapper uses recursive deep merge for `customValues`. Plain objects merge key-by-key at arbitrary depth. Arrays and primitives replace. Prototype pollution is guarded (`__proto__`, `constructor`, `prototype` keys are skipped).

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
//
// ⚠️ Use ?? (not ||) for all defaults to prevent 0 from being treated as falsy:
//    const port = spec.port ?? 3000;  // ✓
//    const port = spec.port || 3000;  // ✗ (0 becomes 3000)
//
// ⚠️ If referencing operator-generated secrets by name convention, document the
//    operator version: `const secretName = \`${name}-${owner}\`; // CNPG v1.25`

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
- **Ground-truth pod verification**: After status assertions, run `kubectl get pods -n {ns} -o json` and verify all pods are Running with all containers Ready. Allow up to 10 restarts for KRO mode (simultaneous deploy causes transient CrashLoopBackOff while dependencies start).
- Test YAML generation for KRO mode
- Test both `'kro'` and `'direct'` factory mode creation
- **Cleanup**: Use `factory.deleteInstance(name)` only — it handles the full lifecycle (instance → RGD → CRD). Do NOT manually delete RGDs, CRDs, or namespaces — KRO's finalizer handles child resource cleanup including Namespaces. The only manual cleanup needed is the factory namespace itself.
- ⚠️ afterAll hooks should log errors, not silently swallow: `catch (e) { console.error('cleanup failed:', e.message); }`
- Use random namespace suffixes (`Math.random().toString(36).slice(2, 7)`) for parallel-safe isolation.
- ⚠️ Run with parallel kubectl monitoring via a background Bash command (not a subagent — subagents can't run Bash). Monitor HelmRepository, HelmRelease, HelmChart, and pods every 15s to catch OCI pull errors, CrashLoopBackOff, or SourceNotReady early.

**Deep merge for customValues:**
- Test one-level deep merge (existing keys preserved)
- Test two-level deep merge (nested objects merged recursively)
- Test array replacement (not concatenation)
- Test primitive override

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

#### Step 8: Build, lint, and self-review checklist

Run the full build and lint before reviewing:
```bash
bun run typecheck:lib    # type-check
bun run lint             # Biome lint — must have 0 errors
bun run test             # full test suite — 0 failures
bun test test/factories/{name}/       # integration-specific unit tests
bun test test/integration/{name}/     # integration tests against cluster
```

⚠️ `bun run lint` catches unused imports, which the pre-commit hook and CI will reject. Always run it before pushing.

Then verify each item:

**Type safety:**
- [ ] Every interface field has a corresponding ArkType schema field (go field-by-field)
- [ ] ArkType schema field names match CRD OpenAPI schema field names exactly (check with kubectl)
- [ ] All factory functions use `Composable<MyConfig>` (not `MyConfig`)
- [ ] Shared nested types extracted as `const schemaShape = { ... } as const` to prevent duplication drift
- [ ] No `as any` in source code
- [ ] Toleration uses proper union types
- [ ] `exactOptionalPropertyTypes`: never pass `undefined` explicitly to optional fields in tests
- [ ] All defaults use `??` (not `||`) to preserve falsy values like `0`

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
- [ ] Cross-namespace HelmRepositories (flux-system) marked `lifecycle: 'shared'`
- [ ] `customValues` deep merge tested at 2+ levels of nesting

**Resource metadata:**
- [ ] Cluster-scoped resources use `{ scope: 'cluster' }` in `createResource`
- [ ] Resources that operators copy labels from have required `app.kubernetes.io/*` labels
- [ ] K8s API catch blocks check `statusCode ?? code ?? body?.code` (not just `statusCode`)

**Tests:**
- [ ] Every readiness state has a unit test
- [ ] Integration test asserts ALL status fields (ready, phase, failed, version)
- [ ] Helm unit tests verify defaults, custom values, readiness evaluators
- [ ] `sanitizeHelmValues` tests construct mock branded objects with `Symbol.for('TypeKro.KubernetesRef')` and `Symbol.for('TypeKro.CelExpression')` and verify they are STRIPPED (not just that plain values pass through). KubernetesRef mocks need both `resourceId` and `fieldPath` string properties.
- [ ] Values mapper test verifies bootstrap-only fields (`name`, `namespace`, `version`) are NOT in output
- [ ] Version override test asserts the actual version value, not just other fields
- [ ] No `exactOptionalPropertyTypes` violations (no `replicaCount: undefined` — use conditional spreads)
- [ ] Config interface fields not exposed in the Helm chart (e.g., `type` on OCI-only repos) are removed from the interface, not silently ignored
- [ ] Integration test cleanup uses `factory.deleteInstance()` only (no manual RGD/CRD/namespace deletion)
- [ ] Integration test includes ground-truth pod health verification via kubectl
- [ ] afterAll hooks log errors instead of silently swallowing

**Docs & exports:**
- [ ] API reference page exists with readiness table and limitations noted
- [ ] Sidebar nav entry added (alphabetical order)
- [ ] `package.json` export added
- [ ] JSDoc on all public APIs with `@example`
- [ ] JSDoc version strings match the `DEFAULT_*_VERSION` constant exactly (no `v` prefix mismatch)

#### Step 9: Maintainer self-review (BEFORE opening PR)

After all tests pass, conduct a thorough self-review before opening a PR. This step prevents 2-3 review rounds.

**Run the full diff and review it as a picky maintainer:**
```bash
git diff master...HEAD --stat  # see all changed files
git diff master...HEAD -- src/ # review all source changes
```

**Review as if you're deciding whether to APPROVE or REQUEST CHANGES. Check:**

1. **Schema/interface alignment** — Open types.ts. For EVERY field in every Config interface, verify the ArkType schema has a matching entry. Don't skim — go line by line. This is the #1 source of review feedback.

2. **String literal grep** — Run `grep -rn "'your-repo-name'" src/factories/{name}/` and verify every occurrence is a constant reference, not a duplicated literal. Check composition, factory defaults, and test assertions.

3. **sanitizeHelmValues test quality** — Do the tests actually construct branded objects and verify stripping? Or do they only test that plain values pass through? The latter is NOT sufficient and will be flagged.

4. **Status field completeness** — Does the integration test assert ALL status fields? (`ready`, `phase`, `failed`, `version`). Missing any one will be caught in review.

5. **Dead code / unused fields** — Any interface field that's accepted but silently ignored in the factory? Any exported constant that's not actually used? Any default that can never trigger because the type is required?

6. **Docs accuracy** — Do JSDoc version strings match the DEFAULT_*_VERSION constant? Do docs examples use only imports that actually exist? Are unused imports removed?

7. **Comment quality** — Do inline comments explain WHY, not WHAT? Is the proxy spreading limitation documented? Are _-prefixed variables explained?

**If you find issues during self-review, fix them before opening the PR.** The goal is zero blocking items on first external review.

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
21. **CRD field name mismatch** — ArkType schema field names must match the CRD's OpenAPI schema exactly. KRO validates CEL paths against the CRD. Check with: `kubectl get crd {name} -o jsonpath='{.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties}'`. Go struct field tags (JSON tags) are the source of truth, not Go field names (e.g., Valkey uses `nodes` in JSON, not `Shards` from the Go struct).
22. **Missing `Composable<T>` on factory signatures** — All factory functions must accept `Composable<MyConfig>` (not `MyConfig`) so they work inside compositions where proxy objects are passed. Import from `'../../../core/types/index.js'`.
23. **Missing `lifecycle: 'shared'` on cross-namespace resources** — HelmRepositories in `flux-system` must be marked shared, otherwise graph-based deletion removes shared infrastructure.
24. **Missing `scope: 'cluster'` on cluster-scoped resources** — Namespaces, ClusterRoles, etc. need `{ scope: 'cluster' }` in `createResource` for correct readiness polling and deletion ordering.
25. **Using `||` instead of `??` for defaults** — `||` treats `0` as falsy. Use `??` for all optional fields with defaults: `spec.port ?? 3000`.
26. **Manually deleting RGDs/CRDs/namespaces in tests** — Use `factory.deleteInstance()` which handles the full cleanup graph. Manual deletion causes zombie instances and stale CRDs.
27. **K8s API error format** — `@kubernetes/client-node` `ApiException` uses `.code` (not `.statusCode`) for HTTP status. All catch blocks must check: `error.statusCode ?? error.code ?? error.body?.code`.
28. **Operator-required labels** — Some operators (e.g., Hyperspike Valkey) panic on nil label maps. Always include standard `app.kubernetes.io/*` labels on resources where the operator copies labels to child resources.
