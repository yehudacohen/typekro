# CEL Expressions API

Explicit CEL expressions for advanced patterns that can't be expressed with JavaScript.

## When to Use

**Recommended**: Use natural JavaScript expressions (auto-converted to CEL):

```typescript
return {
  ready: deployment.status.readyReplicas > 0,
  url: `https://${service.status.clusterIP}`,
  phase: deployment.status.readyReplicas > 0 ? 'running' : 'pending'
};
```

**Use explicit CEL for**:
- Complex list operations (filter, map, size)
- Advanced CEL functions not available in JavaScript

## JavaScript vs Explicit CEL

| Pattern | JavaScript (Recommended) | Explicit CEL |
|---------|--------------------------|--------------|
| Boolean | `deploy.status.readyReplicas > 0` | `Cel.expr(deploy.status.readyReplicas, ' > 0')` |
| String | `` `https://${svc.status.clusterIP}` `` | `Cel.template('https://%s', svc.status.clusterIP)` |
| Conditional | `ready ? 'yes' : 'no'` | `Cel.conditional(ready, 'yes', 'no')` |
| List ops | ❌ Not supported | `Cel.expr('size(pods.filter(p, p.ready))')` |

## Core Functions

### `Cel.expr()`

Creates a CEL expression from parts.

```typescript
function expr<T>(...parts: RefOrValue<unknown>[]): CelExpression<T>
```

**Examples:**

```typescript
import { Cel } from 'typekro';

// Simple expression
const count = Cel.expr('size(deployments)');

// With resource references
const isReady = Cel.expr(deploy.status.readyReplicas, ' >= ', deploy.spec.replicas);

// Complex expression
const healthyPods = Cel.expr('size(pods.filter(p, p.status.phase == "Running"))');
```

### `Cel.template()`

Creates a string with interpolated values using `%s` placeholders.

```typescript
function template(template: string, ...values: RefOrValue[]): CelExpression<string>
```

**Examples:**

```typescript
// Basic template
const url = Cel.template('https://%s/api', service.status.clusterIP);

// Multiple placeholders
const endpoint = Cel.template(
  'https://%s:%s/api',
  service.status.clusterIP,
  service.spec.ports[0].port
);
```

### `Cel.conditional()`

Creates a ternary expression.

```typescript
function conditional<T>(
  condition: RefOrValue<boolean>,
  trueValue: RefOrValue<T>,
  falseValue: RefOrValue<T>
): CelExpression<T>
```

**Examples:**

```typescript
const phase = Cel.conditional(
  Cel.expr(deploy.status.readyReplicas, ' > 0'),
  'running',
  'pending'
);

const logLevel = Cel.conditional(
  Cel.expr(config.data.environment, ' == "production"'),
  'warn',
  'debug'
);
```

### `Cel.concat()`

Concatenates strings using the CEL `+` operator.

```typescript
function concat(...parts: RefOrValue[]): CelExpression<string>
```

**Examples:**

```typescript
const fullName = Cel.concat(deploy.metadata.name, '-service');
const url = Cel.concat('http://', service.status.clusterIP, ':8080');
```

### `Cel.math()`

Creates mathematical CEL expressions.

```typescript
function math<T>(operation: string, ...operands: RefOrValue[]): CelExpression<T>
```

**Examples:**

```typescript
const total = Cel.math('sum', deploy.status.readyReplicas, deploy.status.unavailableReplicas);
```

## Utility Functions

### `Cel.min()` / `Cel.max()`

```typescript
const minReplicas = Cel.min(deploy.spec.replicas, 10);
const maxReplicas = Cel.max(deploy.status.readyReplicas, 1);
```

### `Cel.size()`

```typescript
const containerCount = Cel.size(deploy.spec.template.spec.containers);
```

## Optional Nested Lists

An optional nested list — `service.status.loadBalancer.ingress`,
`helmRelease.status.history`, `gateway.status.addresses` — does not exist until
a controller fills it in, and the two CEL engines TypeKro targets disagree about
how to guard it. Use these helpers instead of writing the guard by hand; they
emit the one form both engines accept.

### `Cel.firstWhereHas()`

First entry of a list that carries a given field.

```typescript
function firstWhereHas<
  TElement extends object,
  TField extends Extract<keyof TElement, string>,
>(
  list: CelListSelector<TElement>,
  field: TField,
  ...fallback: CelFallbackArgs<NonNullable<TElement[TField]>>
): CelExpression<NonNullable<TElement[TField]>> & NonNullable<TElement[TField]>
```

`list` is a list-typed field **selected off a resource or schema proxy**, not a
path written as a string. Selecting it gives the helper the element type, so
`field` is checked against the element's own keys and the projection is typed
from the field it projects:

```typescript
// The first ingress entry that reports a hostname, or '' while none does.
hostname: Cel.firstWhereHas(service.status.loadBalancer.ingress, 'hostname')

// A typo is a compile error, not a status field that is permanently ''.
hostname: Cel.firstWhereHas(service.status.loadBalancer.ingress, 'hostnmae')
//                                                                ^ not a key of the entry type
```

Emits:

```
has(a.status) && has(a.status.list)
  ? (size(<matching>) > 0 ? <matching>[0].<field> : <fallback>)
  : <fallback>
```

where `<matching>` is `<list>.filter(entry, has(entry.<field>))`.

#### The fallback has the projected type

`fallback` is typed as the field being projected, not as "any scalar". Two
reasons, and the second is the one that bites:

- The projection is **typed** as the field it projects, so a fallback of another
  type makes that type a lie.
- The fallback is emitted as the `else` branch of a CEL ternary, and **cel-go
  rejects a ternary whose branches have different types** when KRO admits the
  ResourceGraphDefinition. cel-js evaluates it happily, so the mismatch survives
  every direct-mode test and surfaces only on a cluster.

```typescript
// A string field may be left to the '' default, or given an explicit string.
host: Cel.firstWhereHas(gateway.status.endpoints, 'host')
host: Cel.firstWhereHas(gateway.status.endpoints, 'host', 'pending')

// A fallback of the wrong type is a compile error.
host: Cel.firstWhereHas(gateway.status.endpoints, 'host', 8080)
//                                                        ^ not assignable to RefOrValue<string>
```

The `''` default is only available where the projected type admits a string.
For any other field type the fallback is **required**, so a numeric field
without one is a compile error rather than a silent `''` that KRO will reject:

```typescript
// Error: Expected 3 arguments, but got 2 — a number field has no '' default.
port: Cel.firstWhereHas(gateway.status.endpoints, 'port')

port: Cel.firstWhereHas(gateway.status.endpoints, 'port', 8080)  // OK
```

A `KubernetesRef` or CEL expression of the matching type is accepted in place of
a literal, so projections compose — this is how a composition prefers one
endpoint over another:

```typescript
endpoint: Cel.firstOf(
  objectStore.status.endpoints.secure,
  Cel.firstOf(objectStore.status.endpoints.insecure)
)
```

### `Cel.loadBalancerAddress()`

`Cel.firstWhereHas` bound to a Service's load balancer address, whose entries
carry `ip` **or** `hostname` depending on the provider. Takes the Service
itself, selected from the graph:

```typescript
loadBalancer: {
  ip: Cel.loadBalancerAddress(gatewayService, 'ip'),
  hostname: Cel.loadBalancerAddress(gatewayService, 'hostname'),
}
```

### `Cel.firstOf()`

The same guard for a list of scalars, where there is no field to filter on. The
fallback follows the same rule: it has the element type, and is optional only
where that type admits a string.

```typescript
endpoint: Cel.firstOf(objectStore.status.endpoints.secure)
replicas: Cel.firstOf(cluster.status.replicaCounts, 0)  // number list: fallback required
```

### `Cel.unsafeListPath()`

Names a list by its CEL path, for the case where no proxy is in scope — a
bootstrap composition projecting status off a resource that a Helm chart
creates, say, where only the graph resource id is available.

```typescript
function unsafeListPath<TElement = unknown>(path: string): UnsafeCelListPath<TElement>
```

```typescript
version: Cel.firstWhereHas(
  Cel.unsafeListPath<{ chartVersion: string }>('release.status.history'),
  'chartVersion'
)
```

**Unsafe** in one specific sense: nothing checks the path. Not that the named
resource is in the graph, not that the path reaches a list, and not that the
entries are what `TElement` says. Get any of that wrong and the mistake surfaces
on a cluster rather than at compile time. The element type is still declared and
still checked, so `field` keeps its `keyof` check — but prefer selecting the
field off a proxy wherever one exists.

### Why not write the guard by hand

| Form | Rejected by | Why |
|------|-------------|-----|
| `has(list[0].field)` | cel-js | "has() does not support atomic expressions" |
| `"field" in list[0]` | cel-go (KRO) | KRO's type env types a list entry as a message, not a map |
| `size(list) > 0 && has(list)` | cel-js | cel-go absorbs the error either way; cel-js evaluates left to right and fails before reaching the guard |

`Cel.firstWhereHas` avoids all three: it guards every hop of the path with
`has()` **before** any access, selects entries with `filter`, and keeps the
index inside a lazy ternary, which both engines evaluate lazily.

Note that `size(list) > 0 && list[0].field != ""` is **not** on that list.
Indexing a required list inside a logical chain is valid on both engines: with
an empty list cel-js short-circuits on the `false` and never indexes while
cel-go absorbs the index error under the deciding `false`, so both yield
`false`. The helpers are for lists that may be *absent*, not for lists that may
be empty.

## Dual-Dialect Validation

TypeKro runs every emitted status CEL expression through **cel-js** (direct
mode's evaluator) and through a curated denylist of confirmed cel-go
divergences before it emits a ResourceGraphDefinition. A form only one engine
accepts is reported with the status leaf, the expression, and the dialect that
rejects it — at serialization time, rather than when KRO marks the RGD
`Inactive` on a live cluster.

The check is lenient by default (a structured warning). Enable strict mode to
fail serialization instead:

```typescript
const factory = graph.factory('kro', { strictCelDiagnostics: true });
factory.toYaml(); // throws on a dialect-divergent status expression
```

```bash
TYPEKRO_STRICT_CEL=1   # same, as a global default
```

### What fails, and what is only reported

A rule may fail strict mode only when the two engines genuinely **diverge**:
there is data for which one returns a value and the other does not, established
without appeal to a CEL type the serializer cannot see. Two rules clear that
bar, and they are the only two that can fail a build:

| Rule | Dialect | The divergence it encodes |
|------|---------|---------------------------|
| `has-index-argument` | cel-js | cel-js throws "has() does not support atomic expressions" whenever the operand of `has()` is an index — `has(list[0].f)` and `has(map["k"].f)` alike — while cel-go's `has()` accepts any select expression |
| `guard-after-use-in-logical-chain` | cel-js | cel-go absorbs an error in one `&&` / `\|\|` operand when the other decides the result, in either order; cel-js evaluates left to right and propagates it before the guard is reached |

Everything else is reported as a **note**, which is logged in both strictness
settings and never fails serialization:

| Rule | Dialect | Why it cannot fail |
|------|---------|--------------------|
| `in-on-list-entry` | cel-go | A real rejection *if* cel-go's type env types the entry as a message rather than a map — but that is a fact about the resource's schema, which the serializer does not have |
| `not-valid-cel` | both | The emitted text is not CEL at all, usually JavaScript that leaked through the expression converter (`?.`, `?[`, a `[…]` list literal). A defect, but the same defect on both engines |
| `expression-too-large` | unchecked | Past the analysis budget, so no verdict was reached |

Syntax does not establish a CEL type: the same text is a list index against one
schema and a map lookup against another. So no rule decides list-vs-map from
bracket shape, and a rule that would need a type to be a divergence is a note
instead — strict mode never rejects valid CEL. Collection-macro bodies and
nested ternaries are lazy in both engines and are excluded from the chain rules.

Both halves of the check cost about a microsecond per character, so the check
has an analysis budget: **16 KiB per expression**, several times the largest
expression TypeKro emits in practice. An expression past the budget is not
analyzed at all and is reported as `expression-too-large` instead, because a
status field that size is a runaway expansion rather than authored status —
usually a nested composition whose inlined status re-expands into itself. Such
an expression cannot work on either engine anyway: cel-js spends seconds parsing
it on every direct-mode reconcile, and a ResourceGraphDefinition carrying it is
past the Kubernetes object size limit. Give the inner composition an explicit
status field and reference that instead.

### `Cel.string()` / `Cel.int()` / `Cel.double()`

Type conversion functions:

```typescript
const portStr = Cel.string(service.spec.ports[0].port);
const replicaInt = Cel.int(config.data.replicas);
```

## Template Literal Tag

The `cel` template tag provides natural syntax:

```typescript
import { cel } from 'typekro';

const url = cel`https://${spec.hostname}/api`;
// Produces: "https://" + spec.hostname + "/api"
```

## Context-Aware API

For advanced serialization scenarios:

```typescript
const celWithContext = Cel.withContext({ celPrefix: 'resources' });

const expr = celWithContext.expr(deploy.status.readyReplicas, ' > 0');
```

## Type Safety

Always specify the expected return type:

```typescript
// Explicit type parameter
const isReady = Cel.expr<boolean>(deploy.status.readyReplicas, ' > 0');
const url = Cel.template<string>('https://%s', service.status.clusterIP);
```

## Common Patterns

### List Operations

```typescript
// Count items in a list
const containerCount = Cel.expr('size(deployment.spec.template.spec.containers)');

// Filter conditions
const readyCondition = Cel.expr('deployment.status.conditions.filter(c, c.type == "Available")[0].status');

// Check if any condition is true
const hasAvailable = Cel.expr('deployment.status.conditions.exists(c, c.type == "Available" && c.status == "True")');
```

### Null Safety

```typescript
// Check existence before access
const endpoint = Cel.expr(
  'has(service.status.loadBalancer.ingress) ? service.status.loadBalancer.ingress[0].ip : "pending"'
);
```

For an optional nested list, prefer the helper over a hand-written guard — it
also handles an absent intermediate object (`status.loadBalancer` itself
missing) and an entry that carries the other field:

```typescript
const endpoint = Cel.loadBalancerAddress(service, 'ip', 'pending');
```

### Complex Conditions

```typescript
const status = Cel.expr(
  'deployment.status.readyReplicas == deployment.spec.replicas ? "healthy" : ',
  'deployment.status.readyReplicas > 0 ? "degraded" : "unhealthy"'
);
```

## Next Steps

- [JavaScript to CEL](/guide/javascript-to-cel) - Supported JavaScript patterns
- [kubernetesComposition](./kubernetes-composition.md) - Using CEL in compositions
- [Types](./types.md) - CelExpression type definition
