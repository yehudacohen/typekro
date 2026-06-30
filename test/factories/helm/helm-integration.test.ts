import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { mergeValuesExpression } from '../../../src/core/aspects/values-merge.js';
import { toResourceGraph } from '../../../src/core/serialization/index.js';
import { Cel } from '../../../src/core/references/cel.js';
import { configMap } from '../../../src/factories/kubernetes/config/config-map.js';
import { helmRelease, simpleHelmChart } from '../../../src/factories/helm/index.js';

describe('Helm Integration with TypeKro Magic Proxy System', () => {
  const TestSpecSchema = type({
    replicas: 'number',
    image: 'string',
    hostname: 'string',
  });

  const TestStatusSchema = type({
    ready: 'boolean',
  });

  it('should support schema references in Helm values', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-test',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (schema) => ({
        nginx: helmRelease({
          name: 'nginx',
          chart: {
            repository: 'https://charts.bitnami.com/bitnami',
            name: 'nginx',
            version: '13.2.23',
          },
          values: {
            replicaCount: schema.spec.replicas,
            image: {
              repository: schema.spec.image,
            },
            ingress: {
              hostname: schema.spec.hostname,
            },
          },
        }),
      }),
      () => ({ ready: true })
    );

    expect(graph).toBeDefined();
    expect(graph.resources[0]).toBeDefined();
    const res0 = graph.resources[0] as unknown as Record<string, Record<string, unknown>>;
    expect(res0.spec!.values).toBeDefined();
    expect((res0.spec!.values as Record<string, unknown>).replicaCount).toBeDefined();
  });

  it('serializes schema references recursively inside Helm values in graph YAML', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-values-magic-proxy',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (schema) => ({
        app: helmRelease({
          name: 'my-app',
          chart: {
            repository: 'https://charts.example.com',
            name: 'my-chart',
          },
          values: {
            replicaCount: schema.spec.replicas,
            config: {
              image: schema.spec.image,
              host: schema.spec.hostname,
              url: `https://${schema.spec.hostname}`,
            },
            env: [
              { name: 'APP_HOST', value: schema.spec.hostname },
              { name: 'APP_URL', value: `https://${schema.spec.hostname}` },
            ],
          },
        }),
      }),
      () => ({ ready: true })
    );

    const yaml = graph.toYaml();

    expect(yaml).toContain('replicaCount: ${schema.spec.replicas}');
    expect(yaml).toContain('image: ${schema.spec.image}');
    expect(yaml).toContain('host: ${schema.spec.hostname}');
    expect(yaml).toContain('url: https://${string(schema.spec.hostname)}');
    expect(yaml).toContain('name: APP_HOST');
    expect(yaml).toContain('value: ${schema.spec.hostname}');
    expect(yaml).toContain('name: APP_URL');
    expect(yaml).toContain('value: https://${string(schema.spec.hostname)}');
    expect(yaml).not.toContain('__KUBERNETES_REF_');
    expect(yaml).not.toContain('[object Object]');
  });

  it('serializes cross-resource references recursively inside Helm values in graph YAML', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-values-resource-refs',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (schema) => {
        const settings = configMap({
          id: 'settings',
          metadata: { name: schema.spec.hostname },
          data: { LOG_LEVEL: 'debug' },
        });

        return {
          settings,
          app: helmRelease({
            name: 'my-app',
            chart: {
              repository: 'https://charts.example.com',
              name: 'my-chart',
            },
            values: {
              config: {
                configMapName: settings.metadata.name,
              },
              envFrom: [{ configMapRef: { name: settings.metadata.name } }],
            },
          }),
        };
      },
      () => ({ ready: true })
    );

    const yaml = graph.toYaml();

    expect(yaml).toContain('configMapName: ${schema.spec.hostname}');
    expect(yaml).toContain('name: ${schema.spec.hostname}');
    expect(yaml).not.toContain('__KUBERNETES_REF_');
    expect(yaml).not.toContain('[object Object]');
  });

  it('rejects unsupported runtime-only leaves inside Helm values with a path-specific error', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-values-runtime-leaf',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      () => ({
        app: helmRelease({
          name: 'my-app',
          chart: {
            repository: 'https://charts.example.com',
            name: 'my-chart',
          },
          values: {
            config: {
              unsupported: () => 'direct-only',
            },
          },
        }),
      }),
      () => ({ ready: true })
    );

    let message = '';
    try {
      graph.toYaml();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('spec.values.config.unsupported');
    expect(message).toMatch(/function|direct/i);
  });

  it('serializes CEL expression leaves recursively inside Helm values in graph YAML', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-values-cel-leaves',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (schema) => ({
        app: helmRelease({
          name: 'my-app',
          chart: {
            repository: 'https://charts.example.com',
            name: 'my-chart',
          },
          values: {
            config: {
              replicaText: Cel.string(schema.spec.replicas),
              publicUrl: Cel.template('https://%s', schema.spec.hostname),
            },
            env: [
              {
                name: 'REPLICA_TEXT',
                value: Cel.string(schema.spec.replicas),
              },
            ],
          },
        }),
      }),
      () => ({ ready: true })
    );

    const yaml = graph.toYaml();

    expect(yaml).toContain('replicaText: ${string(schema.spec.replicas)}');
    expect(yaml).toContain('publicUrl: https://${schema.spec.hostname}');
    expect(yaml).toContain('value: ${string(schema.spec.replicas)}');
    expect(yaml).not.toContain('CelExpression');
    expect(yaml).not.toContain('[object Object]');
  });

  it('serializes whole-object Helm values overlays with Kro map merge', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-values-map-merge',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: type({ values: 'object?' }),
        status: TestStatusSchema,
      },
      (schema) => ({
        app: helmRelease({
          name: 'my-app',
          chart: {
            repository: 'https://charts.example.com',
            name: 'my-chart',
          },
          values: mergeValuesExpression(
            {
              deployment: {
                extraEnv: [
                  { name: 'DSN', valueFrom: { secretKeyRef: { name: 'db', key: 'uri' } } },
                ],
              },
              config: { host: 'default.example.com' },
            },
            schema.spec.values
          ),
        }),
      }),
      () => ({ ready: true })
    );

    const yaml = graph.toYaml();

    expect(yaml).toContain('values: "${(has(schema.spec.values)');
    expect(yaml).toContain('json.unmarshal(json.marshal(schema.spec.values)) : {}).merge');
    expect(yaml).toContain('.merge({\\"deployment\\"');
    expect(yaml).toContain('\\"config\\"');
    expect(yaml).not.toContain('values:\n            deployment:');
    expect(yaml).toContain('schema.spec.values');
    expect(yaml).toContain('has(schema.spec.values)');
    expect(yaml).toContain('extraEnv');
    expect(yaml).toContain('secretKeyRef');
    expect(yaml).toContain('\\"host\\" in (');
    expect(yaml).toContain('\\"config\\" in (has(schema.spec.values)');
    expect(yaml).toMatch(
      /\\"config\\" in \(has\(schema\.spec\.values\)[\s\S]*\\"host\\" in \(\(has\(schema\.spec\.values\)/
    );
    expect(yaml).not.toContain('Kro CEL does not support merging whole-object values refs');
    expect(yaml).not.toContain('__KUBERNETES_REF_');
  });

  // Regression: KRO rejected a runtime values-merge whose overlay carried an
  // OPTIONAL SCALAR spec field. The old form emitted the field's omit() fallback
  // as a VALUE inside the `.merge({...})` map literal:
  //   .merge({ "nameOverride": has(spec.nameOverride) ? spec.nameOverride : omit() })
  // KRO types omit() as map(string, dyn); for a scalar field the ternary is
  // `bool ? <string> : map(string, dyn)` — both branches must share a type, so
  // cel-go fails to compile with:
  //   GraphAccepted=False reason=InvalidResourceGraph
  //   ERROR: found no matching overload for '_?_:_' applied to '(bool, string, map(string, dyn))'
  // The fix emits the field as a conditional single-key merge (both branches
  // maps): `.merge(has(spec.X) ? {"X": spec.X} : {})` — type-safe for ANY field
  // type, and a no-op when the field is absent (true omit semantics).
  //
  // NOTE: this asserts the STRUCTURE of the emitted CEL — the repo has no cel-go
  // (KRO's evaluator) available, so the actual KRO type-check is not unit-verifiable
  // here. The structural assertion below pins the type-safe form precisely.
  it('emits type-safe runtime values-merge for OPTIONAL SCALAR overlay fields (no scalar-vs-omit() ternary)', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-optional-scalar-merge',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: type({
          'nameOverride?': 'string',
          'generateCeleryConfigSecret?': 'boolean',
          replicas: 'number',
          'values?': 'object',
        }),
        status: TestStatusSchema,
      },
      (schema) => ({
        app: helmRelease({
          name: 'dagster',
          chart: {
            repository: 'https://charts.example.com',
            name: 'dagster',
          },
          // Whole-object ref base → forces the RUNTIME map-merge path; overlay
          // carries optional SCALAR refs (nameOverride, generateCeleryConfigSecret)
          // plus a required ref (replicaCount).
          values: mergeValuesExpression(schema.spec.values, {
            nameOverride: schema.spec.nameOverride,
            generateCeleryConfigSecret: schema.spec.generateCeleryConfigSecret,
            replicaCount: schema.spec.replicas,
          }),
        }),
      }),
      () => ({ ready: true })
    );

    const yaml = graph.toYaml();
    const valuesLine = yaml.split('\n').find((line) => line.includes('values: "${')) ?? '';

    // It must take the runtime map-merge path.
    expect(valuesLine).toContain('json.unmarshal(json.marshal(schema.spec.values))');

    // CORE ASSERTION: no scalar-vs-omit() ternary anywhere — i.e. no
    // `? <scalar-ref> : omit()` sitting as a value inside a `.merge({...})`.
    // omit() must not appear at all in this runtime-merge expression.
    expect(valuesLine).not.toContain('omit()');
    expect(valuesLine).not.toMatch(/\? schema\.spec\.\w+ : omit\(\)/);

    // The optional scalars must use the type-safe conditional single-key merge:
    // both branches are maps. (Inner double-quotes are YAML-escaped as \".)
    expect(valuesLine).toContain(
      '.merge(has(schema.spec.nameOverride) ? {\\"nameOverride\\": schema.spec.nameOverride} : {})'
    );
    expect(valuesLine).toContain(
      '.merge(has(schema.spec.generateCeleryConfigSecret) ? {\\"generateCeleryConfigSecret\\": schema.spec.generateCeleryConfigSecret} : {})'
    );

    // The required field stays in the inline merge map (no guard needed).
    expect(valuesLine).toContain('\\"replicaCount\\": schema.spec.replicas');

    expect(valuesLine).not.toContain('__KUBERNETES_REF_');
  });

  it('allows helper-built plain value trees that contain TypeKro references', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-values-helper-built-tree',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (schema) => {
        const makeValues = () => ({
          config: {
            publicUrl: `https://${schema.spec.hostname}`,
            replicas: schema.spec.replicas,
          },
        });

        return {
          app: helmRelease({
            name: 'my-app',
            chart: {
              repository: 'https://charts.example.com',
              name: 'my-chart',
            },
            values: makeValues(),
          }),
        };
      },
      () => ({ ready: true })
    );

    const yaml = graph.toYaml();

    expect(yaml).toContain('publicUrl: https://${string(schema.spec.hostname)}');
    expect(yaml).toContain('replicas: ${schema.spec.replicas}');
  });

  it('omits undefined leaves recursively inside Helm values instead of emitting null-like config', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-values-undefined-leaves',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (schema) => ({
        app: helmRelease({
          name: 'my-app',
          chart: {
            repository: 'https://charts.example.com',
            name: 'my-chart',
          },
          values: {
            config: {
              host: schema.spec.hostname,
              omitted: undefined,
            },
            env: [
              { name: 'APP_HOST', value: schema.spec.hostname },
              undefined,
            ],
          },
        }),
      }),
      () => ({ ready: true })
    );

    const yaml = graph.toYaml();

    expect(yaml).toContain('host: ${schema.spec.hostname}');
    expect(yaml).not.toContain('omitted:');
    expect(yaml).not.toContain('null');
    expect(yaml).not.toContain('value: undefined');
  });

  it('rejects non-plain object leaves inside Helm values with a path-specific error', () => {
    class RuntimeClient {
      readonly endpoint = 'https://runtime.example.com';
    }

    const graph = toResourceGraph(
      {
        name: 'helm-values-non-plain-object',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      () => ({
        app: helmRelease({
          name: 'my-app',
          chart: {
            repository: 'https://charts.example.com',
            name: 'my-chart',
          },
          values: {
            config: {
              client: new RuntimeClient(),
            },
          },
        }),
      }),
      () => ({ ready: true })
    );

    let message = '';
    try {
      graph.toYaml();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('spec.values.config.client');
    expect(message).toMatch(/plain object|RuntimeClient|class/i);
  });

  it('rejects symbol leaves inside Helm values with a path-specific error', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-values-symbol-leaf',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      () => ({
        app: helmRelease({
          name: 'my-app',
          chart: {
            repository: 'https://charts.example.com',
            name: 'my-chart',
          },
          values: {
            config: {
              token: Symbol('runtime-token'),
            },
          },
        }),
      }),
      () => ({ ready: true })
    );

    let message = '';
    try {
      graph.toYaml();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('spec.values.config.token');
    expect(message).toMatch(/symbol/i);
  });

  it('should support nested object references in values', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-nested-test',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (schema) => ({
        app: helmRelease({
          name: 'my-app',
          chart: {
            repository: 'https://charts.example.com',
            name: 'my-chart',
          },
          values: {
            config: {
              database: {
                host: schema.spec.hostname,
                replicas: schema.spec.replicas,
              },
            },
            metadata: {
              labels: {
                app: schema.spec.image,
              },
            },
          },
        }),
      }),
      () => ({ ready: true })
    );

    expect(graph).toBeDefined();
    expect(graph.resources[0]).toBeDefined();
    const nestedRes0 = graph.resources[0] as unknown as Record<string, Record<string, unknown>>;
    expect((nestedRes0.spec!.values as Record<string, unknown>).config).toBeDefined();
    expect((nestedRes0.spec!.values as Record<string, unknown>).metadata).toBeDefined();
  });

  it('should work with simpleHelmChart function', () => {
    const graph = toResourceGraph(
      {
        name: 'simple-helm-test',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: TestSpecSchema,
        status: TestStatusSchema,
      },
      (schema) => ({
        redis: simpleHelmChart('redis', 'https://charts.bitnami.com/bitnami', 'redis', {
          auth: {
            enabled: false,
          },
          replica: {
            replicaCount: schema.spec.replicas,
          },
        }),
      }),
      () => ({ ready: true })
    );

    expect(graph).toBeDefined();
    expect(graph.resources[0]).toBeDefined();
    const simpleRes0 = graph.resources[0] as unknown as Record<string, Record<string, unknown>>;
    expect(simpleRes0.spec!.values).toBeDefined();
  });

  // Regression: the conditional single-key merge must emit the overlay's FULL value expression,
  // not the bare schema path used for the has() guard. For an optional ref wrapped in a CEL
  // conversion (e.g. `string(schema.spec.port)` — coercing a number to a string-typed chart value),
  // the guard is `has(schema.spec.port)` but the VALUE must stay `string(schema.spec.port)`. An
  // earlier iteration stored only the inner path and emitted it as the value, silently dropping string().
  it('preserves a string() conversion on an optional ref in the runtime values-merge', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-optional-string-cast-merge',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: type({ 'port?': 'number', 'values?': 'object' }),
        status: TestStatusSchema,
      },
      (schema) => ({
        app: helmRelease({
          name: 'dagster',
          chart: { repository: 'https://charts.example.com', name: 'dagster' },
          values: mergeValuesExpression(schema.spec.values, {
            portString: Cel.expr<string>('string(schema.spec.port)'),
          }),
        }),
      }),
      () => ({ ready: true })
    );

    const yaml = graph.toYaml();
    const valuesLine = yaml.split('\n').find((line) => line.includes('values: "${')) ?? '';

    // Guard on the bare path; the VALUE preserves the string() conversion. (Quotes YAML-escaped as \".)
    expect(valuesLine).toContain(
      '.merge(has(schema.spec.port) ? {\\"portString\\": string(schema.spec.port)} : {})'
    );
    // Must NOT drop string() and emit the bare ref as the value.
    expect(valuesLine).not.toContain('{\\"portString\\": schema.spec.port}');
    expect(valuesLine).not.toContain('omit()');
  });

  // Regression: an optional scalar nested inside an OBJECT overlay must also be type-safe. The
  // top-level fix only pulled out top-level optional refs; a nested object's fallback (base-absent)
  // branch was still emitted via celLiteralForValueTree, re-introducing the invalid inline
  // `{"X": has(spec.X) ? spec.X : omit()}` for its optional scalars at depth.
  it('emits type-safe CEL for an OPTIONAL SCALAR nested inside an object overlay (no omit() at depth)', () => {
    const graph = toResourceGraph(
      {
        name: 'helm-nested-optional-scalar',
        apiVersion: 'example.com/v1alpha1',
        kind: 'TestApp',
        spec: type({ 'secretName?': 'string', 'values?': 'object' }),
        status: TestStatusSchema,
      },
      (schema) => ({
        app: helmRelease({
          name: 'dagster',
          chart: { repository: 'https://charts.example.com', name: 'dagster' },
          // `global.celeryConfigSecretName` is an optional scalar ref NESTED in the `global` object.
          values: mergeValuesExpression(schema.spec.values, {
            global: { celeryConfigSecretName: schema.spec.secretName },
          }),
        }),
      }),
      () => ({ ready: true })
    );

    const yaml = graph.toYaml();
    const valuesLine = yaml.split('\n').find((line) => line.includes('values: "${')) ?? '';

    // No omit() anywhere — at any nesting depth.
    expect(valuesLine).not.toContain('omit()');
    expect(valuesLine).not.toMatch(/\? schema\.spec\.\w+ : omit\(\)/);
    // The nested optional scalar uses the type-safe single-key merge in BOTH the base-present and
    // base-absent branches (the base-absent fallback is `({}).merge(...)`, not an inline omit ternary).
    expect(valuesLine).toContain(
      '.merge(has(schema.spec.secretName) ? {\\"celeryConfigSecretName\\": schema.spec.secretName} : {})'
    );
    expect(valuesLine).toContain('({}).merge(has(schema.spec.secretName)');
  });
});
