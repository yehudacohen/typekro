/**
 * Structural spec-dependence diagnostics (issue #190).
 *
 * A ResourceGraphDefinition is fixed at build time, so a runtime
 * `schema.spec.*` value may decide what a field CONTAINS but never which
 * resources, list entries or object keys EXIST. These tests pin both halves of
 * that contract:
 *
 *   - every shape the check DETECTS, with the resource and spec path it names;
 *   - every shape it stays SILENT on, which is the harder half — a default-on
 *     serialization gate is only usable if legitimate value-position uses and
 *     the control flow TypeKro already compiles (`includeWhen`, `forEach`)
 *     never trip it.
 *
 * The tests drive the real `toYaml()` path rather than calling the detectors
 * directly: what matters is the interaction between the schema proxy, the
 * control-flow analyzer and serialization, and a unit test of the detector in
 * isolation would not see it.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { StructuralSpecDependenceError } from '../../src/core/validation/structural-spec-dependence.js';
// Direct factory imports: the composition analyzer's `isFactoryCall` only
// recognises Identifier callees (`ConfigMap(...)`), not `simple.ConfigMap(...)`.
import { ConfigMap } from '../../src/factories/simple/index.js';
// camelCase factories, which is what most of this repo ships. The detector must
// not need the uppercase spelling to see that a branch builds something.
import * as rbac from '../../src/factories/kubernetes/rbac/index.js';
import { serviceAccount } from '../../src/factories/kubernetes/rbac/service-account.js';
import { helmRelease } from '../../src/factories/helm/helm-release.js';
import { Cel } from '../../src/core/references/cel.js';

const baseDefinition = {
  apiVersion: 'test.typekro.io/v1alpha1',
  status: type({ ready: 'boolean' }),
};

/** Serialize and return the thrown structural error, failing if none was thrown. */
function expectStructuralError(graph: { toYaml: () => string }): StructuralSpecDependenceError {
  try {
    graph.toYaml();
  } catch (error) {
    expect(error).toBeInstanceOf(StructuralSpecDependenceError);
    return error as StructuralSpecDependenceError;
  }
  throw new Error('expected KRO serialization to reject the structural spec dependence');
}

describe('structural spec dependence — detected', () => {
  it('rejects resource inclusion behind a spec predicate the analyzer cannot compile', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'aliased-flag', kind: 'AliasedFlag', spec: type({ name: 'string', 'enabled?': 'boolean' }) },
      (spec) => {
        // The alias hides `spec` from the analyzer's lexical check, so no
        // includeWhen is attached and `extra` ships in EVERY instance.
        const enabled = spec.enabled;
        ConfigMap({ name: `${spec.name}-base`, data: { a: 'b' }, id: 'base' });
        if (enabled) {
          ConfigMap({ name: `${spec.name}-extra`, data: { a: 'b' }, id: 'extra' });
        }
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);
    expect(error.findings).toHaveLength(1);
    expect(error.findings[0]?.kind).toBe('uncompiled-predicate');
    expect(error.findings[0]?.specPaths).toEqual(['spec.enabled']);
    expect(error.message).toContain('spec.enabled');
    expect(error.message).toContain('`enabled`');
  });

  it('names the spec field when the predicate comes from destructuring', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'destructured-flag', kind: 'DestructuredFlag', spec: type({ name: 'string', 'enabled?': 'boolean' }) },
      (spec) => {
        const { enabled } = spec;
        ConfigMap({ name: `${spec.name}-base`, data: { a: 'b' }, id: 'base' });
        if (enabled) {
          ConfigMap({ name: `${spec.name}-extra`, data: { a: 'b' }, id: 'extra' });
        }
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);
    expect(error.findings[0]?.kind).toBe('uncompiled-predicate');
    expect(error.findings[0]?.specPaths).toEqual(['spec.enabled']);
  });

  it('rejects a switch on a spec discriminant', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'storage-switch', kind: 'StorageSwitch', spec: type({ name: 'string', mode: '"s3" | "local"' }) },
      (spec) => {
        // No case matches a proxy, so `default` is baked in for every instance
        // and the s3 branch becomes an empty stub resource.
        switch (spec.mode) {
          case 's3':
            ConfigMap({ name: `${spec.name}-s3`, data: { a: 'b' }, id: 's3cm' });
            break;
          default:
            ConfigMap({ name: `${spec.name}-local`, data: { a: 'b' }, id: 'localcm' });
        }
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);
    expect(error.findings.some((finding) => finding.kind === 'switch-discriminator')).toBe(true);
    expect(error.message).toContain('spec.mode');
  });

  it('rejects a spec collection whose length was collapsed into object keys', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'mapped-entries', kind: 'MappedEntries', spec: type({ name: 'string', items: 'string[]' }) },
      (spec) => {
        ConfigMap({
          name: spec.name,
          data: Object.fromEntries(spec.items.map((item) => [item, 'x'])),
          id: 'cm',
        });
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);
    const finding = error.findings.find((entry) => entry.kind === 'spec-derived-key');
    expect(finding).toBeDefined();
    expect(finding?.specPaths).toEqual(['spec.items']);
    expect(finding?.location).toContain('resource "cm"');
  });

  it('rejects an object key built from a spec value', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'computed-key', kind: 'ComputedKey', spec: type({ name: 'string', key: 'string' }) },
      (spec) => {
        ConfigMap({ name: spec.name, data: { [spec.key]: 'value' }, id: 'cm' });
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);
    expect(error.findings[0]?.kind).toBe('spec-derived-key');
    expect(error.findings[0]?.specPaths).toEqual(['spec.key']);
  });

  it('rejects enumerating a map-typed spec field, and names the enumeration site', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'enumerated-map', kind: 'EnumeratedMap', spec: type({ name: 'string', settings: 'Record<string, string>' }) },
      (spec) => {
        for (const key of Object.keys(spec.settings)) {
          ConfigMap({ name: `${key}-cm`, data: { a: 'b' }, id: 'keyCm' });
        }
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);
    expect(error.findings.every((finding) => finding.kind === 'runtime-map-enumerated')).toBe(true);
    // The sentinel was consumed as a plain string, so it carries no path of its
    // own — the report falls back to naming the enumeration sites in the source.
    expect(error.message).toContain('Object.keys(spec.settings)');
    expect(error.message).toContain('spec.settings');
  });

  it('rejects spreading a map-typed spec field into a template', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'spread-map', kind: 'SpreadMap', spec: type({ name: 'string', settings: 'Record<string, string>' }) },
      (spec) => {
        ConfigMap({ name: spec.name, data: { ...spec.settings }, id: 'cm' });
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);
    expect(error.findings[0]?.kind).toBe('runtime-map-enumerated');
    expect(error.findings[0]?.specPaths).toEqual(['spec.settings']);
  });

  it('rejects a .length read that lands in a resource template', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'length-in-template', kind: 'LengthInTemplate', spec: type({ name: 'string', items: 'string[]' }) },
      (spec) => {
        // The proxy answers `.length` with 1, so the emitted value is the
        // constant "1" no matter how many items the instance supplies.
        ConfigMap({ name: spec.name, data: { count: String(spec.items.length) }, id: 'cm' });
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);
    expect(error.findings[0]?.kind).toBe('collection-length-read');
    expect(error.findings[0]?.specPaths).toEqual(['spec.items']);
  });

  it('offers both legitimate shapes in the message', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'remedy-text', kind: 'RemedyText', spec: type({ name: 'string', key: 'string' }) },
      (spec) => {
        ConfigMap({ name: spec.name, data: { [spec.key]: 'value' }, id: 'cm' });
        return { ready: true };
      }
    );

    const message = expectStructuralError(graph).message;
    expect(message).toContain('BUILD-TIME factory option');
    expect(message).toContain('FIXED');
    expect(message).toContain('allowStructuralSpecDependence');
  });
});

describe('structural spec dependence — silent on value positions', () => {
  it('accepts plain value positions, string templates and status expressions', () => {
    const graph = kubernetesComposition(
      {
        ...baseDefinition,
        name: 'value-positions',
        kind: 'ValuePositions',
        spec: type({ name: 'string', replicas: 'number', image: 'string' }),
        status: type({ ready: 'boolean', url: 'string', phase: 'string' }),
      },
      (spec) => {
        const cm = ConfigMap({
          name: spec.name,
          data: { image: spec.image, replicas: String(spec.replicas) },
          id: 'cm',
        });
        return {
          ready: cm.metadata.name !== '',
          url: `http://${spec.name}:8080`,
          phase: spec.replicas > 0 ? 'running' : 'pending',
        };
      }
    );

    const yaml = graph.toYaml();
    expect(yaml).toContain('${schema.spec.image}');
    expect(yaml).not.toContain('__typekroSchemaKey');
  });

  it('accepts a .length read inside a status expression', () => {
    // The JS→CEL analyzer rewrites `schema.spec.x.length` to `size(...)`,
    // which KRO evaluates per instance — this is a VALUE position.
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'length-in-status', kind: 'LengthInStatus', spec: type({ name: 'string', items: 'string[]' }) },
      (spec) => {
        ConfigMap({ name: spec.name, data: { a: 'b' }, id: 'cm' });
        return { ready: spec.items.length > 0 };
      }
    );

    expect(() => graph.toYaml()).not.toThrow();
  });

  it('stays silent when the conditional compiles to includeWhen', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'compiled-flag', kind: 'CompiledFlag', spec: type({ name: 'string', 'enabled?': 'boolean' }) },
      (spec) => {
        ConfigMap({ name: `${spec.name}-base`, data: { a: 'b' }, id: 'base' });
        if (spec.enabled) {
          ConfigMap({ name: `${spec.name}-extra`, data: { a: 'b' }, id: 'extra' });
        }
        return { ready: true };
      }
    );

    const yaml = graph.toYaml();
    expect(yaml).toContain('includeWhen');
    expect(yaml).toContain('has(schema.spec.enabled)');
  });

  it('stays silent when a comparison conditional compiles to includeWhen', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'compiled-mode', kind: 'CompiledMode', spec: type({ name: 'string', mode: '"s3" | "local"' }) },
      (spec) => {
        ConfigMap({ name: `${spec.name}-base`, data: { a: 'b' }, id: 'base' });
        if (spec.mode === 's3') {
          ConfigMap({ name: `${spec.name}-s3`, data: { a: 'b' }, id: 's3cm' });
        }
        return { ready: true };
      }
    );

    expect(graph.toYaml()).toContain('schema.spec.mode == "s3"');
  });

  it('stays silent when a spec collection compiles to forEach', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'compiled-foreach', kind: 'CompiledForEach', spec: type({ name: 'string', items: 'string[]' }) },
      (spec) => {
        spec.items.map((item) => ConfigMap({ name: `${item}-cm`, data: { a: 'b' }, id: 'itemCm' }));
        return { ready: true };
      }
    );

    const yaml = graph.toYaml();
    expect(yaml).toContain('forEach');
    expect(yaml).toContain('${schema.spec.items}');
  });

  it('stays silent in direct mode, where spec values are concrete', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'direct-mode', kind: 'DirectMode', spec: type({ name: 'string', 'enabled?': 'boolean' }) },
      (spec) => {
        const enabled = spec.enabled;
        ConfigMap({ name: `${spec.name}-base`, data: { a: 'b' }, id: 'base' });
        if (enabled) {
          ConfigMap({ name: `${spec.name}-extra`, data: { a: 'b' }, id: 'extra' });
        }
        return { ready: true };
      }
    );

    // Building the direct factory runs the same composition without the KRO
    // serialization gate — the structure is decided by real values there.
    expect(() => graph.factory('direct', { namespace: 'default' })).not.toThrow();
  });
});

/**
 * Whether a branch builds anything is decided by an allowlist of pure builtins,
 * not by the callee's name. Casing in particular says nothing: `helmRelease`,
 * `serviceAccount`, `persistentVolumeClaim`, `observedResource` and `singleton`
 * all build resources, and every one of them is camelCase.
 *
 * The two halves below are a pair. Widening what counts as structure is only
 * safe if the value-position calls that appear in every composition —
 * `String(spec.x)`, `Cel.*`, builtin array/string chains, `${…}` templates —
 * stay silent, so each of those gets its own negative test.
 */
describe('structural spec dependence — a branch builds structure regardless of casing', () => {
  it('rejects a camelCase factory behind an aliased spec predicate', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'camel-factory', kind: 'CamelFactory', spec: type({ name: 'string', 'enabled?': 'boolean' }) },
      (spec) => {
        const enabled = spec.enabled;
        ConfigMap({ name: `${spec.name}-base`, data: { a: 'b' }, id: 'base' });
        if (enabled) {
          serviceAccount({ metadata: { name: `${spec.name}-sa` }, id: 'sa' });
        }
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);
    expect(error.findings[0]?.kind).toBe('uncompiled-predicate');
    expect(error.findings[0]?.specPaths).toEqual(['spec.enabled']);
  });

  it('rejects a namespaced camelCase factory behind an aliased spec predicate', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'namespaced-camel', kind: 'NamespacedCamel', spec: type({ name: 'string', 'enabled?': 'boolean' }) },
      (spec) => {
        const enabled = spec.enabled;
        ConfigMap({ name: `${spec.name}-base`, data: { a: 'b' }, id: 'base' });
        if (enabled) {
          rbac.serviceAccount({ metadata: { name: `${spec.name}-sa` }, id: 'sa' });
        }
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);
    expect(
      error.findings.some((finding) => finding.kind === 'uncompiled-predicate')
    ).toBe(true);
  });

  it('rejects a switch whose cases build only with camelCase factories', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'camel-switch', kind: 'CamelSwitch', spec: type({ name: 'string', mode: '"a" | "b"' }) },
      (spec) => {
        switch (spec.mode) {
          case 'a':
            serviceAccount({ metadata: { name: `${spec.name}-a` }, id: 'saA' });
            break;
          default:
            serviceAccount({ metadata: { name: `${spec.name}-b` }, id: 'saB' });
        }
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);
    expect(error.findings.some((finding) => finding.kind === 'switch-discriminator')).toBe(true);
    expect(error.message).toContain('spec.mode');
  });

  it('still reports RGD residue from a camelCase factory the source scan cannot see', () => {
    // Nothing in the source names the problem — the key is computed inside a
    // plain object literal — so detector 1 is the only thing that catches it.
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'camel-residue', kind: 'CamelResidue', spec: type({ name: 'string', key: 'string' }) },
      (spec) => {
        serviceAccount({
          metadata: { name: spec.name, annotations: { [spec.key]: 'value' } },
          id: 'sa',
        });
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);
    expect(error.findings[0]?.kind).toBe('spec-derived-key');
    expect(error.findings[0]?.specPaths).toEqual(['spec.key']);
  });
});

describe('structural spec dependence — value-position calls stay silent', () => {
  it('stays silent for a builtin conversion in an aliased spec ternary', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'builtin-ternary', kind: 'BuiltinTernary', spec: type({ name: 'string', replicas: 'number' }) },
      (spec) => {
        const replicas = spec.replicas;
        ConfigMap({
          name: spec.name,
          data: { count: replicas > 2 ? String(replicas) : String(1) },
          id: 'cm',
        });
        return { ready: true };
      }
    );

    expect(() => graph.toYaml()).not.toThrow();
  });

  it('stays silent for Cel expressions in an aliased spec ternary', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'cel-ternary', kind: 'CelTernary', spec: type({ name: 'string', mode: '"a" | "b"' }) },
      (spec) => {
        const mode = spec.mode;
        ConfigMap({
          name: spec.name,
          data: {
            v:
              mode === 'a'
                ? Cel.expr<string>(spec.name, ' + "-a"')
                : Cel.expr<string>(spec.name, ' + "-b"'),
          },
          id: 'cm',
        });
        return { ready: true };
      }
    );

    expect(() => graph.toYaml()).not.toThrow();
  });

  it('stays silent for string templates in an aliased spec ternary', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'template-ternary', kind: 'TemplateTernary', spec: type({ name: 'string', 'enabled?': 'boolean' }) },
      (spec) => {
        const enabled = spec.enabled;
        ConfigMap({
          name: spec.name,
          data: { host: enabled ? `${spec.name}-a` : `${spec.name}-b` },
          id: 'cm',
        });
        return { ready: true };
      }
    );

    expect(() => graph.toYaml()).not.toThrow();
  });

  it('stays silent for a builtin constructor in an aliased spec branch', () => {
    // `new` is not a factory call in this repo — no factory is a class — so a
    // builtin construction in the branch is a value computation, not structure.
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'builtin-ctor', kind: 'BuiltinCtor', spec: type({ name: 'string', 'enabled?': 'boolean' }) },
      (spec) => {
        const enabled = spec.enabled;
        let index = new Map<string, string>();
        if (enabled) {
          index = new Map([['mode', 'on']]);
        }
        ConfigMap({
          name: spec.name,
          data: { mode: index.get('mode') ?? 'off' },
          id: 'cm',
        });
        return { ready: true };
      }
    );

    expect(() => graph.toYaml()).not.toThrow();
  });

  it('stays silent for builtin object/array/string chains in an aliased spec ternary', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'builtin-chain', kind: 'BuiltinChain', spec: type({ name: 'string', 'enabled?': 'boolean' }) },
      (spec) => {
        const enabled = spec.enabled;
        const settings = { a: '1', b: '2' };
        ConfigMap({
          name: spec.name,
          data: {
            rendered: enabled
              ? Object.entries(settings)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(',')
              : JSON.stringify(settings),
            width: String(Math.max(1, Object.keys(settings).length)),
          },
          id: 'cm',
        });
        return { ready: true };
      }
    );

    expect(() => graph.toYaml()).not.toThrow();
  });
});

/**
 * The whole chain in one composition, driven through the real RGD build
 * (`toYaml()` → `buildRgdManifest()` → `assertNoStructuralSpecDependence`).
 *
 * `helmRelease` is the shape the review called out: a camelCase factory that
 * the old uppercase-callee heuristic did not recognise as building anything,
 * so a branch that decided whether the release existed at all was reported as
 * clean. Both detectors have to speak here — the source scan naming the branch
 * and its spec path, the RGD scan naming the RESOURCE the branch built and the
 * spec path baked into it.
 */
describe('structural spec dependence — composition-level RGD assertion', () => {
  it('names the HelmRelease and both spec paths when a camelCase factory sits behind an aliased predicate', () => {
    const graph = kubernetesComposition(
      {
        ...baseDefinition,
        name: 'camel-release',
        kind: 'CamelRelease',
        spec: type({ name: 'string', tuning: 'string', 'enabled?': 'boolean' }),
      },
      (spec) => {
        const enabled = spec.enabled;
        ConfigMap({ name: `${spec.name}-base`, data: { a: 'b' }, id: 'base' });
        if (enabled) {
          helmRelease({
            name: `${spec.name}-chart`,
            id: 'chart',
            chart: { repository: 'https://charts.example.com', name: 'demo', version: '1.2.3' },
            values: { [spec.tuning]: 'on' },
          });
        }
        return { ready: true };
      }
    );

    const error = expectStructuralError(graph);

    // Detector 2 — the source: the branch that decided the release exists.
    const predicate = error.findings.find((finding) => finding.kind === 'uncompiled-predicate');
    expect(predicate).toBeDefined();
    expect(predicate?.specPaths).toEqual(['spec.enabled']);
    expect(predicate?.location).toContain('enabled');

    // Detector 1 — the RGD about to be emitted: the resource, by id, and the
    // spec value that became one of its literal keys.
    const residue = error.findings.find((finding) => finding.kind === 'spec-derived-key');
    expect(residue).toBeDefined();
    expect(residue?.location).toContain('chart');
    expect(residue?.specPaths).toEqual(['spec.tuning']);

    expect(error.graphName).toBe('camel-release');
    expect(error.message).toContain('spec.enabled');
    expect(error.message).toContain('spec.tuning');
    expect(error.message).toContain('chart');
  });
});

describe('structural spec dependence — escape hatch', () => {
  it('emits the RGD unchanged when allowStructuralSpecDependence is set', () => {
    const graph = kubernetesComposition(
      { ...baseDefinition, name: 'migrating', kind: 'Migrating', spec: type({ name: 'string', 'enabled?': 'boolean' }) },
      (spec) => {
        const enabled = spec.enabled;
        ConfigMap({ name: `${spec.name}-base`, data: { a: 'b' }, id: 'base' });
        if (enabled) {
          ConfigMap({ name: `${spec.name}-extra`, data: { a: 'b' }, id: 'extra' });
        }
        return { ready: true };
      },
      { allowStructuralSpecDependence: true }
    );

    const yaml = graph.toYaml();
    // Unchanged means unchanged: the build-time branch is still baked in, which
    // is exactly why the option is a migration aid and not a fix.
    expect(yaml).toContain('id: extra');
    expect(yaml).not.toContain('includeWhen');
  });
});
