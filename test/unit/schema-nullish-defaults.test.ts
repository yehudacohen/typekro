/**
 * Unit tests for schema.ts nullish defaults extraction and omit field detection.
 *
 * Tests the fn.toString() regex extraction, the re-execution comparison,
 * and the omit field collection for optional fields without defaults.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { extractNullishDefaults } from '../../src/core/serialization/schema.js';

describe('Schema Nullish Defaults', () => {
  describe('extractNullishDefaults (fn.toString regex)', () => {
    it('should extract string literal defaults', () => {
      const source = `(spec) => { const ns = spec.namespace ?? 'default-ns'; }`;
      const defaults = extractNullishDefaults(source);
      expect(defaults.namespace).toBe('default-ns');
    });

    it('should extract double-quoted string defaults', () => {
      const source = `(spec) => { const img = spec.image ?? "nginx:latest"; }`;
      const defaults = extractNullishDefaults(source);
      expect(defaults.image).toBe('nginx:latest');
    });

    it('should extract numeric defaults', () => {
      const source = `(spec) => { const r = spec.replicas ?? 3; }`;
      const defaults = extractNullishDefaults(source);
      expect(defaults.replicas).toBe(3);
    });

    it('should extract boolean true defaults', () => {
      const source = `(spec) => { const e = spec.enabled ?? true; }`;
      const defaults = extractNullishDefaults(source);
      expect(defaults.enabled).toBe(true);
    });

    it('should extract boolean false defaults', () => {
      const source = `(spec) => { const l = spec.limiter ?? false; }`;
      const defaults = extractNullishDefaults(source);
      expect(defaults.limiter).toBe(false);
    });

    it('should extract minified !0 (true) defaults', () => {
      const source = `(spec) => { const e = spec.enabled ?? !0; }`;
      const defaults = extractNullishDefaults(source);
      expect(defaults.enabled).toBe(true);
    });

    it('should extract minified !1 (false) defaults', () => {
      const source = `(spec) => { const l = spec.server?.limiter ?? !1; }`;
      const defaults = extractNullishDefaults(source);
      expect(defaults['server.limiter']).toBe(false);
    });

    it('should handle optional chaining in field paths', () => {
      const source = `(spec) => { const l = spec.server?.limiter ?? false; }`;
      const defaults = extractNullishDefaults(source);
      expect(defaults['server.limiter']).toBe(false);
    });

    it('should extract multiple defaults from the same source', () => {
      const source = `(spec) => {
        const ns = spec.namespace ?? 'default';
        const r = spec.replicas ?? 1;
        const l = spec.server?.limiter ?? false;
      }`;
      const defaults = extractNullishDefaults(source);
      expect(defaults.namespace).toBe('default');
      expect(defaults.replicas).toBe(1);
      expect(defaults['server.limiter']).toBe(false);
    });

    it('should NOT extract non-literal defaults (constants)', () => {
      const source = `(spec) => { const img = spec.image ?? DEFAULT_IMAGE; }`;
      const defaults = extractNullishDefaults(source);
      expect(defaults.image).toBeUndefined();
    });

    it('should NOT extract spec-to-spec defaults', () => {
      const source = `(spec) => { const name = spec.instanceName ?? spec.name; }`;
      const defaults = extractNullishDefaults(source);
      expect(defaults.instanceName).toBeUndefined();
    });

    it('should NOT extract template literal defaults', () => {
      const source = '(spec) => { const url = spec.baseUrl ?? `http://${spec.name}:8080/`; }';
      const defaults = extractNullishDefaults(source);
      expect(defaults.baseUrl).toBeUndefined();
    });

    it('should handle defaults in template literal interpolations', () => {
      const source = `(spec) => { const s = \`limiter: \${spec.server?.limiter ?? false}\`; }`;
      const defaults = extractNullishDefaults(source);
      expect(defaults['server.limiter']).toBe(false);
    });
  });

  describe('omit() wrapping (inline ref-to-CEL conversion)', () => {
    // omit() wrapping is no longer post-processing on serialized YAML —
    // it's applied inline during KubernetesRef → CEL conversion via
    // `SerializationContext.omitFields`. These tests exercise the new
    // `processResourceReferences` code path directly so the behavior is
    // pinned at the unit level (the end-to-end tests below verify the
    // full pipeline through `toYaml()`).

    let processResourceReferences: (
      obj: unknown,
      ctx?: { celPrefix: string; resourceIdStrategy: 'deterministic' | 'random'; omitFields?: ReadonlySet<string> }
    ) => unknown;

    beforeAll(async () => {
      const mod = await import('../../src/core/serialization/cel-references.js');
      processResourceReferences = mod.processResourceReferences;
    });

    const ctx = (fields: string[]) => ({
      celPrefix: 'resources',
      resourceIdStrategy: 'deterministic' as const,
      omitFields: new Set(fields),
    });

    it('wraps bare single-ref markers with has() + omit()', () => {
      const marker = '__KUBERNETES_REF___schema___spec.resources__';
      const result = processResourceReferences(marker, ctx(['resources']));
      expect(result).toBe('${has(schema.spec.resources) ? schema.spec.resources : omit()}');
    });

    it('does NOT wrap mixed-template refs (strings containing a ref + literal text)', () => {
      // Mixed templates produce STRING values, not fields — omit() would
      // be a type error there. The literal-text-carrying path must stay clean.
      const marker = '__KUBERNETES_REF___schema___spec.baseUrl__-suffix';
      const result = processResourceReferences(marker, ctx(['baseUrl']));
      expect(result).toBe('${string(schema.spec.baseUrl)}-suffix');
      expect(String(result)).not.toContain('omit()');
    });

    it('does not wrap fields not in the omit list', () => {
      const nameMarker = '__KUBERNETES_REF___schema___spec.name__';
      const imageMarker = '__KUBERNETES_REF___schema___spec.image__';
      expect(processResourceReferences(nameMarker, ctx(['image']))).toBe(
        '${schema.spec.name}'
      );
      expect(processResourceReferences(imageMarker, ctx(['image']))).toBe(
        '${has(schema.spec.image) ? schema.spec.image : omit()}'
      );
    });

    it('does not wrap sub-path refs (only top-level optional fields are omittable)', () => {
      // omit() removes the CONTAINING field, so wrapping schema.spec.env.FOO
      // would try to omit a sub-key of env rather than env itself — that's
      // the wrong semantics. Only top-level matches are wrapped.
      const marker = '__KUBERNETES_REF___schema___spec.env.FOO__';
      const result = processResourceReferences(marker, ctx(['env']));
      expect(result).toBe('${schema.spec.env.FOO}');
      expect(String(result)).not.toContain('omit()');
    });

    it('wraps CelExpression objects that are a single schema.spec.<field>', async () => {
      // The Cel.expr() path also needs omit wrapping when the expression
      // is a single schema ref (e.g., from a status builder that passes
      // a schema proxy directly).
      const { Cel } = await import('../../src/core/references/cel.js');
      const expr = Cel.expr('schema.spec.resources');
      const result = processResourceReferences(expr, ctx(['resources']));
      expect(result).toBe('${has(schema.spec.resources) ? schema.spec.resources : omit()}');
    });

    it('wraps CelExpression objects that are string(schema.spec.<field>)', async () => {
      const { Cel } = await import('../../src/core/references/cel.js');
      const expr = Cel.expr('string(schema.spec.baseUrl)');
      const result = processResourceReferences(expr, ctx(['baseUrl']));
      expect(result).toBe(
        '${has(schema.spec.baseUrl) ? string(schema.spec.baseUrl) : omit()}'
      );
    });

    it('YAML serializer naturally single-quotes the wrapper (no post-processing needed)', async () => {
      // Regression check: the `?` and `:` characters inside the has()/omit()
      // expression are YAML-special, but js-yaml dump automatically picks a
      // quoting style that escapes them. If this ever changes, the inline
      // approach breaks and we'd need to re-introduce post-hoc quoting.
      const yaml = await import('js-yaml');
      const out = yaml.dump({
        resources: '${has(schema.spec.resources) ? schema.spec.resources : omit()}',
      });
      // Either single- or double-quoted is acceptable; the key requirement
      // is that the `?` and `:` are protected from YAML interpretation.
      expect(
        out.includes("'${has(schema.spec.resources) ? schema.spec.resources : omit()}'") ||
          out.includes('"${has(schema.spec.resources) ? schema.spec.resources : omit()}"')
      ).toBe(true);
    });
  });

  describe('applyTernaryConditionalsToResources', () => {
    let applyTernaryConditionalsToResources: (
      resources: Record<string, unknown>,
      conditionals: Array<{ proxySection: string; falsyValue: string; conditionField: string }>
    ) => void;

    beforeAll(async () => {
      const mod = await import('../../src/core/serialization/kro-post-processing.js');
      applyTernaryConditionalsToResources = mod.applyTernaryConditionalsToResources;
    });

    it('should replace ternary section with CEL conditional in resource data', () => {
      const resources = {
        config: {
          data: {
            'settings.yml': 'base: true\nredis:\n  url: __KUBERNETES_REF___schema___spec.redisUrl__',
          },
        },
      };

      applyTernaryConditionalsToResources(resources, [
        {
          proxySection: '\nredis:\n  url: __KUBERNETES_REF___schema___spec.redisUrl__',
          falsyValue: '',
          conditionField: 'redisUrl',
        },
      ]);

      const result = (resources.config.data as Record<string, string>)['settings.yml'];
      expect(result).toContain('has(schema.spec.redisUrl)');
      expect(result).toContain('string(schema.spec.redisUrl)');
      expect(result).not.toContain('__KUBERNETES_REF__');
    });

    it('should not affect strings without the ternary section', () => {
      const resources = {
        deploy: { metadata: { name: 'test' } },
      };

      applyTernaryConditionalsToResources(resources, [
        { proxySection: '\nredis:\n  url: MARKER', falsyValue: '', conditionField: 'redisUrl' },
      ]);

      expect((resources.deploy.metadata as Record<string, string>).name).toBe('test');
    });
  });

  describe('End-to-end pipeline (regression tests)', () => {
    // These tests exercise the full pipeline:
    //   composition → re-execution → ternary detection → YAML output
    // Previous bugs that regressed through this path:
    //   B1: required fields in template literals were wrongly detected as ternaries
    //   B2: JSON.clone in kro-factory stripped proxy-valued fields
    //   B3: mutation asymmetry between core.ts and kro-factory.ts

    it('B1: required fields in template literals should NOT be wrapped in has() ternaries', async () => {
      const { kubernetesComposition } = await import('../../src/core/composition/imperative.js');
      const { simple } = await import('../../src/factories/simple/index.js');
      const { type } = await import('arktype');

      const composition = kubernetesComposition(
        {
          name: 'b1-regression',
          apiVersion: 'test.io/v1alpha1',
          kind: 'B1Test',
          spec: type({ name: 'string', 'namespace?': 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          simple.ConfigMap({
            name: `${spec.name}-config`,
            namespace: spec.namespace ?? 'default',
            data: { key: 'value' },
            id: 'config',
          });
          return { ready: true };
        }
      );

      const yaml = composition.toYaml();

      // `name` is REQUIRED — should be a clean mixed template, never wrapped in has()
      expect(yaml).toContain('name: ${string(schema.spec.name)}-config');
      expect(yaml).not.toContain('has(schema.spec.name)');
    });

    it('B1: optional fields in template literals SHOULD still produce ternary conditionals', async () => {
      const { kubernetesComposition } = await import('../../src/core/composition/imperative.js');
      const { simple } = await import('../../src/factories/simple/index.js');
      const { type } = await import('arktype');

      const composition = kubernetesComposition(
        {
          name: 'b1-optional-regression',
          apiVersion: 'test.io/v1alpha1',
          kind: 'B1OptionalTest',
          spec: type({ name: 'string', 'annotation?': 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          // Optional-field ternary: section should be conditionally included
          const optSection = spec.annotation ? `\nextra: ${spec.annotation}` : '';
          simple.ConfigMap({
            name: spec.name,
            data: { 'settings.yml': `base: true${optSection}` },
            id: 'config',
          });
          return { ready: true };
        }
      );

      const yaml = composition.toYaml();
      // Optional field SHOULD produce a has() ternary
      expect(yaml).toContain('has(schema.spec.annotation)');
    });

    it('B2/B3: kro-factory and toYaml() should produce consistent RGD structure', async () => {
      const { kubernetesComposition } = await import('../../src/core/composition/imperative.js');
      const { simple } = await import('../../src/factories/simple/index.js');
      const { type } = await import('arktype');

      // Composition with a proxy-valued field (namespace) that JSON.clone would strip
      const composition = kubernetesComposition(
        {
          name: 'b2-regression',
          apiVersion: 'test.io/v1alpha1',
          kind: 'B2Test',
          spec: type({ name: 'string', 'namespace?': 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          const resolvedNs = spec.namespace ?? 'default';
          simple.ConfigMap({
            name: `${spec.name}-config`,
            namespace: resolvedNs,
            data: { key: 'value' },
            id: 'config',
          });
          return { ready: true };
        }
      );

      const yaml = composition.toYaml();

      // Both the name (template literal) and namespace (direct proxy ref) must
      // appear in the YAML. JSON.clone used to strip the proxy-valued namespace.
      expect(yaml).toContain('namespace:');
      expect(yaml).toContain('schema.spec.namespace');
      expect(yaml).toContain('${string(schema.spec.name)}-config');
    });

    it('toYaml() is idempotent — calling twice produces identical output', async () => {
      const { kubernetesComposition } = await import('../../src/core/composition/imperative.js');
      const { simple } = await import('../../src/factories/simple/index.js');
      const { type } = await import('arktype');

      const composition = kubernetesComposition(
        {
          name: 'idempotency-test',
          apiVersion: 'test.io/v1alpha1',
          kind: 'IdempTest',
          spec: type({ name: 'string', 'extra?': 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          simple.ConfigMap({
            name: `${spec.name}-config`,
            data: { value: spec.extra ? `has-${spec.extra}` : 'none' },
            id: 'config',
          });
          return { ready: true };
        }
      );

      const first = composition.toYaml();
      const second = composition.toYaml();
      expect(second).toBe(first);
    });
  });

  describe('buildSearxngSettings', () => {
    it('should build valid settings YAML with defaults', async () => {
      const { buildSearxngSettings } = await import(
        '../../src/factories/searxng/utils/settings-builder.js'
      );
      const yaml = buildSearxngSettings({});
      expect(yaml).toContain('use_default_settings: true');
    });

    it('should strip secret_key from output', async () => {
      const { buildSearxngSettings } = await import(
        '../../src/factories/searxng/utils/settings-builder.js'
      );
      const yaml = buildSearxngSettings({
        server: { secret_key: 'my-secret', limiter: false },
      });
      expect(yaml).not.toContain('my-secret');
      expect(yaml).not.toContain('secret_key');
      expect(yaml).toContain('limiter: false');
    });

    it('should include redis section when redisUrl is provided', async () => {
      const { buildSearxngSettings } = await import(
        '../../src/factories/searxng/utils/settings-builder.js'
      );
      const yaml = buildSearxngSettings({ redisUrl: 'redis://valkey:6379/0' });
      expect(yaml).toContain('redis:');
      expect(yaml).toContain('url: redis://valkey:6379/0');
      expect(yaml).toContain('limiter: true');
    });

    it('should respect explicit server.limiter=false when redisUrl is also provided', async () => {
      // Regression: the redisUrl branch auto-enables the limiter, but
      // only when it hasn't been explicitly disabled. A user may want to
      // run Redis-backed search cache without the rate limiter.
      const { buildSearxngSettings } = await import(
        '../../src/factories/searxng/utils/settings-builder.js'
      );
      const yaml = buildSearxngSettings({
        server: { limiter: false },
        redisUrl: 'redis://valkey:6379/0',
      });
      expect(yaml).toContain('limiter: false');
      expect(yaml).not.toContain('limiter: true');
      expect(yaml).toContain('url: redis://valkey:6379/0');
    });
  });

  describe('SearXNG composition (direct-mode array formats + KRO-mode fallback)', () => {
    it('KRO mode: searchFormats fallback produces a literal default list when spec.search is a proxy', async () => {
      // In KRO mode `spec.search?.formats` is a KubernetesRef proxy, not a real
      // array — `Array.isArray()` returns false and the composition falls back
      // to the literal default list so the resulting settings.yml stays valid.
      // We exercise this by calling toYaml() (KRO path) and asserting that
      // the literal list appears in the RGD YAML.
      const { searxngBootstrap } = await import(
        '../../src/factories/searxng/compositions/searxng-bootstrap.js'
      );
      const yaml: string = searxngBootstrap.toYaml();

      // The fallback emits the literal two-line list. It should appear
      // verbatim in the settings.yml payload inside the ConfigMap data.
      expect(yaml).toContain('- html');
      expect(yaml).toContain('- json');
    });

    it('Direct mode: spec.search.formats array is rendered as YAML list items', async () => {
      const { buildSearxngSettings } = await import(
        '../../src/factories/searxng/utils/settings-builder.js'
      );
      // The builder is used by the direct-mode code path to produce a
      // pre-rendered settings.yml string; the composition then skips its
      // internal template and uses the string as-is.
      const yaml = buildSearxngSettings({
        search: { formats: ['html', 'json', 'csv'] },
      });
      expect(yaml).toContain('formats:');
      expect(yaml).toContain('- html');
      expect(yaml).toContain('- json');
      expect(yaml).toContain('- csv');
    });

    it('safe_search schema field accepts only 0, 1, or 2 (numeric literal union)', async () => {
      // Regression: ArkType `'0 | 1 | 2'` should parse as a numeric literal
      // union, not a string literal union. A runtime ArkType validation
      // ensures the schema doesn't drift into string types.
      const { SearxngBootstrapConfigSchema } = await import(
        '../../src/factories/searxng/types.js'
      );
      // Navigate to the safe_search node via the search object. ArkType
      // exposes the JSON AST, which should report the safe_search branch
      // as a numeric union.
      const json = SearxngBootstrapConfigSchema.json as Record<string, unknown>;
      expect(json).toBeDefined();
      // Positive cases — these should type-check and validate.
      const good0 = SearxngBootstrapConfigSchema({ name: 'x', search: { safe_search: 0 } });
      const good1 = SearxngBootstrapConfigSchema({ name: 'x', search: { safe_search: 1 } });
      const good2 = SearxngBootstrapConfigSchema({ name: 'x', search: { safe_search: 2 } });
      // Must not have produced an error-shaped return (ArkType returns
      // `ArkErrors` on validation failure, objects on success).
      expect((good0 as { search?: { safe_search?: number } }).search?.safe_search).toBe(0);
      expect((good1 as { search?: { safe_search?: number } }).search?.safe_search).toBe(1);
      expect((good2 as { search?: { safe_search?: number } }).search?.safe_search).toBe(2);
      // Out-of-range numeric values must be rejected.
      const bad = SearxngBootstrapConfigSchema({ name: 'x', search: { safe_search: 3 } });
      // ArkType returns an ArkErrors instance (iterable + has `.summary`)
      // on failure; a successful result is a plain object without it.
      expect('summary' in (bad as object)).toBe(true);
    });
  });

  describe('resolveDefaultsByReExecution failure handling', () => {
    // The re-execution phase calls the composition function a second time
    // with a synthetic spec (optional fields → undefined, required fields →
    // sentinel). If the composition throws during that re-run, we must
    // degrade gracefully: the regex-phase defaults still apply and the
    // RGD still serializes — the ternary-detection features are simply
    // skipped for that composition.
    it('should not throw when the composition function throws during re-execution', async () => {
      const { kubernetesComposition } = await import('../../src/core/composition/imperative.js');
      const { simple } = await import('../../src/factories/simple/index.js');
      const { type } = await import('arktype');

      let callCount = 0;
      const composition = kubernetesComposition(
        {
          name: 'reexec-failure',
          apiVersion: 'test.io/v1alpha1',
          kind: 'ReexecFailure',
          spec: type({ name: 'string', 'optionalFlag?': 'boolean' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          callCount++;
          // First invocation is the proxy run — succeed.
          // Second invocation is the defaults/re-execution run — throw.
          // (The framework catches this and logs at debug level.)
          if (callCount >= 2) {
            throw new Error('intentional re-execution failure');
          }
          simple.ConfigMap({
            name: `${spec.name}-config`,
            data: { key: 'value' },
            id: 'config',
          });
          return { ready: true };
        }
      );

      // toYaml() must succeed even though re-execution throws. The
      // returned YAML should still contain the resources from the
      // proxy run.
      let yaml = '';
      expect(() => {
        yaml = composition.toYaml();
      }).not.toThrow();
      expect(yaml).toContain('kind: ConfigMap');
      expect(yaml).toContain('${string(schema.spec.name)}-config');
    });
  });
});
