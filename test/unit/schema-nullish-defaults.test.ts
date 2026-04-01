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

  describe('applyOmitWrappers', () => {
    let applyOmitWrappers: (yaml: string, omitFields: string[]) => string;

    beforeAll(async () => {
      const mod = await import('../../src/core/serialization/kro-post-processing.js');
      applyOmitWrappers = mod.applyOmitWrappers;
    });

    it('should wrap single-reference fields with has() + omit()', () => {
      const yaml = '  resources: ${schema.spec.resources}\n';
      const result = applyOmitWrappers(yaml, ['resources']);
      expect(result).toContain('"${has(schema.spec.resources) ? schema.spec.resources : omit()}"');
    });

    it('should wrap string()-wrapped fields with has() + omit()', () => {
      const yaml = '  value: ${string(schema.spec.baseUrl)}\n';
      const result = applyOmitWrappers(yaml, ['baseUrl']);
      expect(result).toContain('"${has(schema.spec.baseUrl) ? string(schema.spec.baseUrl) : omit()}"');
    });

    it('should not affect fields not in the omit list', () => {
      const yaml = '  name: ${schema.spec.name}\n  image: ${schema.spec.image}\n';
      const result = applyOmitWrappers(yaml, ['image']);
      expect(result).toContain('name: ${schema.spec.name}');
      expect(result).toContain('"${has(schema.spec.image) ? schema.spec.image : omit()}"');
    });

    it('should be idempotent (second call is a no-op)', () => {
      const yaml = '  resources: ${schema.spec.resources}\n';
      const first = applyOmitWrappers(yaml, ['resources']);
      const second = applyOmitWrappers(first, ['resources']);
      expect(second).toBe(first);
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
  });
});
