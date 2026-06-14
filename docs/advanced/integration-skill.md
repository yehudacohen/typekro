---
title: Creating TypeKro Integrations with AI
description: Agentic prompt for generating complete TypeKro integrations in a single shot
---

# TypeKro Integration Generation Skill

This document provides a structured prompt that an AI agent can follow to generate a complete TypeKro integration for any Kubernetes operator or CRD.

## Prerequisites

Before generating an integration, gather:

1. **Operator CRD API reference** — the spec and status fields for each custom resource. Read the Go types file (`api/v1/types.go`) if available — it's the source of truth.
2. **Freshness research** — verify the current stable upstream version and API surface before writing code. Check official docs, GitHub releases, ArtifactHub or OCI registry metadata, chart `values.yaml`, CRD OpenAPI schemas, and install/upgrade notes. Record any deprecated API versions, required companion controllers, compatibility matrix entries, and breaking changes since the repo's previously known version.
3. **Helm chart details** — record repository URL, chart name, Helm type, and default version. For OCI repositories, Flux constructs `{repo_url}/{chart_name}:{version}`, so verify the path and pass `type: 'oci'` to the HelmRepository. Check the exact tag format from GitHub releases (e.g., `v0.0.61-chart` vs `0.23.0`).
4. **Readiness semantics** — how each resource reports readiness (conditions, phase, top-level boolean, custom).
5. **Upstream ownership boundary** — identify the official operator, Helm chart, CRDs, and helper controllers. Prefer official upstream components over custom TypeKro controllers or bespoke charts unless the user explicitly asks for custom infrastructure.
6. **Dependency contract** — list every dependency as `managed` or `external`: databases, Secrets, routes, object storage, email, DNS, TLS, cloud IAM, and sample upstreams. For managed dependencies, identify the exact generated resource names and keys consumed by Helm values (for example CNPG `*-db-app` Secret key `uri`). For security-sensitive inputs, decide whether the integration requires explicit secret material, an external `secretKeyRef`, or an explicit generation mode; never silently invent hidden secret state.
7. **Baseline local requirements** — define what must work in local/CI without external DNS, TLS, SMTP, cloud credentials, or ingress controllers. Optional integrations should be opt-in, not required for the baseline.
8. **Direct and KRO mode expectations** — decide which resources can exist in direct-only YAML and which must be valid in a graph-native RGD. Optional CRDs absent from common test clusters must not make the RGD inactive. If direct mode supports a disabled/no-op instance, verify KRO status can also avoid omitted resources; otherwise document the option as direct-mode only and tell KRO users to omit the instance.

## Integration Author Mental Model

TypeKro integrations are not generic SDK wrappers. They are graph-aware resource compositions that must
work in three execution shapes: direct deploy, KRO ResourceGraphDefinition generation, and plain YAML
generation. Most sharp edges come from forgetting which values are concrete TypeScript data and which
values are runtime graph references.

Keep these boundaries explicit:

- **Typed convenience fields** are for common, validated, field-selectable configuration. Model fields
  structurally when the composition or mapper reads nested paths such as `schema.spec.webserver.image`.
- **`values` is the raw Helm passthrough** for full chart compatibility. Raw chart areas that are only
  forwarded do not need exhaustive TypeScript modeling.
- **Do not infer Helm chart child resources.** If TypeKro owns a HelmRelease, status should usually be
  derived from the HelmRelease and HelmRepository, not from Deployments, Pods, Jobs, or Secrets created
  by the chart.
- **Graph-aware values are first-class values.** Kubernetes refs, CEL expressions, schema proxy paths,
  and values-merge expressions must be preserved, not cloned into plain JSON, stringified, or coerced.
- **KRO schema visibility is intentional.** If generated YAML field-selects a path, ArkType must expose
  that path structurally. If a field is truly opaque raw passthrough, do not field-select inside it.

For Helm-chart integrations, the main design decision is not "how can we model the whole chart?" It is
"which chart paths need TypeKro validation, defaults, references, or status-safe access?" Model those
paths. Leave the rest to `values`.

**Two integration shapes.** Most of this skill assumes shape (a), but recognise which you're building:

- **(a) Helm/operator bootstrap** — wraps a chart (HelmRepository + HelmRelease) or an operator's CRDs.
  Status is derived from the HelmRelease/CR conditions via `Cel.expr`. The `values`/mapper/sanitizer steps
  below apply.
- **(b) Config-driven workload** — runs an upstream image directly with user-supplied config: a ConfigMap
  holding the config + a Deployment mounting it + a Service + (optionally) a PVC, with **no** Helm, operator,
  or CRD (e.g. the Caddy reverse-proxy integration). For these, **skip the entire Helm/`values`/mapper
  apparatus**. Use the built-in `configMap()/deployment()/service()/persistentVolumeClaim()/namespace()`
  factories, build status with **direct proxy comparisons** (not `Cel.expr`), and ship config as a rendered
  string built by a pure helper. The workload-specific gotchas are rules 51–60. The two shapes share
  everything about KRO-safety, the magic proxy, `??` defaults, `id`s, tests, docs, and self-review.

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

The ArkType schema is the **single source of truth** for types. Config types are INFERRED from schemas (never hand-written interfaces). Only Status types are hand-written interfaces (they represent K8s API responses, not user input).

```typescript
import { type } from 'arktype';
// Only import `Type` if you need it as a generic parameter (rare).

// 1. Common Kubernetes types (SecretKeyRef, LocalObjectReference, ResourceRequirements, Toleration)
//    Use precise union types: 'Exists' | 'Equal', 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'

// 2. Bootstrap Config — ArkType schema, then infer the type:
export const MyBootstrapConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'values?': 'Record<string, unknown>',
  // ... operator-specific fields
});
export type MyBootstrapConfig = typeof MyBootstrapConfigSchema.infer;

// 3. Bootstrap Status — hand-written interface (represents K8s API response):
//    ⚠️ ALWAYS include: ready, phase, failed, version
//    ⚠️ phase is two-state only — nested CEL ternaries break (#48)
export const MyBootstrapStatusSchema = type({
  ready: 'boolean',
  phase: '"Ready" | "Installing"',
  failed: 'boolean',
  'version?': 'string',
});
export type MyBootstrapStatus = typeof MyBootstrapStatusSchema.infer;

// 4. For each CRD resource — schema-first, then infer:
export const MyResourceConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'id?': 'string',
  spec: { /* CRD spec fields */ },
});
export type MyResourceConfig = typeof MyResourceConfigSchema.infer;

// 5. Status interface (hand-written — represents observable K8s status fields):
export interface MyResourceStatus {
  ready?: boolean;
  conditions?: Array<{ type: string; status: string; message?: string }>;
}
```

⚠️ CRITICAL: Go field-by-field through the CRD's OpenAPI schema and verify the ArkType schema matches. Extract shared schema shapes as `const schemaShape = { ... } as const` for types used in multiple places.

⚠️ You will likely revisit types.ts as you write resource factories and compositions. The schema is the source of truth — keep it updated as you discover needed fields.

**ArkType syntax reference:**
- Basic types: `'string'`, `'number'`, `'boolean'`
- Optional: `'fieldName?': 'string'`
- Arrays: `'string[]'` or `type({ name: 'string' }).array()`
- Records: `'Record<string, string>'`
- Unions: `'"value1" | "value2" | "value3"'`
- Nested objects: inline `{ field: 'string', 'optional?': 'number' }`

**Defaults rule:** If a field has a default, make it optional in both the interface and schema, and apply the default in the factory. Never have a required type with a `?? default` in the factory — the type and runtime must agree.

**Schema invariants:** Encode user-facing invariants in ArkType schemas whenever possible. Use `.narrow()` for conditional rules that cannot be represented as a simple shape, such as "enabled instances require either `server.secret_key` or `secretKeyRef`". Keep the base object schema shape intact so KRO SimpleSchema generation can still discover fields. Use factory-specific runtime guards only for mode-specific constraints the shared schema cannot express, such as a direct-only `enabled: false` option that is unsafe in KRO status.

**Secret-source rule:** If the app requires a stable secret, require explicit material or a ref in the schema. Valid options are usually `server.secret_key`/`secretKey` to create a Kubernetes Secret, or `secretKeyRef` to use an existing Secret. Do not generate random values inside a composition, during `toYaml()`, or during RGD serialization; composition functions are re-executed and graph rendering must be deterministic. If a future integration adds generation, make it an explicit deploy-time mode that creates/reuses a persisted Secret before applying the graph and only reports the Secret ref, never the secret value.

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

// ⚠️ sanitizeHelmValues is NOT needed when using the helmRelease() wrapper.
// The wrapper handles proxy serialization internally. Only add sanitizeHelmValues
// if you use createResource() directly for HelmReleases (rare).
```

#### Step 4.5: Helm values mapper (utils/helm-values-mapper.ts)

Every integration needs a mapper that translates the TypeKro config into Helm chart values:

```typescript
import type { MyBootstrapConfig } from '../types.js';

export function mapMyConfigToHelmValues(config: MyBootstrapConfig): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  // Map TypeKro config fields to the Helm chart's values.yaml structure.
  // ⚠️ Bootstrap-only fields (name, namespace, version) must NOT appear in output.
  // ⚠️ Use ?? for defaults: config.replicaCount ?? 1

  if (config.replicaCount != null) values.replicaCount = config.replicaCount;

  // Map nested config to chart-specific structure
  values.myOperator = {
    key1: config.operatorConfig?.key1,
    key2: config.operatorConfig?.key2,
  };

  // Deep merge user-provided Helm values last — recursive, prototype-safe.
  if (config.values) {
    deepMerge(values, config.values);
  }

  return values;
}

// Recursive deep merge (plain objects merge, arrays/primitives replace)
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const targetValue = target[key];
    if (sourceValue !== null && typeof sourceValue === 'object' && !Array.isArray(sourceValue) &&
        targetValue !== null && typeof targetValue === 'object' && !Array.isArray(targetValue)) {
      deepMerge(targetValue as Record<string, unknown>, sourceValue as Record<string, unknown>);
    } else {
      target[key] = sourceValue;
    }
  }
}
```

**Shared resource lifecycle:** HelmRepositories that live in shared namespaces like `flux-system` must be marked with `lifecycle: 'shared'` so they survive instance deletion:
```typescript
import { setMetadataField } from '../../../core/metadata/index.js';

const repo = myHelmRepository({ ... });
setMetadataField(repo, 'lifecycle', 'shared');
```

**Helm values passthrough:** Use `values` as the primary user-facing passthrough API for chart values. Avoid parallel knobs like `customValues`, `extraValues`, `literalOnly`, or `directOnly` unless you have a concrete compatibility reason. The helm-values-mapper uses recursive deep merge for `values`: plain objects merge key-by-key at arbitrary depth; arrays and primitives replace; prototype pollution is guarded (`__proto__`, `constructor`, `prototype` keys are skipped). Add regression tests that prove framework/runtime values survive whole-map graph merges.

**Typed fields vs raw values:** Typed convenience fields and raw `values` have different jobs:
- Add typed fields for chart paths that are common, safety-sensitive, cross-resource referenced, or
  need validation before deploy/YAML generation.
- Keep unusual or fast-changing chart areas in `values`; do not chase the entire upstream `values.yaml`
  unless the user explicitly asks for a complete typed surface.
- If typed config and raw `values` target the same chart path, raw `values` should merge last so users
  can intentionally override defaults.
- Arrays should normally replace rather than concatenate. Concatenation usually surprises chart users
  and can duplicate containers, env vars, volumes, or deployment entries.

**KRO schema visibility rule:** If the mapper or composition reads `spec.some.path`, the ArkType schema
must expose `some.path` as a structured object. Do not use broad `object` or `Record<string, unknown>`
for a value you later field-select in KRO-generated YAML. Opaque objects are fine only when they are
passed through wholesale.

Example: if the mapper needs `schema.spec.webserver.image.repository`, model at least:

```typescript
const imageSchemaShape = {
  repository: 'string',
  'tag?': 'string',
  'pullPolicy?': '"Always" | "IfNotPresent" | "Never"',
} as const;

export const MyBootstrapConfigSchema = type({
  name: 'string',
  'webserver?': {
    'image?': imageSchemaShape,
    'replicaCount?': 'number',
  },
  'values?': 'Record<string, unknown>',
});
```

If KRO rejects an RGD with an error like `type 'string' does not support field selection`, look for a
generated expression that selects through an opaque schema field. Fix the schema shape or stop selecting
inside that raw field.

**Graph-aware values merge rule:** Treat Kubernetes refs, CEL expressions, schema proxy values, and
values-merge expressions as runtime values, not JSON. Do not use JSON cloning, object spreading as a
deep clone, or string interpolation that can produce `[object Object]`. When raw values overlay typed
values in KRO mode, preserve typed graph-aware fields at sibling paths. For example, a raw
`values.dagsterWebserver.service.type` override must not erase a typed graph-aware
`webserver.image.repository` that selects from `schema.spec.webserver.image.repository`.

Good regression assertions for graph-aware Helm values:
- Generated RGD YAML contains expected `schema.spec.*` paths for typed fields.
- Generated RGD YAML contains `json.unmarshal(json.marshal(schema.spec.values))` or the expected merge
  expression for raw passthrough.
- Generated YAML does not contain raw markers such as `__KUBERNETES_REF_`, internal schema keys,
  `[object Object]`, or `undefined`.
- Unit mapper tests prove refs/CEL survive inside nested raw `values`.

**Dependency-source resolution:** If the integration wires managed infrastructure into Helm charts, keep dependency resolution explicit and test it thoroughly:
- Managed dependencies should reference the actual producer's output, not a guessed placeholder. For CNPG app databases, use the generated application Secret/key (`*-db-app`, key `uri`) when the chart needs a DSN with credentials.
- External dependencies should accept Secret refs or literal URLs only where production-safe.
- Values mappers must validate unresolved dependencies early with structured errors.
- Do not pass raw schema proxies or raw `values` into graph fallback values if the chart requires concrete strings or nested config. Build a graph-safe fallback config and let the mapper emit deterministic defaults. Preserve user/runtime `values` in the final graph merge; do not drop whole-map values while constructing graph-safe fallbacks.
- Add tests that inspect generated RGD YAML for the exact Secret names/keys and required chart defaults.

**For OCI registries**, pass `type: 'oci'` to `helmRepository()`:
```typescript
helmRepository({
  name: config.name ?? DEFAULT_MY_REPO_NAME,
  namespace: config.namespace ?? DEFAULT_FLUX_NAMESPACE,
  url: config.url ?? DEFAULT_MY_REPO_URL,
  type: 'oci',  // ⚠️ Required for OCI — without this, Flux rejects the URL
  interval: config.interval ?? '5m',
});
```

#### Step 5: Bootstrap composition

```typescript
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { DEFAULT_MY_REPO_NAME, DEFAULT_MY_VERSION, myHelmRelease, myHelmRepository } from '../resources/helm.js';
import { mapMyConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { type MyBootstrapConfig, MyBootstrapConfigSchema, MyBootstrapStatusSchema } from '../types.js';

// Complete composition export — this is the public API:
export const myBootstrap = kubernetesComposition(
  {
    name: 'my-bootstrap',
    kind: 'MyBootstrap',
    spec: MyBootstrapConfigSchema,
    status: MyBootstrapStatusSchema,
  },
  (spec: MyBootstrapConfig) => {
    const resolvedNamespace = spec.namespace ?? 'my-system';
    const resolvedVersion = spec.version ?? DEFAULT_MY_VERSION;
    const helmValues = mapMyConfigToHelmValues({ ...spec, namespace: resolvedNamespace, version: resolvedVersion });

    // Resources are _-prefixed — registered via side effects in the composition callback.
    // ⚠️ Spreading spec is safe here (mapper input), but NOT for objects passed to resource factories.
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
  }  // end of composition callback
);
```

**Labels:** Use `app.kubernetes.io/version` with the app version, not the chart version tag.

**Multi-resource compositions (non-bootstrap):** For compositions that combine multiple CRD resources (not just Helm), use direct property comparisons on resource proxy objects for status — do NOT use `Cel.expr`:
```typescript
return {
  ready: database.status.readyInstances >= (spec.instances ?? 1) &&
         cache.status.ready &&
         app.status.readyReplicas >= appReplicas,
  components: {
    database: database.status.readyInstances >= (spec.instances ?? 1),
    cache: cache.status.ready,
    app: app.status.readyReplicas >= appReplicas,
  },
};
```
`Cel.expr` is only needed for bootstrap (Helm-based) compositions where status is derived from conditions arrays.

⚠️ For a Deployment, prefer comparing against the resource's own desired count (`app.status.readyReplicas >= app.spec.replicas`) over a captured JS const (`>= appReplicas`) — the const bakes the literal into KRO and makes readiness ignore the configured replica count, and `status.replicas` is a t=0 false-positive. See rule 53. (For a CRD whose desired count is a spec field, the same principle applies; `?? 1` on a proxy still bakes a literal in KRO.)

**Platform compositions with nested stacks:** If a composition creates managed infrastructure and then calls a nested integration stack:
- Keep the infrastructure ownership in the platform composition and pass dependencies through typed dependency sources.
- Rebuild status field-by-field from nested status handles. Do not pass a nested `status` object wholesale into the parent status; KRO may serialize nested object references into invalid expressions.
- KRO graph fallback should contain only graph-safe values. Strip raw `values`, Secret value sources, and optional service config that can become `omit()` where Helm requires a concrete string. Preserve user/runtime `values` in the final merge path so graph-safe fallbacks do not erase chart passthrough values.
- Omit optional CRDs from the RGD when the CRD may not exist in baseline clusters. It is fine for concrete direct-mode YAML to include optional resources gated by a concrete spec flag.
- KRO status may only reference resources that are present for every schema-valid KRO instance. If a resource is conditionally omitted, either make the status field independent of that resource, split direct-only behavior from KRO behavior, or reject that KRO instance shape with a clear factory-specific error.
- Do not create a `Namespace` resource in a KRO graph for the same namespace that contains the KRO instance. Create test namespaces outside the graph, deploy the instance into them, then delete those namespaces after `deleteInstance`.

**Barrel exports (`index.ts`):** Each directory needs a barrel export:
```typescript
// src/factories/{name}/index.ts
export { myBootstrap } from './compositions/index.js';
export { myResource } from './resources/index.js';
export type { MyConfig, MyStatus } from './types.js';
```

#### Step 6: Tests

**Unit tests** — for each resource:
- Create with minimal config
- Create with comprehensive config (all fields populated)
- Verify defaults applied (if any)
- Readiness evaluator: test EVERY possible state (ready, not-ready variants, missing status, intermediate states)
- Authentication/TLS configuration variants

**Unit tests** — for helm:
- HelmRepository with defaults (verify URL, namespace, type)
- HelmRelease with defaults and user-provided `values`
- mapConfigToHelmValues with various inputs (including verifying bootstrap-only fields like `name`/`namespace`/`version` are NOT passed through)
- Raw `values` merge last while preserving typed values at unrelated sibling paths
- Refs and CEL expressions survive inside nested Helm values and generated RGD YAML
- Graph-aware arrays pass through directly when they are schema refs; concrete arrays still get defaults or replacement semantics as intended
- Version override test must assert the actual version value, not just other fields
- getHelmValueWarnings (if any)

**Integration tests:**
- Deploy operator via bootstrap or platform composition with `waitForReady: true`
- Assert every status field declared by that composition's status schema. Bootstrap stacks usually expose `ready`, `phase`, `failed`, and `version`; platform stacks may expose infrastructure, dependency, component, and endpoint fields instead.
- **Ground-truth pod verification**: After status assertions, run `kubectl get pods -n {ns} -o json` and verify all pods are Running with all containers Ready. Allow up to 10 restarts for KRO mode (simultaneous deploy causes transient CrashLoopBackOff while dependencies start).
- Test YAML generation for KRO mode
- Test both `'kro'` and `'direct'` factory mode creation
- For dependency-managing integrations, run live direct AND KRO e2e before calling the work complete. Unit/YAML tests are not enough; they will miss chart runtime config, generated Secret mismatches, Flux install failures, and KRO finalizer behavior.
- When KRO readiness stalls, inspect cluster state over time instead of guessing: RGD state, instance state, HelmReleases, pods, jobs, generated Secrets, operator CRs, and logs. Prefer background test execution plus repeated `kubectl` checks for long e2e runs.
- Verify generated in-cluster HelmRelease values, not just local YAML. In-cluster values prove the RGD, KRO expression evaluation, and Flux handoff produced the expected chart config.
- **Cleanup**: Use `factory.deleteInstance(name)` for instance-owned resources. Do NOT manually delete RGDs, CRDs, or patch finalizers during normal cleanup. Test namespaces created outside the graph may be deleted after `deleteInstance`; do not include the namespace that contains a KRO instance as a child resource in that same KRO graph, or KRO finalizer deletion can deadlock.
- ⚠️ afterAll hooks should log errors, not silently swallow: `catch (e) { console.error('cleanup failed:', e.message); }`
- Use random namespace suffixes (`Math.random().toString(36).slice(2, 7)`) for parallel-safe isolation.
- ⚠️ Run with parallel kubectl monitoring via a background Bash command (not a subagent — subagents can't run Bash). Monitor HelmRepository, HelmRelease, HelmChart, and pods every 15s to catch OCI pull errors, CrashLoopBackOff, or SourceNotReady early.
- Do not materialize command strings, logs, generated YAML snapshots, or debugging output into repo files unless the user explicitly asks for a committed artifact. Use temp paths outside the workspace for long-running logs.

**Deep merge for values:**
- Test one-level deep merge (existing keys preserved)
- Test two-level deep merge (nested objects merged recursively)
- Test array replacement (not concatenation)
- Test primitive override
- Test whole-map graph merges so user/runtime chart values survive KRO serialization and final resource emission

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

⚠️ **Checkpoint:** Run `bun run typecheck:lib` after completing Steps 2-5 (types, factories, composition) to catch type errors before writing tests.

Run the full build and lint before reviewing:
```bash
bun run typecheck        # type-check (lib + examples + tests)
bun run lint             # Biome lint — must have 0 errors
bun run test             # full unit test suite — 0 failures (uses bun run test, NOT bun test)
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
- [ ] Default operator/chart version was verified against current official releases or registry metadata during this task
- [ ] CRD API group/version and Helm values schema were verified against current upstream docs or CRDs, not copied from stale examples

**Status & CEL:**
- [ ] Bootstrap status has: `ready`, `phase` ('Ready' | 'Installing'), `failed`, `version?`; platform status has all declared infrastructure/dependency/component fields asserted in tests
- [ ] Phase uses simple two-state ternary (no nested `.exists()`)
- [ ] `failed` uses separate single `.exists()` expression
- [ ] Status type exactly matches what the CEL actually produces
- [ ] KRO status references only resources that exist for every schema-valid KRO instance; direct-only disabled/no-op paths are documented or rejected in KRO mode
- [ ] `version` is documented as deploy-time, not runtime
- [ ] Labels use app version (stripped of `-chart` suffix if needed)

**Helm:**
- [ ] If the integration implements `sanitizeHelmValues` directly, it uses `isKubernetesRef`/`isCelExpression` type guards. If it delegates to `helmRelease()`, no local sanitizer is needed.
- [ ] OCI registries have `type: 'oci'` on HelmRepository
- [ ] Chart version tag format verified from operator's GitHub releases
- [ ] Cross-namespace HelmRepositories (flux-system) marked `lifecycle: 'shared'`
- [ ] `values` deep merge tested at 2+ levels of nesting, including a graph-mode whole-map merge regression
- [ ] Values mapper excludes bootstrap-only fields (`name`, `namespace`, `version`) from Helm output
- [ ] Typed fields that are field-selected in KRO YAML have structured ArkType schema paths, not opaque `object` fields
- [ ] Raw `values` merge last while preserving graph-aware typed sibling fields in KRO mode

**Integration:**
- [ ] Integration test covers both `'kro'` and `'direct'` factory modes
- [ ] Config types are inferred from ArkType schemas (`typeof Schema.infer`), not hand-written interfaces
- [ ] Schema-level invariants reject invalid enabled configs early (for example missing secret sources) without relying only on late composition errors
- [ ] Live e2e proves both direct and KRO modes for dependency-managing stacks
- [ ] Generated in-cluster HelmRelease values reference the expected managed Secrets and concrete chart defaults
- [ ] KRO RGD reaches `Active True`, KRO instance reaches ready, and cleanup via `deleteInstance` completes
- [ ] Optional CRD-backed resources do not make the baseline RGD inactive when the optional CRD is absent

**Resource metadata:**
- [ ] Cluster-scoped resources use `{ scope: 'cluster' }` in `createResource`
- [ ] Resources that operators copy labels from have required `app.kubernetes.io/*` labels
- [ ] K8s API catch blocks check `statusCode ?? code ?? body?.code` (not just `statusCode`)
- [ ] KRO graph does not own the namespace containing its own instance
- [ ] Nested config fields named `id` are preserved when they are chart/CRD config, not TypeKro metadata

**Tests:**
- [ ] Every readiness state has a unit test
- [ ] Integration test asserts every field declared by the status schema, not just `ready`
- [ ] Helm unit tests verify defaults, user-provided `values`, readiness evaluators
- [ ] If a local `sanitizeHelmValues` exists, tests construct mock branded objects with `Symbol.for('TypeKro.KubernetesRef')` and `Symbol.for('TypeKro.CelExpression')` and assert the intended behavior. If using `helmRelease()`, tests should instead verify refs/CEL are preserved through nested Helm values.
- [ ] Values mapper test verifies bootstrap-only fields (`name`, `namespace`, `version`) are NOT in output
- [ ] Version override test asserts the actual version value, not just other fields
- [ ] No `exactOptionalPropertyTypes` violations (no `replicaCount: undefined` — use conditional spreads)
- [ ] Config interface fields not exposed in the Helm chart (e.g., `type` on OCI-only repos) are removed from the interface, not silently ignored
- [ ] Integration test cleanup uses `factory.deleteInstance()` for instance-owned resources; test harness namespaces created outside the graph may be deleted after instance cleanup
- [ ] Integration test includes ground-truth pod health verification via kubectl
- [ ] afterAll hooks log errors instead of silently swallowing
- [ ] Tests assert dependency-source contracts, including generated Secret names/keys and graph-safe fallback defaults

**Docs & exports:**
- [ ] API reference page exists with readiness table and limitations noted
- [ ] Direct-only options are explicitly labeled; docs do not promise KRO behavior for instance shapes the KRO factory rejects
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

1. **Freshness check** — Confirm the selected default version, CRD API versions, Helm chart values, install docs, and compatibility notes are current. If upstream has a newer version than the one used, document why the integration pins the older version.

2. **Schema/interface alignment** — Open types.ts. For EVERY field in every Config interface, verify the ArkType schema has a matching entry. Don't skim — go line by line. This is the #1 source of review feedback.

3. **String literal grep** — Run `grep -rn "'your-repo-name'" src/factories/{name}/` and verify every occurrence is a constant reference, not a duplicated literal. Check composition, factory defaults, and test assertions.

4. **sanitizeHelmValues test quality** — Do the tests actually construct branded objects and verify stripping? Or do they only test that plain values pass through? The latter is NOT sufficient and will be flagged.

5. **Status field completeness** — Does the integration test assert every field declared by the status schema? Bootstrap stacks usually include `ready`, `phase`, `failed`, and `version`; platform stacks should assert infrastructure, dependencies, nested component readiness, and endpoints.

6. **Dead code / unused fields** — Any interface field that's accepted but silently ignored in the factory? Any exported constant that's not actually used? Any default that can never trigger because the type is required?

7. **Docs accuracy** — Do JSDoc version strings match the DEFAULT_*_VERSION constant? Do docs examples use only imports that actually exist? Are unused imports removed?

8. **Comment quality** — Do inline comments explain WHY, not WHAT? Is the proxy spreading limitation documented? Are _-prefixed variables explained?

9. **Framework vs integration bug classification** — If the integration needed a workaround for serialization, KRO fallback, nested `id`, status references, or TypeScript-to-CEL conversion, ask whether it belongs in core instead. Prefer a framework fix plus regression test over integration-specific hacks.

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
2. **Raw property checks in sanitizer code** — If you implement local Helm-value sanitization, use `isKubernetesRef()`/`isCelExpression()` instead of raw property checks. Prefer delegating to `helmRelease()` when possible so refs/CEL are preserved by the existing Helm machinery.
3. **String types for enums** — Use union types (`'Exists' | 'Equal'`).
4. **Missing `id` parameter** — Every resource in a composition MUST have `id: 'camelCase'`.
5. **Forgetting docs/exports** — Docs page, sidebar entry, package.json export.
6. **Testing only happy path** — Test ALL readiness states.
7. **Dead-code defaults contradicting types** — Type and runtime must agree.
8. **DRY violation with constants** — Import `DEFAULT_FLUX_NAMESPACE` from core. Extract repo name/version/URL as exported constants.
9. **Status type wider than CEL expression** — Type must match runtime output.
10. **Missing `conditions` on status types** — If using condition-based evaluator, status needs `conditions?`.
11. **Sanitizer logic drops graph-aware values** — Document the intended behavior. Some integrations need to strip proxy markers before concrete YAML; HelmRelease values generally need to preserve refs/CEL so KRO can resolve them at reconcile time.
12. **Incomplete nested schemas** — Each nested schema reference is independent.
13. **Nested CEL ternaries** — Only simple two-state ternaries work. Use `failed` boolean for failure detection. See [#48](https://github.com/yehudacohen/typekro/issues/48).
14. **OCI Helm repositories** — Need `type: 'oci'`, have no status field, version tag format varies per operator.
15. **String literal coupling** — After writing, grep for any string that appears in both a factory default and a composition. Extract as a constant.
16. **Chart version in labels** — `app.kubernetes.io/version` should be the app version, not the chart tag. Strip `-chart` suffix.
17. **Testing the wrong Helm-value boundary** — If using `helmRelease()`, do not add a redundant local sanitizer just to satisfy a pattern. Test the actual boundary: defaults, raw `values`, mapper output, nested refs/CEL preservation, and generated RGD YAML. Only test `sanitizeHelmValues` directly when the integration owns sanitizer code.
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
29. **Using `createResource` for standard K8s types** — Always use the built-in factories (`configMap()`, `secret()`, `deployment()`, etc.) instead of `createResource` directly for standard K8s resources. The built-in factories include readiness evaluators that the deployment engine requires. Without a readiness evaluator, `waitForReady: true` will fail with "No readiness evaluator found."
30. **Composition functions must be side-effect-free beyond resource creation** — During KRO schema generation, the framework re-executes the composition function with a synthetic spec (optional fields set to `undefined`, required fields set to a sentinel) to detect `??` defaults that reference imported constants and to detect ternary-controlled optional sections. The framework ALSO re-executes inside `processCompositionBodyAnalysis` with a hybrid schema proxy to capture resources from branches the proxy run didn't take (e.g., `if (!spec.x) { createResource(...) }`). This happens automatically whenever `toYaml()` is called or an RGD is deployed. The re-execution runs inside a temporary, isolated composition context so resource registrations are contained — but **any other side effects fire a second time**:
    - `console.log`/metrics/tracing calls will double-emit.
    - HTTP requests, file reads, or any I/O performed at composition time will run twice.
    - Non-deterministic values (`Date.now()`, `Math.random()`, `crypto.randomUUID()`) produce different outputs between the proxy run and the defaults run, which breaks ternary detection by making unrelated sections look ternary-controlled.
    - Closures that capture stateful objects (caches, counters) may observe doubled mutations.

    **Rules of thumb:**
    - All work inside a composition function should be resource construction (`factory.Deployment(...)`, `createResource(...)`, returning status objects).
    - If you need logging, do it outside the composition (in `factory.deploy(...)` callers) or in status-building code paths that aren't re-executed.
    - If you need a deterministic ID, derive it from a spec field — do not call `crypto.randomUUID()`.
    - Re-execution failures are caught and logged at debug level; the framework degrades gracefully to only the regex-based default extraction, but compositions that *silently* produce wrong YAML due to non-determinism will not trigger the catch block. When debugging KRO schemas that look wrong, set `DEBUG=typekro:schema-defaults` to see re-execution diagnostics.
31. **Never use `simple.Secret` for stringData values that come from the schema proxy** — `simple.Secret` eagerly base64-encodes stringData at composition time via `Buffer.from(value).toString('base64')`. That works fine for concrete strings in direct mode, but for KRO mode it would encode the proxy's `__KUBERNETES_REF__` marker token — producing a valid-looking but WRONG base64 value in the final Secret, and the user's actual secret would never make it into the cluster. The factory now throws a clear error when it detects a `KubernetesRef` proxy or marker-containing string in stringData, but you should reach for the low-level `secret()` factory from `'typekro/factories/kubernetes/config/secret'` from the start when building compositions that pass schema references through to a Secret. The low-level factory passes `stringData` through untouched so KRO resolves the reference at reconcile time. **Rule of thumb**: if the Secret's value comes from a template literal or direct property access on `spec`, use low-level `secret()`. If it's a literal string or an inline-built concrete string (direct mode only), `simple.Secret` is fine.
32. **Compositions should read as plain TypeScript — don't reach for explicit `Cel.*` helpers** — The framework's composition analyzer handles JS-to-CEL conversion for most common patterns:
    - `if (!spec.optional) { createResource(...) }` → `includeWhen: ${!has(schema.spec.optional)}` with the resource's full content captured via differential execution.
    - `if/else` → both branches compiled with opposite `includeWhen` conditions.
    - `spec.x ? a : b` at the top-level or NESTED inside a factory argument's object → CEL ternary at the correct dotted path.
    - Field-level differences inside custom factories (e.g., `env[].valueFrom.secretKeyRef.name`) driven by an optional field → auto-generated CEL `has(...) ? <proxy> : <hybrid>` conditionals, detected by walking the proxy-run and hybrid-run resource trees in parallel.
    - Template literals with interpolated proxy references → KRO mixed-template format (`literal${string(ref)}literal`).
    - `??` with literal fallbacks and with imported constants → auto-detected as schema defaults (`| default="..."`).

    **Prefer writing compositions as if they're plain JavaScript — if a pattern doesn't work, report it as a framework gap rather than reaching for `Cel.expr(...)` / `Cel.conditional(...)` / `Cel.has(...)` as a workaround. The explicit helpers are escape hatches for edge cases, not the default way to express conditionals.** Some things are still hard JS language limits (you can't intercept `??` on a proxy because JS evaluates it eagerly), but the framework covers the overwhelming majority of use cases and improves over time. When you hit a gap, file an issue linking to https://github.com/yehudacohen/typekro/issues/57 (AST-based analysis rewrite) and document the workaround inline.
33. **Fix framework limitations at the framework level** — Related to rule #32: if a composition needs an ugly workaround (`isKubernetesRef(spec.x) ? ... : ...` to detect KRO mode, explicit `Cel.conditional(...)` blocks, private imports of internal helpers), treat it as a FRAMEWORK BUG and fix the framework instead. Workarounds buried in compositions become invisible to future maintainers and proliferate; framework-level fixes benefit every downstream composition. The `if (!spec.x)`-driven differential capture that now ships in TypeKro was originally an ad-hoc `Cel.not(Cel.has(spec.x))` construct in the SearXNG composition — when the author insisted on native-TypeScript ergonomics, the framework grew the capability, and the composition became ~30 lines shorter.
34. **Optional-field overrides in differential capture are scoped to "tested" fields only** — The `processCompositionBodyAnalysis` hybrid-spec re-execution only overrides optional fields that appear in an `if`-condition or equivalent test (extracted from the AST analyzer's `includeWhen` expressions). Fields accessed unconditionally (e.g., `spec.server?.secret_key` inside a `stringData: { secret_key: ... }` object) are left as proxy references so their values flow through correctly in the captured resources. When adding a new conditional pattern, make sure the field you're testing appears in a way the `conditionToCel` bare-reference pattern recognises (`schema.spec.X` or `!schema.spec.X`); compound conditions (`spec.x && spec.y`) don't currently get extracted, so the override set will be empty and the branch capture will silently fail. Tracked in https://github.com/yehudacohen/typekro/issues/57.
35. **KRO graph fallback values must not carry optional schema-proxy service config into Helm values** — For Helm values that require concrete defaults (for example Ory Kratos `identity.schemas[].id` and `selfservice.default_browser_return_url`), build a graph-safe fallback config that strips raw `values`, Secret sources, and optional service overrides. Let the mapper emit deterministic defaults, preserve user/runtime `values` in the final merge path, and assert the generated RGD contains those defaults. Optional proxy branches can produce `omit()` expressions in places the chart expects concrete strings.
36. **Nested `id` is valid resource config, not always TypeKro metadata** — Resource factories use top-level `id` as the graph node identifier, but Helm values and CRD specs may also contain legitimate nested `id` fields. Serializer/reference-processing code must only remove hidden TypeKro metadata such as `__resourceId`; do not globally drop every key named `id`. Add regression assertions when an integration relies on nested ids.
37. **Managed operator credentials should reference the operator-generated Secret, not a hand-written placeholder** — If a database operator like CNPG creates application credentials, point consuming Helm values at the generated Secret/key (for CNPG app users, commonly `*-db-app` and key `uri`). A placeholder DSN Secret without the generated password may pass YAML tests but will fail live migrations with database authentication errors.
38. **Do not trust local RGD YAML alone for KRO integrations** — Local YAML proves serialization, but not KRO expression evaluation, Flux handoff, generated Secret availability, or chart runtime validation. For stacks that create dependencies and HelmReleases, inspect the live HelmRelease after KRO creates it and verify the final `spec.values` matches expectations.
39. **Status passthrough must be field-by-field** — Passing nested status objects from a child stack into a parent status can serialize to invalid or unevaluable KRO expressions. Rebuild parent status one field at a time from child handles: booleans, phase, component map entries, endpoint strings, and version.
40. **Optional CRDs must not poison baseline KRO mode** — If APISIX, ACK, cert-manager, or another optional CRD is not part of the baseline, do not emit those resources in graph-native RGD generation. Gate them on concrete direct-mode specs or require explicit user setup. Status must match what the graph actually owns; if KRO mode omits APISIX route resources, route infrastructure should report unmanaged/false rather than implying managed routes exist.
41. **Artifact hygiene matters during integration work** — Long e2e logs belong in temp directories, not the repo. Do not create backup files, generated command artifacts, checked-in debug YAML, or alternate implementation files. If a generated artifact is useful, document the command that reproduces it instead of committing the generated output.
42. **Schema-first invariants beat late factory surprises** — If an enabled integration cannot run without a field (for example a SearXNG secret source), enforce that invariant in the ArkType schema with `.narrow()` or a precise union. Keep mode-specific guards only for constraints the shared schema cannot express, such as direct-only `enabled: false` behavior that KRO status cannot support.
43. **KRO status must match KRO-owned resources** — Do not let status reference a resource that can be omitted by `includeWhen`. If direct mode can return a static disabled status but KRO status is tied to a Deployment/HelmRelease, reject disabled KRO instances or remove the status dependency. KRO users can omit an instance; a broken reconciler status is worse than an explicit error.
44. **Secret generation must be explicit and persistent** — Do not call `Math.random()`, `crypto.randomUUID()`, or similar inside a composition or YAML render to create secret material. Kubernetes can persist a Secret, but the composition/RGD renderer cannot safely implement "generate once if missing" without a deploy-time controller step. Require `secretKeyRef` or explicit secret material, or add a clearly named deploy-time generation mode that creates/reuses the Secret before graph reconciliation.
45. **`values` is the Helm passthrough API** — Prefer `values` for raw chart passthrough and deep merge it last. Avoid new user-facing knobs like `customValues`, `extraValues`, `literal-only`, or `direct-only` to work around serialization issues. Fix framework merge/serialization bugs or keep graph-safe fallbacks internal instead.
46. **Opaque schemas cannot be field-selected in KRO** — `Record<string, unknown>` and broad `object` fields are fine for raw passthrough, but not for paths the mapper reads. If generated YAML uses `schema.spec.webserver.image.repository`, the ArkType schema must structurally expose `webserver.image.repository`.
47. **Raw values overlays can erase typed graph-aware fields** — When typed config and raw `values` target the same chart section, make sure partial raw overlays do not replace the entire typed graph-aware object. Preserve typed sibling fields such as images, Secret refs, and pod config while still letting raw values merge last.
48. **Graph-aware arrays are not always concrete arrays** — A schema ref to an array is a runtime value. Do not wrap it in another array or call `.map()` on it unless you first know it is a concrete array. Concrete arrays can receive defaults item-by-item; graph-aware array refs should usually pass through directly.
49. **Skipped live deploy is not acceptance for deployment integrations** — YAML and unit tests are necessary but insufficient when the integration claims a full deploy path. Use architecture-compatible images, local image builders, or explicit pullable images and prove direct/KRO readiness when the acceptance scenario requires it.
50. **Stale generated KRO definitions can hide schema fixes** — If a live KRO test keeps reporting old schema behavior after the source changed, check whether an old ResourceGraphDefinition or generated CRD is still present. Prefer normal cleanup, but for tests that intentionally recreate the same RGD name, reset stale definitions in setup and document why.

---

**Rules 51–60 — config-driven workload compositions (shape (b)).** These come from building the Caddy integration (run an upstream image with user config, no Helm/operator/CRD). Several are sharp edges that unit tests pass right over — a live deploy is what catches them.

51. **Model list-shaped config as a rendered STRING, not a structured array** — If the workload's config is a list (routes, rules, vhosts), do NOT add a `routes[]` schema field and `.map()` it inside the composition: in KRO that array is a graph proxy that can't be mapped at graph-generation time (rule #48). Model the field as the raw config string (`caddyfile: 'string'`) and ship a PURE `renderX(routes, opts?)` helper that consumers call in concrete contexts to build the string. The composition stays a string passthrough — byte-identical in direct and KRO modes — and the helper is trivially unit-testable in isolation.

52. **Default container images: one full `repo:tag` field, never `` `${image}:${version}` ``** — A template literal that interpolates an optional `version` derefs it in KRO and emits a tagless `repo:` when version is unset (the default never applies). Use a single full-ref field with one default: `const image = spec.image ?? DEFAULT_IMAGE` where `DEFAULT_IMAGE = 'repo:1.2.3'`. That compiles to `has(spec.image) ? spec.image : "repo:1.2.3"`. If you also want a `version` label, keep it cosmetic (`app.kubernetes.io/version` + `status.version`) and document that the running tag comes from `image`.

53. **Workload readiness: compare to the resource's own `spec.replicas`, not a JS const or `status.replicas`** — `readyReplicas >= (spec.replicaCount ?? 1)` evaluates `??` eagerly on the proxy and bakes the literal `1` into the KRO CEL, so readiness ignores the actual count. `readyReplicas >= <dep>.status.replicas` is a t=0 FALSE-POSITIVE (`status.replicas` is `0` before the controller observes the spec → `0 >= 0` reports ready before any pod exists). Use `<dep>.status.readyReplicas >= <dep>.spec.replicas` — the desired count is a concrete ≥1 and resolves in BOTH kro CEL and direct-mode hydration (direct mode hydrates `.spec` refs alongside `.status` via `LIVE_SPEC_KEY`). The status const MUST be named to match the resource's `id` (`const caddyDeployment = deployment({ id: 'caddyDeployment' })`) or the analyzer warns "variable not a registered resource" and the ref won't resolve.

54. **No `phase`-style ternary referencing a resource ref in a direct-proxy status** — In a non-Helm direct-comparison status (the multi-resource pattern above), a `ready ? 'Ready' : 'Installing'` field that references a resource proxy currently serializes to malformed CEL (`<dep>.schema.spec.X` — a stray `schema.`). Let a boolean (`ready`) carry the signal and omit `phase`. Same family as #13/#48 (no nested CEL ternaries), but it bites the direct-proxy path too, not just `Cel.expr`.

55. **Override the container entrypoint with the full `command`, not just `args`** — Official images typically put the binary in ENTRYPOINT and flags in CMD. Overriding only `args` drops the entrypoint → `exec: <flag>: not found` at startup. Set the full `command: ['binary', 'run', '--config', '/etc/x/conf', ...]`.

56. **Encode storage/topology constraints — don't expose a knob that produces a broken config** — If a workload keeps state on a `ReadWriteOnce` PVC (e.g. Caddy's `tls internal` CA in `/data`), it is single-replica by nature: multiple pods can't co-mount RWO, and each may generate divergent state (a different CA → clients see mismatched certs). Do NOT expose a `replicaCount`; pin `replicas: 1` and set `strategy: { type: 'Recreate' }` — the default `RollingUpdate` surges a second pod that can't mount the RWO volume held by the outgoing one and wedges the rollout. Reject unsupported keys LOUDLY with arktype `'+': 'reject'` on the config schema so a stray `replicaCount` fails with a clear message instead of being silently dropped. Document the HA path (RWX storage or externalized state) as out of scope.

57. **A passing unit/YAML test can mask a wrong direct-mode status — a live deploy is the only proof** — Direct-mode status hydration and KRO CEL resolve refs by different paths, so a status expression can serialize to correct-looking YAML (unit test green) yet hydrate to the WRONG value in a direct deploy. Real example: `<dep>.spec.replicas` passed the YAML `toContain` assertion but reported `status.ready === false` on a live `direct` deploy until core direct-mode spec hydration landed. For any shape-(b) integration, deploy to a real cluster with `waitForReady: true` and assert `status.ready === true`. (Reinforces #38/#49 for the non-Helm case.)

58. **arktype validation failures are `ArkErrors` — test with `instanceof type.errors`** — `import { type } from 'arktype'` and assert `result instanceof type.errors`. `instanceof Error` is always `false` for arktype results, so a reject test written that way passes vacuously and proves nothing. This is the only assertion that actually exercises a schema rejection (e.g. the `'+': 'reject'` rule above, or a missing required field).

59. **Run the FULL `bun run typecheck` before committing, not just `typecheck:lib`** — Test-only type errors are invisible to `typecheck:lib`. The one that bit: passing a second timeout arg to a one-arg `afterAll` cleanup helper → `TS2554`. bun's default hook timeout is 5s; for teardown that may run long, use a NON-waiting cleanup (initiate the delete and return) rather than reaching for a timeout arg the helper doesn't accept. (The Step-8 checkpoint runs `typecheck:lib` for speed mid-build — but the final gate is the full `bun run typecheck`.)

60. **Workload status is a multi-resource direct-proxy status — see the non-bootstrap pattern, never `Cel.expr`** — Shape-(b) compositions have no HelmRelease conditions to read, so build `ready` from direct proxy comparisons on the resources you created (Deployment readiness, Service, PVC), exactly as in the "Multi-resource compositions (non-bootstrap)" example above. `Cel.expr` is only for condition-array status on Helm/operator integrations; reaching for it here is a smell (rule #32).
