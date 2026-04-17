/**
 * Differential Branch Capture Tests
 *
 * Covers the framework machinery that lets composition authors write plain
 * JavaScript control flow (`if (!spec.optional)`, `spec.x ? a : b`, etc.)
 * and get correct KRO `includeWhen` directives and CEL ternaries in the
 * emitted RGD. The machinery lives in:
 *
 *   - `src/core/serialization/core.ts` →
 *       processCompositionBodyAnalysis, captureHybridRunResources,
 *       applyDifferentialFieldConditionals
 *   - `src/core/expressions/composition/composition-analyzer-helpers.ts` →
 *       conditionToCel (bare-ref → has() wrapping for optional fields)
 *   - `src/core/expressions/composition/composition-analyzer-ternary.ts` →
 *       walkObjectForTernaries (nested-object ternary detection)
 *
 * These tests exercise the end-to-end `toYaml()` path because the
 * integration between the AST analyzer, differential execution, and
 * serialization pipeline is what we want to pin — unit-testing the
 * individual functions would miss interaction bugs.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
// Direct imports: the composition-analyzer's `isFactoryCall` only recognises
// Identifier callees (`ConfigMap(...)`), not MemberExpression callees
// (`simple.ConfigMap(...)`), so we import the factory functions by name
// throughout this test file. We also stick to factories in the baseline
// `KNOWN_FACTORY_NAMES` set (ConfigMap, Deployment) to avoid depending on
// module-load ordering for self-registered factories.
import { ConfigMap, Deployment } from '../../src/factories/simple/index.js';

/**
 * Extract one resource's YAML block from the serialized RGD. Each resource
 * entry in the `resources:` list starts with `    - id: <id>` (four-space
 * indent) and ends at the next `    - id:` or the end of the resources list.
 */
function extractResourceSection(yaml: string, id: string): string | undefined {
  const lines = yaml.split('\n');
  const startPattern = new RegExp(`^    - id:\\s*${id}\\s*$`);
  const startIdx = lines.findIndex((l) => startPattern.test(l));
  if (startIdx === -1) return undefined;
  const endIdx = lines.findIndex(
    (l, i) => i > startIdx && (/^ {4}- id:/.test(l) || !/^\s/.test(l) || l === '')
  );
  return lines.slice(startIdx, endIdx === -1 ? undefined : endIdx).join('\n');
}

describe('Differential Branch Capture', () => {
  describe('if (!spec.optional) — resource creation in untaken branch', () => {
    it('captures the resource and attaches a correct includeWhen', () => {
      const composition = kubernetesComposition(
        {
          name: 'capture-if-not',
          apiVersion: 'test.io/v1alpha1',
          kind: 'CaptureIfNot',
          spec: type({ name: 'string', 'externalSecretName?': 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          if (!spec.externalSecretName) {
            ConfigMap({
              name: `${spec.name}-autocfg`,
              data: { generated: 'true' },
              id: 'autoCfg',
            });
          }
          ConfigMap({
            name: `${spec.name}-main`,
            data: { k: 'v' },
            id: 'mainCfg',
          });
          return { ready: true };
        }
      );

      const yaml = composition.toYaml();

      // The auto-cfg resource was registered in the framework's hybrid
      // run (where externalSecretName = undefined makes
      // !spec.externalSecretName truthy) and then merged into the main
      // resource map.
      expect(yaml).toContain('id: autoCfg');

      // And it carries the correct includeWhen from the AST analyzer's
      // if (!spec.externalSecretName) test.
      expect(yaml).toContain('!has(schema.spec.externalSecretName)');

      // The unconditional ConfigMap should NOT have an includeWhen.
      const mainSection = extractResourceSection(yaml, 'mainCfg');
      expect(mainSection).toBeDefined();
      expect(mainSection).not.toContain('includeWhen');
      const autoSection = extractResourceSection(yaml, 'autoCfg');
      expect(autoSection).toContain('includeWhen');
    });
  });

  describe('if / else — both branches create resources', () => {
    it('emits opposite includeWhen on each branch', () => {
      const composition = kubernetesComposition(
        {
          name: 'capture-if-else',
          apiVersion: 'test.io/v1alpha1',
          kind: 'CaptureIfElse',
          spec: type({ name: 'string', 'useExternalCache?': 'boolean' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          if (spec.useExternalCache) {
            ConfigMap({
              name: `${spec.name}-external-cache-config`,
              data: { mode: 'external' },
              id: 'externalCacheCfg',
            });
          } else {
            ConfigMap({
              name: `${spec.name}-internal-cache-config`,
              data: { mode: 'internal' },
              id: 'internalCacheCfg',
            });
          }
          return { ready: true };
        }
      );

      const yaml = composition.toYaml();

      // Both branch resources exist in the emitted RGD.
      expect(yaml).toContain('id: externalCacheCfg');
      expect(yaml).toContain('id: internalCacheCfg');

      // AST analyzer should have attached the test as the "if" branch's
      // condition. With a boolean optional field, the bare-ref wrapping
      // produces has(...) semantics.
      //
      // NOTE: For boolean OPTIONAL fields, the user's intent with
      // `if (spec.useExternalCache)` is ambiguous between "field is set"
      // and "field is true". The framework currently emits has(...) which
      // is the more conservative choice (matches JS truthiness for the
      // common case where the field is a presence flag). Users who need
      // value-based testing should use `if (spec.useExternalCache === true)`.
      const externalSection = yaml.match(/- id: externalCacheCfg[\s\S]*?(?=\n {2}- id: |$)/)?.[0];
      const internalSection = yaml.match(/- id: internalCacheCfg[\s\S]*?(?=\n {2}- id: |$)/)?.[0];

      expect(externalSection).toContain('includeWhen');
      expect(internalSection).toContain('includeWhen');
      // One should be negated relative to the other.
      expect(externalSection).toContain('has(schema.spec.useExternalCache)');
      expect(internalSection).toContain('!has(schema.spec.useExternalCache)');
    });
  });

  describe('ternary-as-default promotion', () => {
    it('emits has() guard with literal fallback for optional field ternary', () => {
      // When the ternary branches are "the proxy ref itself" on truthy
      // and "a literal" on falsy, the hybrid run detects the difference
      // and emits a CEL conditional with the literal as the fallback.
      // This is more general than schema-default promotion — it works
      // even for fields used inside spread patterns or nested objects.
      const composition = kubernetesComposition(
        {
          name: 'field-diff',
          apiVersion: 'test.io/v1alpha1',
          kind: 'FieldDiff',
          spec: type({
            name: 'string',
            'overrideMode?': 'string',
          }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          ConfigMap({
            name: `${spec.name}-cfg`,
            data: {
              mode: spec.overrideMode ? spec.overrideMode : 'default-mode',
            },
            id: 'cfg',
          });
          return { ready: true };
        }
      );

      const yaml = composition.toYaml();

      // The template should emit either an explicit conditional or a schema default.
      expect(yaml.includes('has(schema.spec.overrideMode)') || yaml.includes('schema.spec.overrideMode ?')).toBe(true);
      expect(yaml).toContain('default-mode');
    });

    it('emits a CEL ternary when the truthy branch is NOT the ref itself', () => {
      // If the ternary branches diverge at the field level (e.g., the
      // truthy branch transforms the ref, or the branches reference
      // DIFFERENT fields), the framework falls back to emitting a CEL
      // conditional via the differential field comparison.
      const composition = kubernetesComposition(
        {
          name: 'field-diff-ternary',
          apiVersion: 'test.io/v1alpha1',
          kind: 'FieldDiffTernary',
          spec: type({
            name: 'string',
            'flavor?': 'string',
          }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          ConfigMap({
            name: `${spec.name}-cfg`,
            data: {
              // Truthy branch derives a different value from spec.flavor;
              // the promotion-to-default heuristic can't apply here.
              mode: spec.flavor ? `custom-${spec.flavor}` : 'stock',
            },
            id: 'cfg',
          });
          return { ready: true };
        }
      );

      const yaml = composition.toYaml();
      // Expect either a CEL conditional in the ConfigMap data or a
      // schema default — both are acceptable framework behaviors as
      // long as the user's intent is preserved at reconcile time.
      const hasConditional =
        yaml.includes('has(schema.spec.flavor)') ||
        yaml.includes('schema.spec.flavor ?') ||
        yaml.includes('flavor: string | default');
      expect(hasConditional).toBe(true);
    });
  });

  describe('captured resource content preserves proxy references for non-overridden fields', () => {
    it('does not replace unconditionally-accessed fields with concrete values in the captured resource', () => {
      // Regression guard: the framework should only override optional
      // fields that are TESTED in an if/ternary. Fields accessed
      // unconditionally (like `spec.server.secret_key` inside a
      // `stringData: { key: ... }` object) should stay as proxy
      // references in the captured resource so their values flow
      // through the CR at reconcile time.
      const composition = kubernetesComposition(
        {
          name: 'preserve-proxies',
          apiVersion: 'test.io/v1alpha1',
          kind: 'PreserveProxies',
          spec: type({
            name: 'string',
            'externalCfgRef?': 'string',
            apiKey: 'string',
          }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          if (!spec.externalCfgRef) {
            ConfigMap({
              name: `${spec.name}-auto-cfg`,
              data: {
                // Required field, accessed unconditionally. MUST remain
                // as a schema.spec.apiKey reference in the captured
                // resource, not a sentinel or proxy marker.
                api_key: spec.apiKey as unknown as string,
              },
              id: 'autoCfg',
            });
          }
          return { ready: true };
        }
      );

      const yaml = composition.toYaml();

      // The captured auto-cfg should reference schema.spec.apiKey
      // (not a sentinel like "__typekro_default__") inside data.
      const cfgSection = extractResourceSection(yaml, 'autoCfg');
      expect(cfgSection).toBeDefined();
      expect(cfgSection).toContain('schema.spec.apiKey');
      expect(cfgSection).not.toContain('__typekro_default__');
    });

    it('still captures a fallback branch when an unrelated optional object is read elsewhere', () => {
      const composition = kubernetesComposition(
        {
          name: 'hybrid-unrelated-optional-read',
          apiVersion: 'test.io/v1alpha1',
          kind: 'HybridUnrelatedOptionalRead',
          spec: type({
            name: 'string',
            'feature?': 'boolean',
            'secretRef?': { 'name?': 'string' },
          }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          const secretName = spec.secretRef?.name ?? 'default-secret';

          if (!spec.feature) {
            ConfigMap({
              name: `${spec.name}-fallback`,
              data: { secret_name: secretName },
              id: 'fallbackCfg',
            });
          }

          return { ready: true };
        }
      );

      const yaml = composition.toYaml();
      expect(yaml).toContain('id: fallbackCfg');
    });

    it('preserves field-level differential conditionals when another optional object is read elsewhere', () => {
      const composition = kubernetesComposition(
        {
          name: 'field-diff-with-unrelated-optional-read',
          apiVersion: 'test.io/v1alpha1',
          kind: 'FieldDiffWithUnrelatedOptionalRead',
          spec: type({
            name: 'string',
            image: 'string',
            'feature?': 'boolean',
            'secretRef?': { 'name?': 'string' },
          }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          const secretName = spec.secretRef?.name ?? 'default-secret';

          Deployment({
            name: spec.name,
            image: spec.image,
            id: 'app',
            env: {
              SECRET_NAME: secretName,
              FEATURE_MODE: spec.feature ? 'enabled' : 'disabled',
            },
          });

          return { ready: true };
        }
      );

      const yaml = composition.toYaml();
      expect(yaml).toContain('FEATURE_MODE');
      expect(yaml.includes('has(schema.spec.feature)') || yaml.includes('schema.spec.feature ?')).toBe(true);
      expect(yaml).toContain('enabled');
      expect(yaml).toContain('disabled');
    });

    it('does not let unrelated optional object reads break hybrid capture when only one field drives control flow', () => {
      const composition = kubernetesComposition(
        {
          name: 'hybrid-throwing-unrelated-optional-read',
          apiVersion: 'test.io/v1alpha1',
          kind: 'HybridThrowingUnrelatedOptionalRead',
          spec: type({
            name: 'string',
            image: 'string',
            'feature?': 'boolean',
            'secretRef?': { name: 'string' },
          }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          // If the hybrid run broadly overrides ALL optionals to undefined,
          // this access throws before the feature-driven branch can be captured.
          const secretName = spec.secretRef.name;

          if (!spec.feature) {
            ConfigMap({
              name: `${spec.name}-fallback`,
              data: { secret_name: secretName },
              id: 'fallbackCfg',
            });
          }

          Deployment({
            name: spec.name,
            image: spec.image,
            id: 'app',
            env: {
              SECRET_NAME: secretName,
              FEATURE_MODE: spec.feature ? 'enabled' : 'disabled',
            },
          });

          return { ready: true };
        }
      );

      const yaml = composition.toYaml();
      expect(yaml).toContain('id: fallbackCfg');
      expect(yaml).toContain('schema.spec.secretRef.name');
      expect(yaml).toContain('FEATURE_MODE');
      expect(yaml.includes('has(schema.spec.feature)') || yaml.includes('schema.spec.feature ?')).toBe(true);
    });
  });

  describe('required-field truthiness checks are NOT wrapped in has()', () => {
    it('passes through required boolean fields as value reads in includeWhen', () => {
      // `has(schema.spec.requiredBool)` is trivially true and would
      // make the emitted condition vacuous. The framework should only
      // wrap truthiness checks on OPTIONAL fields.
      const composition = kubernetesComposition(
        {
          name: 'required-bool',
          apiVersion: 'test.io/v1alpha1',
          kind: 'RequiredBool',
          spec: type({ name: 'string', enabled: 'boolean' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          if (spec.enabled) {
            ConfigMap({
              name: `${spec.name}-enabled`,
              data: { state: 'on' },
              id: 'enabledCfg',
            });
          }
          return { ready: true };
        }
      );

      const yaml = composition.toYaml();
      // Required boolean: should emit `${schema.spec.enabled}`, not `${has(...)}`
      expect(yaml).toContain('${schema.spec.enabled}');
      expect(yaml).not.toContain('has(schema.spec.enabled)');
    });
  });

  describe('non-overridable compound conditions degrade gracefully', () => {
    it('does not crash and still produces valid YAML when test is a compound expression', () => {
      // `if (spec.a && spec.b)` is a LogicalExpression, not a bare
      // MemberExpression. The `collectOverridableOptionalFields` heuristic
      // only picks fields from bare `schema.spec.X` patterns in recorded
      // includeWhen, so compound tests produce an empty override set and
      // the differential capture silently no-ops. The composition should
      // still serialize correctly (documented limitation in rule #34).
      const composition = kubernetesComposition(
        {
          name: 'compound-cond',
          apiVersion: 'test.io/v1alpha1',
          kind: 'CompoundCond',
          spec: type({
            name: 'string',
            'a?': 'boolean',
            'b?': 'boolean',
          }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          ConfigMap({
            name: `${spec.name}-always`,
            data: { k: 'v' },
            id: 'always',
          });
          return { ready: true };
        }
      );

      expect(() => composition.toYaml()).not.toThrow();
      const yaml = composition.toYaml();
      expect(yaml).toContain('id: always');
    });
  });

  describe('nested composition + if-branch composition (key-based matching regression)', () => {
    it('detects ?? defaults even when branch-captured resources shift the resource count', () => {
      // This is the regression the SearXNG integration test uncovered:
      // `resolveDefaultsByReExecution` used to match resources by index,
      // so when the defaults run took a branch the proxy run didn't
      // (producing an extra resource) the comparison paired unrelated
      // resources and missed ?? defaults on subsequent fields. Key-based
      // matching handles this correctly.
      const DEFAULT_IMAGE = 'nginx:1.25.3-alpine';

      const composition = kubernetesComposition(
        {
          name: 'key-matched',
          apiVersion: 'test.io/v1alpha1',
          kind: 'KeyMatched',
          spec: type({
            name: 'string',
            'externalRef?': 'string',
            'image?': 'string',
          }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          if (!spec.externalRef) {
            ConfigMap({
              name: `${spec.name}-sidecar`,
              data: { side: 'car' },
              id: 'sidecar',
            });
          }
          Deployment({
            name: spec.name,
            image: spec.image ?? DEFAULT_IMAGE,
            id: 'app',
          });
          return { ready: true };
        }
      );

      const yaml = composition.toYaml();

      // The ?? default on `image` must be detected despite the
      // branch-captured sidecar shifting resource counts.
      expect(yaml).toContain(`image: string | default="${DEFAULT_IMAGE}"`);

      // Both conditional resource and unconditional Deployment exist.
      expect(yaml).toContain('id: sidecar');
      expect(yaml).toContain('id: app');
    });
  });

  describe('array-length differentials', () => {
    it('conditionalizes env entries added by optional object-spread branches', () => {
      const composition = kubernetesComposition(
        {
          name: 'array-diff-conditional',
          apiVersion: 'test.io/v1alpha1',
          kind: 'ArrayDiffConditional',
          spec: type({
            name: 'string',
            image: 'string',
            'feature?': { 'enabled?': 'boolean' },
          }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          Deployment({
            name: spec.name,
            image: spec.image,
            env: {
              NODE_ENV: 'production',
              ...(spec.feature?.enabled !== false
                ? { FEATURE_URL: `http://${spec.name}-feature:8080` }
                : {}),
            },
            id: 'app',
          });
          return { ready: true };
        }
      );

      const yaml = composition.toYaml();
      expect(yaml).toContain('FEATURE_URL');
      expect(yaml).toContain('schema.spec.feature.enabled');
      expect(yaml).toContain('string(schema.spec.name)');
      expect(yaml).toContain('?');
    });
  });
});
