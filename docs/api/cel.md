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
function firstWhereHas<T = string>(
  list: RefOrValue<unknown> | string,
  field: string,
  fallback?: RefOrValue<string | number | boolean | null | undefined>
): CelExpression<T> & T
```

```typescript
// The first ingress entry that reports a hostname, or '' while none does.
hostname: Cel.firstWhereHas<string>(service.status.loadBalancer.ingress, 'hostname')

// Naming a graph resource by id, as bootstrap compositions do.
version: Cel.firstWhereHas<string>('release.status.history', 'chartVersion')
```

Emits:

```
has(a.status) && has(a.status.list)
  ? (size(<matching>) > 0 ? <matching>[0].<field> : <fallback>)
  : <fallback>
```

where `<matching>` is `<list>.filter(entry, has(entry.<field>))`.

### `Cel.loadBalancerAddress()`

`Cel.firstWhereHas` bound to a Service's load balancer address, whose entries
carry `ip` **or** `hostname` depending on the provider.

```typescript
loadBalancer: {
  ip: Cel.loadBalancerAddress(gatewayService, 'ip'),
  hostname: Cel.loadBalancerAddress(gatewayService, 'hostname'),
}
```

### `Cel.firstOf()`

The same guard for a list of scalars, where there is no field to filter on.

```typescript
endpoint: Cel.firstOf<string>('objectStore.status.endpoints.secure')
```

### Why not write the guard by hand

| Form | Rejected by | Why |
|------|-------------|-----|
| `has(list[0].field)` | cel-js | "has() does not support atomic expressions" |
| `"field" in list[0]` | cel-go (KRO) | KRO's type env types a list entry as a message, not a map |
| `size(list) > 0 && has(list)` | cel-js | cel-go absorbs the error either way; cel-js evaluates left to right and fails before reaching the guard |
| `size(list) > 0 && list[0].field != ""` | cel-js | same — the second operand errors before the first can decide the result |

`Cel.firstWhereHas` avoids all four: it guards every hop of the path with
`has()` **before** any access, selects entries with `filter`, and keeps the
index inside a lazy ternary, which both engines evaluate lazily.

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

There is no in-process cel-go for a TypeScript serializer to consult, so the
denylist is deliberately curated rather than a full type checker. It currently
covers: an unparseable expression, `has()` on an index expression, `in` on a
typed list entry, a `has()` guard written after the access it guards, and an
unguarded list index inside `&&` / `||`. Collection-macro bodies and nested
ternaries are lazy in both engines and are excluded, as is a map lookup such as
`metadata.annotations["key"]`.

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
