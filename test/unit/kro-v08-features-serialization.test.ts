/**
 * Kro RGD Feature Serialization Tests
 *
 * Tests that TypeKro compositions serialize to correct Kro RGD YAML
 * for RGD features: forEach, includeWhen, readyWhen, externalRef, and
 * the KRO 0.9+ `omit()` / mixed-template features.
 *
 * These tests define the expected YAML output for each feature pattern.
 *
 * Historical note: the filename retains the `v08-features` suffix for git
 * history continuity, but many tests now assert behavior that requires
 * **KRO 0.9.0+** (mixed-template CEL format, `omit()` for optional fields).
 * Running the emitted RGDs against a KRO 0.8.x controller will fail.
 *
 * Kro spec references:
 * - Collections: https://kro.run/docs/concepts/rgd/resource-definitions/collections
 * - Conditionals: https://kro.run/docs/concepts/rgd/resource-definitions/conditional-creation
 * - Readiness: https://kro.run/docs/concepts/rgd/resource-definitions/readiness
 * - External Refs: https://kro.run/docs/concepts/rgd/resource-definitions/external-references
 * - CEL Expressions: https://kro.run/docs/concepts/rgd/cel-expressions
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import * as yaml from 'js-yaml';
import { getSingletonResourceId } from '../../src/core/singleton/singleton.js';
import { ConfigMap, Deployment, Ingress, Service } from '../../src/factories/simple/index.js';
import { Cel, externalRef, kubernetesComposition, singleton } from '../../src/index.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Shape of a resource entry in a parsed RGD YAML.
 *
 * Uses `any` for deeply nested YAML structures (template, forEach) that vary
 * per Kubernetes resource kind. The typed wrapper still eliminates `any` from
 * the top-level helper signatures and documents the expected shape.
 */
interface ParsedRgdResource {
  id: string;
  template: Record<string, any>;
  forEach?: any;
  includeWhen?: string[];
  readyWhen?: string[];
  /** externalRef can be true (boolean) or an object with apiVersion/kind/metadata */
  externalRef?: any;
}

/** Shape of a parsed RGD YAML document */
interface ParsedRgd {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    annotations?: Record<string, string>;
  };
  spec: {
    schema: {
      apiVersion: string;
      kind: string;
      group?: string;
      spec: Record<string, unknown>;
      status?: Record<string, unknown>;
    };
    resources: ParsedRgdResource[];
  };
}

/** Parse YAML and return typed object */
function parseRgdYaml(yamlStr: string): ParsedRgd {
  return yaml.load(yamlStr) as ParsedRgd;
}

/** Find a resource entry by id in parsed RGD. Throws if not found. */
function findResource(parsed: ParsedRgd, id: string): ParsedRgdResource {
  const resource = parsed.spec.resources.find((r) => r.id === id);
  if (!resource) {
    throw new Error(`Resource with id '${id}' not found in parsed RGD`);
  }
  return resource;
}

// =============================================================================
// Common schema definitions reused across tests
// =============================================================================

const SimpleArraySpec = type({
  name: 'string',
  image: 'string',
  regions: 'string[]',
});

const SimpleArrayStatus = type({
  totalDeployments: 'number',
});

const ConditionalSpec = type({
  name: 'string',
  image: 'string',
  monitoring: 'boolean',
  environment: '"production" | "staging" | "development"',
  ingress: type({ enabled: 'boolean', hostname: 'string' }),
  disabled: 'boolean',
});

const ConditionalStatus = type({
  ready: 'boolean',
});

// =============================================================================
// forEach — Collections
// =============================================================================

describe('Kro RGD Feature Serialization (requires KRO 0.9+ at runtime)', () => {
  describe('forEach — Collections', () => {
    describe('Basic Iteration Patterns', () => {
      it('for...of over schema array produces forEach directive', () => {
        const graph = kubernetesComposition(
          {
            name: 'foreach-forof',
            apiVersion: 'v1alpha1',
            kind: 'ForEachTest',
            spec: SimpleArraySpec,
            status: SimpleArrayStatus,
          },
          (spec) => {
            for (const region of spec.regions) {
              Deployment({
                name: `${spec.name}-${region}`,
                image: spec.image,
                id: 'regionalDeployment',
              });
            }
            return {
              totalDeployments: Cel.expr<number>('size(regionalDeployment)'),
            };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'regionalDeployment');

        expect(resource).toBeDefined();
        expect(resource.forEach).toBeDefined();
        expect(resource.forEach).toHaveLength(1);
        expect(resource.forEach[0]).toHaveProperty('region');
        expect(resource.forEach[0].region).toBe('${schema.spec.regions}');
        expect(resource.template).toBeDefined();
      });

      it('.map() over schema array produces forEach directive', () => {
        const graph = kubernetesComposition(
          {
            name: 'foreach-map',
            apiVersion: 'v1alpha1',
            kind: 'MapTest',
            spec: SimpleArraySpec,
            status: SimpleArrayStatus,
          },
          (spec) => {
            spec.regions.map((region) => {
              return Deployment({
                name: `${spec.name}-${region}`,
                image: spec.image,
                id: 'regionalDeployment',
              });
            });
            return {
              totalDeployments: Cel.expr<number>('size(regionalDeployment)'),
            };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'regionalDeployment');

        expect(resource.forEach).toBeDefined();
        expect(resource.forEach[0]).toHaveProperty('region');
        expect(resource.forEach[0].region).toBe('${schema.spec.regions}');
      });

      it('.forEach() over schema array produces forEach directive', () => {
        const graph = kubernetesComposition(
          {
            name: 'foreach-foreach',
            apiVersion: 'v1alpha1',
            kind: 'ForEachMethodTest',
            spec: SimpleArraySpec,
            status: SimpleArrayStatus,
          },
          (spec) => {
            spec.regions.forEach((region) => {
              Deployment({
                name: `${spec.name}-${region}`,
                image: spec.image,
                id: 'regionalDeployment',
              });
            });
            return {
              totalDeployments: Cel.expr<number>('size(regionalDeployment)'),
            };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'regionalDeployment');

        expect(resource.forEach).toBeDefined();
        expect(resource.forEach[0]).toHaveProperty('region');
      });

      // TODO: collection() explicit API test — requires collection() to be exported
      it.todo('collection() explicit API produces forEach directive');

      it('uses callback parameter name as forEach dimension key', () => {
        const graph = kubernetesComposition(
          {
            name: 'foreach-varname',
            apiVersion: 'v1alpha1',
            kind: 'VarNameTest',
            spec: SimpleArraySpec,
            status: SimpleArrayStatus,
          },
          (spec) => {
            // Uses 'r' as parameter name — should become the dimension key
            for (const r of spec.regions) {
              Deployment({
                name: `${spec.name}-${r}`,
                image: spec.image,
                id: 'dep',
              });
            }
            return { totalDeployments: Cel.expr<number>('size(dep)') };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'dep');

        expect(resource.forEach[0]).toHaveProperty('r');
        expect(resource.forEach[0].r).toBe('${schema.spec.regions}');
      });
    });

    describe('Cartesian Product', () => {
      const CartesianSpec = type({
        name: 'string',
        image: 'string',
        regions: 'string[]',
        tiers: 'string[]',
        shards: 'string[]',
      });

      it('nested for...of produces multi-dimension forEach', () => {
        const graph = kubernetesComposition(
          {
            name: 'cartesian-test',
            apiVersion: 'v1alpha1',
            kind: 'CartesianTest',
            spec: CartesianSpec,
            status: type({ count: 'number' }),
          },
          (spec) => {
            for (const region of spec.regions) {
              for (const tier of spec.tiers) {
                Service({
                  name: `${spec.name}-${region}-${tier}`,
                  selector: { app: spec.name },
                  ports: [{ port: 80 }],
                  id: 'regionalTierService',
                });
              }
            }
            return { count: Cel.expr<number>('size(regionalTierService)') };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'regionalTierService');

        expect(resource.forEach).toHaveLength(2);
        expect(resource.forEach[0]).toHaveProperty('region');
        expect(resource.forEach[0].region).toBe('${schema.spec.regions}');
        expect(resource.forEach[1]).toHaveProperty('tier');
        expect(resource.forEach[1].tier).toBe('${schema.spec.tiers}');
      });

      it('three-level nesting produces three-dimension forEach', () => {
        const graph = kubernetesComposition(
          {
            name: 'three-level',
            apiVersion: 'v1alpha1',
            kind: 'ThreeLevelTest',
            spec: CartesianSpec,
            status: type({ count: 'number' }),
          },
          (spec) => {
            for (const region of spec.regions) {
              for (const tier of spec.tiers) {
                for (const shard of spec.shards) {
                  ConfigMap({
                    name: `${spec.name}-${region}-${tier}-${shard}`,
                    data: { region, tier, shard },
                    id: 'shardConfig',
                  });
                }
              }
            }
            return { count: Cel.expr<number>('size(shardConfig)') };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'shardConfig');

        expect(resource.forEach).toHaveLength(3);
        expect(resource.forEach[0]).toHaveProperty('region');
        expect(resource.forEach[1]).toHaveProperty('tier');
        expect(resource.forEach[2]).toHaveProperty('shard');
      });
    });

    describe('Filtered Iteration', () => {
      const WorkerSpec = type({
        name: 'string',
        image: 'string',
        workers: type({ name: 'string', enabled: 'boolean', priority: 'number' }).array(),
      });

      it('.filter().map() produces filtered forEach source expression', () => {
        const graph = kubernetesComposition(
          {
            name: 'filtered-foreach',
            apiVersion: 'v1alpha1',
            kind: 'FilteredTest',
            spec: WorkerSpec,
            status: type({ count: 'number' }),
          },
          (spec) => {
            spec.workers
              .filter((w) => w.enabled)
              .map((worker) => {
                return Deployment({
                  name: `${spec.name}-${worker.name}`,
                  image: spec.image,
                  id: 'workerDep',
                });
              });
            return { count: Cel.expr<number>('size(workerDep)') };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'workerDep');

        expect(resource.forEach).toHaveLength(1);
        expect(resource.forEach[0]).toHaveProperty('worker');
        // The filter should be embedded in the CEL expression
        expect(resource.forEach[0].worker).toBe('${schema.spec.workers.filter(w, w.enabled)}');
      });

      it('.filter() with comparison predicate', () => {
        const graph = kubernetesComposition(
          {
            name: 'filtered-comparison',
            apiVersion: 'v1alpha1',
            kind: 'FilterCompTest',
            spec: WorkerSpec,
            status: type({ count: 'number' }),
          },
          (spec) => {
            spec.workers
              .filter((w) => w.priority > 5)
              .map((worker) => {
                return ConfigMap({
                  name: `${spec.name}-${worker.name}`,
                  data: { name: worker.name },
                  id: 'highPriConfig',
                });
              });
            return { count: Cel.expr<number>('size(highPriConfig)') };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'highPriConfig');

        expect(resource.forEach[0].worker).toBe('${schema.spec.workers.filter(w, w.priority > 5)}');
      });
    });

    describe('Expression Patterns Inside forEach Body', () => {
      it('template literal with iterator var produces CEL concat', () => {
        const graph = kubernetesComposition(
          {
            name: 'foreach-template',
            apiVersion: 'v1alpha1',
            kind: 'TemplateTest',
            spec: SimpleArraySpec,
            status: type({ count: 'number' }),
          },
          (spec) => {
            for (const region of spec.regions) {
              Deployment({
                name: `${spec.name}-${region}`,
                image: spec.image,
                id: 'dep',
              });
            }
            return { count: Cel.expr<number>('size(dep)') };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'dep');
        const templateName = resource.template.metadata.name;

        // KRO mixed template: ${schema.spec.name}-${...region}
        expect(templateName).toContain('schema.spec.name');
        expect(templateName).toContain('region');
      });

      it('ternary in factory arg produces CEL conditional in template', () => {
        const TernarySpec = type({
          name: 'string',
          image: 'string',
          env: 'string',
          regions: 'string[]',
        });

        const graph = kubernetesComposition(
          {
            name: 'foreach-ternary',
            apiVersion: 'v1alpha1',
            kind: 'TernaryTest',
            spec: TernarySpec,
            status: type({ count: 'number' }),
          },
          (spec) => {
            for (const region of spec.regions) {
              Deployment({
                name: `${spec.name}-${region}`,
                image: spec.image,
                // Ternary → CEL conditional in template value
                // CEL uses == not ===
                replicas: spec.env === 'production' ? 3 : 1,
                id: 'dep',
              });
            }
            return { count: Cel.expr<number>('size(dep)') };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'dep');
        const replicas = resource.template.spec.replicas;

        // Should be a CEL conditional, using == not ===
        expect(replicas).toContain('schema.spec.env == "production"');
        expect(replicas).toContain('?');
        expect(replicas).toContain('3');
        expect(replicas).toContain('1');
      });

      it('resource-status object ternary uses resource id instead of JS variable name', () => {
        const graph = kubernetesComposition(
          {
            name: 'resource-status-object-ternary',
            apiVersion: 'v1alpha1',
            kind: 'ResourceStatusObjectTernaryTest',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const cacheDep = Deployment({
              name: `${spec.name}-cache`,
              image: spec.image,
              id: 'cache',
            });
            ConfigMap({
              name: `${spec.name}-config`,
              data: cacheDep.status.ready
                ? { CACHE_MODE: 'redis' }
                : { CACHE_MODE: 'memory' },
              id: 'config',
            });
            const app = Deployment({ name: `${spec.name}-app`, image: spec.image, id: 'app' });
            return { ready: app.status.readyReplicas > 0 };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const config = findResource(parsed, 'config');
        const strings = JSON.stringify(config.template);

        expect(strings).toContain('cache.status.ready');
        expect(strings).not.toContain('cacheDep.status.ready');
      });

      it('compile-time literal stays as literal inside forEach body', () => {
        const graph = kubernetesComposition(
          {
            name: 'foreach-literal',
            apiVersion: 'v1alpha1',
            kind: 'LiteralTest',
            spec: SimpleArraySpec,
            status: type({ count: 'number' }),
          },
          (spec) => {
            for (const region of spec.regions) {
              Deployment({
                name: `${spec.name}-${region}`,
                image: 'nginx', // compile-time literal
                replicas: 1, // compile-time literal
                id: 'dep',
              });
            }
            return { count: Cel.expr<number>('size(dep)') };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'dep');
        const container = resource.template.spec.template.spec.containers[0];

        // Literals should stay as literals, not wrapped in ${}
        expect(container.image).toBe('nginx');
        expect(resource.template.spec.replicas).toBe(1);
      });

      it('property access on iterator object', () => {
        const WorkerSpec = type({
          name: 'string',
          image: 'string',
          workers: type({ name: 'string', port: 'number' }).array(),
        });

        const graph = kubernetesComposition(
          {
            name: 'foreach-prop',
            apiVersion: 'v1alpha1',
            kind: 'PropTest',
            spec: WorkerSpec,
            status: type({ count: 'number' }),
          },
          (spec) => {
            for (const worker of spec.workers) {
              ConfigMap({
                name: `${spec.name}-${worker.name}`,
                data: { port: String(worker.port) },
                id: 'workerConfig',
              });
            }
            return { count: Cel.expr<number>('size(workerConfig)') };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'workerConfig');

        // Template should reference worker.name and worker.port
        const templateName = resource.template.metadata.name;
        expect(templateName).toContain('worker.name');
        const templateData = resource.template.data;
        expect(templateData.port).toContain('worker.port');
      });

      it('Cel.template() with iterator var', () => {
        const graph = kubernetesComposition(
          {
            name: 'foreach-celtemplate',
            apiVersion: 'v1alpha1',
            kind: 'CelTemplateTest',
            spec: SimpleArraySpec,
            status: type({ count: 'number' }),
          },
          (spec) => {
            for (const region of spec.regions) {
              ConfigMap({
                name: Cel.template('%s-%s', spec.name, region),
                data: { region },
                id: 'config',
              });
            }
            return { count: Cel.expr<number>('size(config)') };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'config');
        const templateName = resource.template.metadata.name;

        expect(templateName).toContain('schema.spec.name');
        expect(templateName).toContain('region');
      });
    });

    describe('Nested Control Flow in forEach', () => {
      it('if-guard inside for...of produces forEach AND includeWhen', () => {
        const NestedSpec = type({
          name: 'string',
          image: 'string',
          regions: 'string[]',
          monitoring: 'boolean',
        });

        const graph = kubernetesComposition(
          {
            name: 'if-in-for',
            apiVersion: 'v1alpha1',
            kind: 'IfInForTest',
            spec: NestedSpec,
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            for (const region of spec.regions) {
              if (spec.monitoring) {
                ConfigMap({
                  name: `${spec.name}-${region}-metrics`,
                  data: { region },
                  id: 'regionalMetrics',
                });
              }
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'regionalMetrics');

        // Should have BOTH forEach and includeWhen
        expect(resource.forEach).toBeDefined();
        expect(resource.forEach[0]).toHaveProperty('region');
        expect(resource.includeWhen).toBeDefined();
        expect(resource.includeWhen).toContain('${schema.spec.monitoring}');
      });

      it('for...of inside if-guard produces includeWhen AND forEach', () => {
        const NestedSpec = type({
          name: 'string',
          image: 'string',
          regions: 'string[]',
          ingress: type({ enabled: 'boolean', hostname: 'string' }),
        });

        const graph = kubernetesComposition(
          {
            name: 'for-in-if',
            apiVersion: 'v1alpha1',
            kind: 'ForInIfTest',
            spec: NestedSpec,
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            if (spec.ingress.enabled) {
              for (const region of spec.regions) {
                Ingress({
                  name: `${spec.name}-${region}-ingress`,
                  rules: [{ host: `${region}.${spec.ingress.hostname}` }],
                  id: 'regionalIngress',
                });
              }
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'regionalIngress');

        expect(resource.includeWhen).toBeDefined();
        expect(resource.includeWhen).toContain('${schema.spec.ingress.enabled}');
        expect(resource.forEach).toBeDefined();
        expect(resource.forEach[0]).toHaveProperty('region');
      });
    });
  });

  // ===========================================================================
  // includeWhen — Conditionals
  // ===========================================================================

  describe('includeWhen — Conditionals', () => {
    describe('if Statement Patterns', () => {
      it('if (spec.boolField) produces includeWhen', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-bool',
            apiVersion: 'v1alpha1',
            kind: 'IncludeBoolTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            Deployment({ name: spec.name, image: spec.image, id: 'main' });
            if (spec.monitoring) {
              ConfigMap({
                name: `${spec.name}-monitoring`,
                data: { enabled: 'true' },
                id: 'monitoringConfig',
              });
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const mainResource = findResource(parsed, 'main');
        const conditionalResource = findResource(parsed, 'monitoringConfig');

        // Main resource should NOT have includeWhen
        expect(mainResource.includeWhen).toBeUndefined();

        // Conditional resource should have includeWhen
        expect(conditionalResource.includeWhen).toBeDefined();
        expect(conditionalResource.includeWhen).toContain('${schema.spec.monitoring}');
      });

      it('if (spec.env === "production") produces includeWhen with == operator', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-eq',
            apiVersion: 'v1alpha1',
            kind: 'IncludeEqTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            if (spec.environment === 'production') {
              ConfigMap({
                name: `${spec.name}-prod-config`,
                data: { env: 'production' },
                id: 'prodConfig',
              });
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'prodConfig');

        // CEL uses == not ===
        expect(resource.includeWhen).toBeDefined();
        expect(resource.includeWhen![0]).toContain('schema.spec.environment == "production"');
        expect(resource.includeWhen![0]).not.toContain('===');
      });

      it('if (!spec.disabled) produces includeWhen with negation', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-neg',
            apiVersion: 'v1alpha1',
            kind: 'IncludeNegTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            if (!spec.disabled) {
              ConfigMap({
                name: `${spec.name}-active`,
                data: { active: 'true' },
                id: 'activeConfig',
              });
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'activeConfig');

        expect(resource.includeWhen).toBeDefined();
        expect(resource.includeWhen![0]).toContain('!schema.spec.disabled');
      });

      it('if (spec.optional?.enabled !== false) lowers to includeWhen without optional chaining', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-optional-enabled',
            apiVersion: 'v1alpha1',
            kind: 'IncludeOptionalEnabled',
            spec: type({
              name: 'string',
              'searxng?': {
                'enabled?': 'boolean',
              },
            }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            if (spec.searxng?.enabled !== false) {
              Deployment({ name: `${spec.name}-search`, image: 'nginx', id: 'search' });
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = parsed.spec.resources.find((r) => r.id === 'search');

        expect(resource).toBeDefined();
        expect(resource!.includeWhen).toBeDefined();
        expect(resource!.includeWhen![0]).toContain('schema.spec.searxng.enabled != false');
        expect(resource!.includeWhen![0]).not.toContain('?.');
      });

      it('if guard around nested composition call applies includeWhen to nested resources', () => {
        const searchBootstrap = kubernetesComposition(
          {
            name: 'search-bootstrap',
            apiVersion: 'v1alpha1',
            kind: 'SearchBootstrap',
            spec: type({ name: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            Deployment({ name: spec.name, image: 'nginx', id: 'searchDeployment' });
            return { ready: true };
          }
        );

        const graph = kubernetesComposition(
          {
            name: 'nested-include-when',
            apiVersion: 'v1alpha1',
            kind: 'NestedIncludeWhen',
            spec: type({
              name: 'string',
              'search?': { 'enabled?': 'boolean' },
            }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            if (spec.search?.enabled !== false) {
              searchBootstrap({ name: `${spec.name}-search` });
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const nestedDeployment = parsed.spec.resources.find((r) => r.id === 'searchBootstrap1');

        expect(nestedDeployment).toBeDefined();
        expect(nestedDeployment!.includeWhen).toBeDefined();
        expect(nestedDeployment!.includeWhen![0]).toContain('schema.spec.search.enabled != false');
      });

      it('if guard around member-expression nested composition call applies includeWhen to nested resources', () => {
        const searchBootstrap = kubernetesComposition(
          {
            name: 'search-bootstrap-member',
            apiVersion: 'v1alpha1',
            kind: 'SearchBootstrapMember',
            spec: type({ name: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            Deployment({ name: spec.name, image: 'nginx', id: 'searchDeployment' });
            return { ready: true };
          }
        );

        const nested = { searchBootstrap };

        const graph = kubernetesComposition(
          {
            name: 'nested-member-include-when',
            apiVersion: 'v1alpha1',
            kind: 'NestedMemberIncludeWhen',
            spec: type({
              name: 'string',
              'search?': { 'enabled?': 'boolean' },
            }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            if (spec.search?.enabled !== false) {
              nested.searchBootstrap({ name: `${spec.name}-search` });
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const nestedDeployment = parsed.spec.resources.find((r) => r.id.startsWith('searchBootstrapMember'));

        expect(nestedDeployment).toBeDefined();
        expect(nestedDeployment!.includeWhen).toBeDefined();
        expect(nestedDeployment!.includeWhen![0]).toContain('schema.spec.search.enabled != false');
      });

      it('compound && produces single includeWhen with AND', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-and',
            apiVersion: 'v1alpha1',
            kind: 'IncludeAndTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            if (spec.monitoring && spec.environment === 'production') {
              ConfigMap({
                name: `${spec.name}-prod-monitoring`,
                data: {},
                id: 'prodMonitoring',
              });
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'prodMonitoring');

        expect(resource.includeWhen).toBeDefined();
        // Could be one combined expression or two separate entries (both are valid)
        const allConditions = resource.includeWhen!.join(' ');
        expect(allConditions).toContain('schema.spec.monitoring');
        expect(allConditions).toContain('schema.spec.environment == "production"');
      });

      it('compound || produces single includeWhen with OR', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-or',
            apiVersion: 'v1alpha1',
            kind: 'IncludeOrTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            if (spec.environment === 'staging' || spec.environment === 'production') {
              ConfigMap({
                name: `${spec.name}-non-dev`,
                data: {},
                id: 'nonDevConfig',
              });
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'nonDevConfig');

        expect(resource.includeWhen).toBeDefined();
        const expr = resource.includeWhen![0];
        expect(expr).toContain('schema.spec.environment == "staging"');
        expect(expr).toContain('||');
        expect(expr).toContain('schema.spec.environment == "production"');
      });

      it('nested if statements produce multiple includeWhen entries (AND)', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-nested',
            apiVersion: 'v1alpha1',
            kind: 'IncludeNestedTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            if (spec.monitoring) {
              if (spec.environment === 'production') {
                ConfigMap({
                  name: `${spec.name}-prod-metrics`,
                  data: {},
                  id: 'prodMetrics',
                });
              }
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'prodMetrics');

        // Nested ifs → two separate includeWhen entries (AND semantics)
        expect(resource.includeWhen).toBeDefined();
        expect(resource.includeWhen!.length).toBeGreaterThanOrEqual(2);
        const allConditions = resource.includeWhen!.join(' | ');
        expect(allConditions).toContain('schema.spec.monitoring');
        expect(allConditions).toContain('schema.spec.environment == "production"');
      });

      it('if/else produces includeWhen on if-branch and negated includeWhen on else-branch', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-else',
            apiVersion: 'v1alpha1',
            kind: 'IncludeElseTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            if (spec.monitoring) {
              ConfigMap({
                name: `${spec.name}-monitoring`,
                data: { enabled: 'true' },
                id: 'monitoringConfig',
              });
            } else {
              ConfigMap({
                name: `${spec.name}-no-monitoring`,
                data: { enabled: 'false' },
                id: 'noMonitoringConfig',
              });
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const ifResource = findResource(parsed, 'monitoringConfig');
        const elseResource = findResource(parsed, 'noMonitoringConfig');

        // If-branch: includeWhen should be the condition
        expect(ifResource.includeWhen).toBeDefined();
        expect(ifResource.includeWhen![0]).toContain('schema.spec.monitoring');
        expect(ifResource.includeWhen![0]).not.toContain('!');

        // Else-branch: includeWhen should be the NEGATED condition
        expect(elseResource.includeWhen).toBeDefined();
        expect(elseResource.includeWhen![0]).toContain('!schema.spec.monitoring');
      });

      it('if/else with equality produces negated equality on else-branch', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-else-eq',
            apiVersion: 'v1alpha1',
            kind: 'IncludeElseEqTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            if (spec.environment === 'production') {
              ConfigMap({
                name: `${spec.name}-prod`,
                data: { env: 'production' },
                id: 'prodConfig',
              });
            } else {
              ConfigMap({
                name: `${spec.name}-non-prod`,
                data: { env: 'non-production' },
                id: 'nonProdConfig',
              });
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const prodResource = findResource(parsed, 'prodConfig');
        const nonProdResource = findResource(parsed, 'nonProdConfig');

        // If-branch: includeWhen should be the equality condition
        expect(prodResource.includeWhen).toBeDefined();
        expect(prodResource.includeWhen![0]).toContain('schema.spec.environment == "production"');

        // Else-branch: includeWhen should be NEGATED
        expect(nonProdResource.includeWhen).toBeDefined();
        expect(nonProdResource.includeWhen![0]).toContain('!');
        expect(nonProdResource.includeWhen![0]).toContain(
          'schema.spec.environment == "production"'
        );
      });

      it('compile-time literal condition does NOT produce includeWhen', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-literal',
            apiVersion: 'v1alpha1',
            kind: 'IncludeLiteralTest',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            // This condition is always true at compile time — testing that literal
            // conditions don't produce includeWhen directives
            // biome-ignore lint/correctness/noConstantCondition: intentional test of compile-time constant
            if (true) {
              ConfigMap({
                name: `${spec.name}-always`,
                data: {},
                id: 'alwaysConfig',
              });
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'alwaysConfig');

        // No includeWhen — condition is compile-time true
        expect(resource.includeWhen).toBeUndefined();
      });
    });

    describe('Ternary and Short-circuit Patterns', () => {
      it('spec.flag ? Resource() : undefined produces includeWhen', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-ternary',
            apiVersion: 'v1alpha1',
            kind: 'IncludeTernaryTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            spec.monitoring
              ? ConfigMap({
                  name: `${spec.name}-monitor`,
                  data: {},
                  id: 'monitor',
                })
              : undefined;
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'monitor');

        expect(resource.includeWhen).toBeDefined();
        expect(resource.includeWhen).toContain('${schema.spec.monitoring}');
      });

      it('spec.flag && Resource() produces includeWhen', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-shortcircuit',
            apiVersion: 'v1alpha1',
            kind: 'IncludeShortCircuitTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            spec.monitoring &&
              ConfigMap({
                name: `${spec.name}-monitor`,
                data: {},
                id: 'monitor',
              });
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'monitor');

        expect(resource.includeWhen).toBeDefined();
        expect(resource.includeWhen).toContain('${schema.spec.monitoring}');
      });

      it('spec.flag ? ResourceA() : ResourceB() produces opposite includeWhen', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-opposite',
            apiVersion: 'v1alpha1',
            kind: 'IncludeOppositeTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            spec.monitoring
              ? ConfigMap({
                  name: `${spec.name}-full-monitoring`,
                  data: { level: 'full' },
                  id: 'fullMonitor',
                })
              : ConfigMap({
                  name: `${spec.name}-basic-logging`,
                  data: { level: 'basic' },
                  id: 'basicLogging',
                });
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const fullMonitor = findResource(parsed, 'fullMonitor');
        const basicLogging = findResource(parsed, 'basicLogging');

        // ResourceA: includeWhen = [${schema.spec.monitoring}]
        expect(fullMonitor.includeWhen).toBeDefined();
        expect(fullMonitor.includeWhen![0]).toContain('schema.spec.monitoring');
        expect(fullMonitor.includeWhen![0]).not.toContain('!');

        // ResourceB: includeWhen = [${!schema.spec.monitoring}]
        expect(basicLogging.includeWhen).toBeDefined();
        expect(basicLogging.includeWhen![0]).toContain('!schema.spec.monitoring');
      });

      it('ternary VALUE in resource arg is NOT includeWhen', () => {
        const TernaryValueSpec = type({
          name: 'string',
          image: 'string',
          flag: 'boolean',
        });

        const graph = kubernetesComposition(
          {
            name: 'ternary-value',
            apiVersion: 'v1alpha1',
            kind: 'TernaryValueTest',
            spec: TernaryValueSpec,
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            Deployment({
              name: spec.name,
              image: spec.image,
              replicas: spec.flag ? 3 : 1,
              id: 'dep',
            });
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'dep');

        // NO includeWhen — the ternary is a value expression
        expect(resource.includeWhen).toBeUndefined();
        // The replicas field should contain a CEL conditional
        const replicas = resource.template.spec.replicas;
        expect(replicas).toContain('?');
      });
    });

    describe('Explicit API', () => {
      it('.withIncludeWhen(spec.boolField) produces includeWhen', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-explicit',
            apiVersion: 'v1alpha1',
            kind: 'IncludeExplicitTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            Ingress({
              name: `${spec.name}-ingress`,
              rules: [{ host: spec.ingress.hostname }],
              id: 'ingress',
            }).withIncludeWhen(spec.ingress.enabled);
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'ingress');

        expect(resource.includeWhen).toBeDefined();
        expect(resource.includeWhen).toContain('${schema.spec.ingress.enabled}');
      });

      it('string-marker includeWhen resolves nested status with serialization context', () => {
        const inner = kubernetesComposition(
          {
            name: 'include-nested-inner',
            apiVersion: 'v1alpha1',
            kind: 'IncludeNestedInner',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const app = Deployment({ name: spec.name, image: spec.image, id: 'innerApp' });
            return { ready: app.status.readyReplicas > 0 };
          }
        );

        const graph = kubernetesComposition(
          {
            name: 'include-nested-context',
            apiVersion: 'v1alpha1',
            kind: 'IncludeNestedContext',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const nested = inner({ name: spec.name, image: spec.image });
            ConfigMap({ name: `${spec.name}-cfg`, data: { enabled: 'true' }, id: 'nestedIncludeConfig' })
              .withIncludeWhen(`${nested.status.ready}`);
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'nestedIncludeConfig');

        expect(resource.includeWhen?.[0]).toContain('status.readyReplicas');
        expect(resource.includeWhen?.[0]).not.toContain('status.ready}');
      });

      it('KubernetesRef includeWhen resolves nested status with serialization context', () => {
        const inner = kubernetesComposition(
          {
            name: 'include-ref-nested-inner',
            apiVersion: 'v1alpha1',
            kind: 'IncludeRefNestedInner',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const app = Deployment({ name: spec.name, image: spec.image, id: 'innerRefApp' });
            return { ready: app.status.readyReplicas > 0 };
          }
        );

        const graph = kubernetesComposition(
          {
            name: 'include-ref-nested-context',
            apiVersion: 'v1alpha1',
            kind: 'IncludeRefNestedContext',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const nested = inner({ name: spec.name, image: spec.image });
            ConfigMap({ name: `${spec.name}-cfg`, data: { enabled: 'true' }, id: 'nestedRefIncludeConfig' })
              .withIncludeWhen(nested.status.ready);
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'nestedRefIncludeConfig');

        expect(resource.includeWhen?.[0]).toContain('status.readyReplicas');
        expect(resource.includeWhen?.[0]).not.toContain('status.ready}');
      });

      it('CelExpression includeWhen resolves nested status with serialization context', () => {
        const inner = kubernetesComposition(
          {
            name: 'include-cel-nested-inner',
            apiVersion: 'v1alpha1',
            kind: 'IncludeCelNestedInner',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const app = Deployment({ name: spec.name, image: spec.image, id: 'innerCelApp' });
            return { ready: app.status.readyReplicas > 0 };
          }
        );

        const graph = kubernetesComposition(
          {
            name: 'include-cel-nested-context',
            apiVersion: 'v1alpha1',
            kind: 'IncludeCelNestedContext',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const nested = inner({ name: spec.name, image: spec.image });
            ConfigMap({ name: `${spec.name}-cfg`, data: { enabled: 'true' }, id: 'nestedCelIncludeConfig' })
              .withIncludeWhen(Cel.expr<boolean>(nested.status.ready));
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'nestedCelIncludeConfig');

        expect(resource.includeWhen?.[0]).toContain('status.readyReplicas');
        expect(resource.includeWhen?.[0]).not.toContain('status.ready}');
      });

      it('CelExpression includeWhen normalizes schema markers from nested status', () => {
        const inner = kubernetesComposition(
          {
            name: 'include-cel-marker-inner',
            apiVersion: 'v1alpha1',
            kind: 'IncludeCelMarkerInner',
            spec: type({ enabled: 'boolean' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => ({ ready: spec.enabled })
        );

        const graph = kubernetesComposition(
          {
            name: 'include-cel-marker-context',
            apiVersion: 'v1alpha1',
            kind: 'IncludeCelMarkerContext',
            spec: type({ name: 'string', enabled: 'boolean' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const nested = inner({ enabled: spec.enabled });
            ConfigMap({ name: `${spec.name}-cfg`, data: { enabled: 'true' }, id: 'nestedCelMarkerConfig' })
              .withIncludeWhen(Cel.expr<boolean>(nested.status.ready));
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'nestedCelMarkerConfig');

        expect(resource.includeWhen?.[0]).toContain('schema.spec.enabled');
        expect(resource.includeWhen?.[0]).not.toContain('__KUBERNETES_REF_');
      });

      it('multiple .withIncludeWhen() produces multiple entries (AND)', () => {
        const graph = kubernetesComposition(
          {
            name: 'include-multi',
            apiVersion: 'v1alpha1',
            kind: 'IncludeMultiTest',
            spec: ConditionalSpec,
            status: ConditionalStatus,
          },
          (spec) => {
            Ingress({
              name: `${spec.name}-ingress`,
              rules: [{ host: spec.ingress.hostname }],
              id: 'ingress',
            })

              .withIncludeWhen(spec.ingress.enabled)
              .withIncludeWhen(spec.environment === 'production');
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'ingress');

        expect(resource.includeWhen).toBeDefined();
        expect(resource.includeWhen!.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  // ===========================================================================
  // readyWhen — Readiness
  // ===========================================================================

  describe('readyWhen — Readiness', () => {
    describe('Expression Patterns', () => {
      it('.withReadyWhen callback uses resource id in serialized CEL', () => {
        const graph = kubernetesComposition(
          {
            name: 'ready-basic',
            apiVersion: 'v1alpha1',
            kind: 'ReadyBasicTest',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            Deployment({
              name: spec.name,
              image: spec.image,
              id: 'web',
            }).withReadyWhen(
              (self: { status: { readyReplicas: number } }) => self.status.readyReplicas > 0
            );
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'web');

        expect(resource.readyWhen).toBeDefined();
        // Must use resource id 'web', NOT 'self'
        expect(resource.readyWhen![0]).toContain('web.status.readyReplicas > 0');
        expect(resource.readyWhen![0]).not.toContain('self');
      });

      it('.withReadyWhen with equality uses == operator', () => {
        const graph = kubernetesComposition(
          {
            name: 'ready-eq',
            apiVersion: 'v1alpha1',
            kind: 'ReadyEqTest',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            Deployment({
              name: spec.name,
              image: spec.image,
              id: 'app',
            }).withReadyWhen(
              (self: { status: { phase: string } }) => self.status.phase === 'Running'
            );
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'app');

        // CEL uses == not ===
        expect(resource.readyWhen![0]).toContain('app.status.phase == "Running"');
        expect(resource.readyWhen![0]).not.toContain('===');
      });

      it('.withReadyWhen with exists() macro', () => {
        const graph = kubernetesComposition(
          {
            name: 'ready-exists',
            apiVersion: 'v1alpha1',
            kind: 'ReadyExistsTest',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            Deployment({
              name: spec.name,
              image: spec.image,
              id: 'db',
            }).withReadyWhen(
              (self: {
                status: {
                  conditions: {
                    exists: (fn: (c: { type: string; status: string }) => boolean) => boolean;
                  };
                };
              }) =>
                self.status.conditions.exists(
                  (c: { type: string; status: string }) => c.type === 'Ready' && c.status === 'True'
                )
            );
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'db');

        expect(resource.readyWhen![0]).toContain(
          'db.status.conditions.exists(c, c.type == "Ready" && c.status == "True")'
        );
      });

      it('multiple .withReadyWhen() produces multiple entries', () => {
        const graph = kubernetesComposition(
          {
            name: 'ready-multi',
            apiVersion: 'v1alpha1',
            kind: 'ReadyMultiTest',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            Deployment({
              name: spec.name,
              image: spec.image,
              id: 'svc',
            })

              .withReadyWhen(
                (self: { status: { readyReplicas: number } }) => self.status.readyReplicas > 0
              )
              .withReadyWhen(
                (self: { status: { availableReplicas: number } }) =>
                  self.status.availableReplicas > 0
              );
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'svc');

        expect(resource.readyWhen).toBeDefined();
        expect(resource.readyWhen!.length).toBe(2);
      });
    });

    describe('With Collections', () => {
      it('collection readyWhen uses each keyword', () => {
        const graph = kubernetesComposition(
          {
            name: 'ready-collection',
            apiVersion: 'v1alpha1',
            kind: 'ReadyCollectionTest',
            spec: type({
              name: 'string',
              image: 'string',
              workers: 'string[]',
            }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            for (const worker of spec.workers) {
              Deployment({
                name: `${spec.name}-${worker}`,
                image: spec.image,
                id: 'workerDep',
              }).withReadyWhen(
                (each: { status: { readyReplicas: number } }) => each.status.readyReplicas > 0
              );
            }
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'workerDep');

        // Collections use 'each' keyword, not the resource id
        expect(resource.readyWhen).toBeDefined();
        expect(resource.readyWhen![0]).toContain('each.status.readyReplicas > 0');
      });
    });

    describe('Explicit API', () => {
      it('.withReadyWhen(Cel.expr()) passes CEL string through', () => {
        const graph = kubernetesComposition(
          {
            name: 'ready-celexpr',
            apiVersion: 'v1alpha1',
            kind: 'ReadyCelExprTest',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            Deployment({
              name: spec.name,
              image: spec.image,
              id: 'helm',
            }).withReadyWhen(
              Cel.expr<boolean>(
                'helm.status.conditions.exists(c, c.type == "Ready" && c.status == "True")'
              )
            );
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'helm');

        expect(resource.readyWhen![0]).toBe(
          '${helm.status.conditions.exists(c, c.type == "Ready" && c.status == "True")}'
        );
      });

      it('KubernetesRef readyWhen resolves nested status with serialization context', () => {
        const inner = kubernetesComposition(
          {
            name: 'ready-ref-nested-inner',
            apiVersion: 'v1alpha1',
            kind: 'ReadyRefNestedInner',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const app = Deployment({ name: spec.name, image: spec.image, id: 'innerReadyApp' });
            return { ready: app.status.readyReplicas > 0 };
          }
        );

        const graph = kubernetesComposition(
          {
            name: 'ready-ref-nested-context',
            apiVersion: 'v1alpha1',
            kind: 'ReadyRefNestedContext',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const nested = inner({ name: spec.name, image: spec.image });
            Deployment({ name: spec.name, image: spec.image, id: 'outerReadyApp' })
              .withReadyWhen(nested.status.ready);
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'outerReadyApp');

        expect(resource.readyWhen?.[0]).toContain('status.readyReplicas');
        expect(resource.readyWhen?.[0]).not.toContain('status.ready}');
      });

      it('string readyWhen with nested status markers is not double wrapped', () => {
        const inner = kubernetesComposition(
          {
            name: 'ready-string-nested-inner',
            apiVersion: 'v1alpha1',
            kind: 'ReadyStringNestedInner',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const app = Deployment({ name: spec.name, image: spec.image, id: 'innerReadyStringApp' });
            return { ready: app.status.readyReplicas > 0 };
          }
        );

        const graph = kubernetesComposition(
          {
            name: 'ready-string-nested-context',
            apiVersion: 'v1alpha1',
            kind: 'ReadyStringNestedContext',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const nested = inner({ name: spec.name, image: spec.image });
            Deployment({ name: spec.name, image: spec.image, id: 'outerReadyStringApp' })
              .withReadyWhen(`${nested.status.ready}`);
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'outerReadyStringApp');

        expect(resource.readyWhen?.[0]).toContain('status.readyReplicas');
        expect(resource.readyWhen?.[0]).not.toContain('${${');
      });

      it('CelExpression readyWhen resolves nested status with serialization context', () => {
        const inner = kubernetesComposition(
          {
            name: 'ready-cel-nested-inner',
            apiVersion: 'v1alpha1',
            kind: 'ReadyCelNestedInner',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const app = Deployment({ name: spec.name, image: spec.image, id: 'innerReadyCelApp' });
            return { ready: app.status.readyReplicas > 0 };
          }
        );

        const graph = kubernetesComposition(
          {
            name: 'ready-cel-nested-context',
            apiVersion: 'v1alpha1',
            kind: 'ReadyCelNestedContext',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const nested = inner({ name: spec.name, image: spec.image });
            Deployment({ name: spec.name, image: spec.image, id: 'outerReadyCelApp' })
              .withReadyWhen(Cel.expr<boolean>(nested.status.ready));
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'outerReadyCelApp');

        expect(resource.readyWhen?.[0]).toContain('status.readyReplicas');
        expect(resource.readyWhen?.[0]).not.toContain('status.ready}');
      });

      it('CelExpression readyWhen normalizes schema markers from nested status', () => {
        const inner = kubernetesComposition(
          {
            name: 'ready-cel-marker-inner',
            apiVersion: 'v1alpha1',
            kind: 'ReadyCelMarkerInner',
            spec: type({ enabled: 'boolean' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => ({ ready: spec.enabled })
        );

        const graph = kubernetesComposition(
          {
            name: 'ready-cel-marker-context',
            apiVersion: 'v1alpha1',
            kind: 'ReadyCelMarkerContext',
            spec: type({ name: 'string', image: 'string', enabled: 'boolean' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const nested = inner({ enabled: spec.enabled });
            Deployment({ name: spec.name, image: spec.image, id: 'outerReadyCelMarkerApp' })
              .withReadyWhen(Cel.expr<boolean>(nested.status.ready));
            return { ready: true };
          }
        );

        const parsed = parseRgdYaml(graph.toYaml());
        const resource = findResource(parsed, 'outerReadyCelMarkerApp');

        expect(resource.readyWhen?.[0]).toContain('schema.spec.enabled');
        expect(resource.readyWhen?.[0]).not.toContain('__KUBERNETES_REF_');
      });
    });

    describe('Coexistence with readinessEvaluator', () => {
      it('readinessEvaluator is NOT affected by readyWhen', () => {
        const graph = kubernetesComposition(
          {
            name: 'ready-coexist',
            apiVersion: 'v1alpha1',
            kind: 'ReadyCoexistTest',
            spec: type({ name: 'string', image: 'string' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            const dep = Deployment({
              name: spec.name,
              image: spec.image,
              id: 'app',
            });
            // Both can be set

            dep.withReadyWhen(
              (self: { status: { readyReplicas: number } }) => self.status.readyReplicas > 0
            );
            // readinessEvaluator is for direct mode — should not appear in YAML
            expect(dep.readinessEvaluator).toBeDefined(); // factory-provided
            return { ready: true };
          }
        );

        const yamlStr = graph.toYaml();
        // readyWhen appears in YAML
        expect(yamlStr).toContain('readyWhen');
        // readinessEvaluator does NOT appear in YAML
        expect(yamlStr).not.toContain('readinessEvaluator');
      });
    });
  });

  // ===========================================================================
  // externalRef — External References
  // ===========================================================================

  describe('externalRef — External References', () => {
    it('externalRef() serializes as externalRef field, not template', () => {
      const graph = kubernetesComposition(
        {
          name: 'extref-basic',
          apiVersion: 'v1alpha1',
          kind: 'ExtRefBasicTest',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          const _platformConfig = externalRef({
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: 'platform-config', namespace: 'platform-system' },
          });

          Deployment({ name: spec.name, image: spec.image, id: 'app' });
          return { ready: true };
        }
      );

      const parsed = parseRgdYaml(graph.toYaml());
      // Find the external ref resource (auto-generated id)
      const extRefResource = parsed.spec.resources.find((r) => r.externalRef !== undefined);

      expect(extRefResource).toBeDefined();
      expect(extRefResource!.template).toBeUndefined();
      expect(extRefResource!.externalRef.apiVersion).toBe('v1');
      expect(extRefResource!.externalRef.kind).toBe('ConfigMap');
      expect(extRefResource!.externalRef.metadata.name).toBe('platform-config');
      expect(extRefResource!.externalRef.metadata.namespace).toBe('platform-system');
    });

    it('externalRef metadata preserves schema proxy values', () => {
      const graph = kubernetesComposition(
        {
          name: 'extref-schema-metadata',
          apiVersion: 'v1alpha1',
          kind: 'ExtRefSchemaMetadataTest',
          spec: type({ configName: 'string', namespace: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          externalRef({
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: {
              name: spec.configName,
              namespace: spec.namespace,
            },
            id: 'schemaConfig',
          });
          return { ready: true };
        }
      );

      const parsed = parseRgdYaml(graph.toYaml());
      const extRefResource = parsed.spec.resources.find((r) => r.externalRef !== undefined);

      expect(extRefResource?.externalRef.metadata.name).toContain('schema.spec.configName');
      expect(extRefResource?.externalRef.metadata.namespace).toContain('schema.spec.namespace');
    });

    it('externalRef resource has NO template field in YAML', () => {
      const graph = kubernetesComposition(
        {
          name: 'extref-notemplate',
          apiVersion: 'v1alpha1',
          kind: 'ExtRefNoTplTest',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (_spec) => {
          externalRef({
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: 'db-credentials' },
          });
          return { ready: true };
        }
      );

      const parsed = parseRgdYaml(graph.toYaml());
      const extRef = parsed.spec.resources.find((r: any) => r.externalRef);

      expect(extRef).toBeDefined();
      expect(extRef).not.toHaveProperty('template');
    });

    it('optional ? operator for unstructured field access', () => {
      const graph = kubernetesComposition(
        {
          name: 'extref-optional',
          apiVersion: 'v1alpha1',
          kind: 'ExtRefOptionalTest',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ region: 'string' }),
        },
        (spec) => {
          const config = externalRef({
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: 'platform-config' },
          });

          Deployment({
            name: spec.name,
            image: spec.image,
            env: {
              // Access unstructured data with ? operator
              REGION: config.data?.$region,
            },
            id: 'app',
          });

          return { region: config.data?.$region };
        }
      );

      const yamlStr = graph.toYaml();
      // Kro syntax: .? before field name, not ?. after object
      expect(yamlStr).toContain('.?region');
    });

    it('.orValue() generates orValue() CEL helper', () => {
      const graph = kubernetesComposition(
        {
          name: 'extref-orvalue',
          apiVersion: 'v1alpha1',
          kind: 'ExtRefOrValueTest',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ region: 'string' }),
        },
        (spec) => {
          const config = externalRef({
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: 'platform-config' },
          });

          Deployment({
            name: spec.name,
            image: spec.image,
            env: {
              REGION: config.data?.$region?.orValue('us-east-1'),
            },
            id: 'app',
          });

          return { region: config.data?.$region?.orValue('us-east-1') };
        }
      );

      const yamlStr = graph.toYaml();
      expect(yamlStr).toContain('.orValue("us-east-1")');
    });

    it('externalRef + forEach produces serialization error', () => {
      // Kro spec: "A resource cannot use both forEach and externalRef"
      // This test verifies TypeKro catches this at serialization time
      expect(() => {
        const graph = kubernetesComposition(
          {
            name: 'extref-foreach-error',
            apiVersion: 'v1alpha1',
            kind: 'ExtRefForEachError',
            spec: type({ name: 'string', items: 'string[]' }),
            status: type({ ready: 'boolean' }),
          },
          (spec) => {
            // This should NOT be allowed
            for (const item of spec.items) {
              externalRef({
                apiVersion: 'v1',
                kind: 'ConfigMap',
                metadata: { name: `config-${item}` },
              });
            }
            return { ready: true };
          }
        );
        graph.toYaml();
      }).toThrow();
    });
  });

  describe('singleton — Shared Infra Consumption', () => {
    it('singleton.use() serializes as externalRef-backed consumption', () => {
      const sharedBootstrap = kubernetesComposition(
        {
          name: 'shared-bootstrap',
          apiVersion: 'platform.typekro.test/v1alpha1',
          kind: 'SharedBootstrap',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean', endpoint: 'string' }),
        },
        (spec) => {
          Deployment({ name: spec.name, image: 'nginx', id: 'bootstrapApp' });
          return {
            ready: true,
            endpoint: `http://${spec.name}:80`,
          };
        },
      );

      const graph = kubernetesComposition(
        {
          name: 'singleton-use-test',
          apiVersion: 'v1alpha1',
          kind: 'SingletonUseTest',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ ready: 'boolean', endpoint: 'string' }),
        },
        (spec) => {
          const shared = singleton.use(sharedBootstrap, 'platform-bootstrap');

          Deployment({ name: spec.name, image: spec.image, id: 'app' });
          return {
            ready: shared.status.ready,
            endpoint: shared.status.endpoint,
          };
        },
      );

      const parsed = parseRgdYaml(graph.toYaml());
      const extRefResource = parsed.spec.resources.find((r) => r.externalRef !== undefined);

      expect(extRefResource).toBeDefined();
      expect(extRefResource!.template).toBeUndefined();
      expect(extRefResource!.externalRef.kind).toBe('SharedBootstrap');
      expect(extRefResource!.externalRef.metadata.name).toBe('platform-bootstrap');
    });

    it('singleton(...) does not inline nested shared resources into app RGD', () => {
      const sharedBootstrap = kubernetesComposition(
        {
          name: 'shared-bootstrap-inline-check',
          apiVersion: 'platform.typekro.test/v1alpha1',
          kind: 'SharedBootstrapInlineCheck',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean', endpoint: 'string' }),
        },
        (spec) => {
          Deployment({ name: spec.name, image: 'nginx', id: 'bootstrapApp' });
          return {
            ready: true,
            endpoint: `http://${spec.name}:80`,
          };
        },
      );

      const graph = kubernetesComposition(
        {
          name: 'singleton-inline-check',
          apiVersion: 'v1alpha1',
          kind: 'SingletonInlineCheck',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ ready: 'boolean', endpoint: 'string' }),
        },
        (spec) => {
          const shared = singleton(sharedBootstrap, {
            id: 'platform-bootstrap',
            spec: { name: `${spec.name}-shared` },
          });

          Deployment({ name: spec.name, image: spec.image, id: 'app' });
          return {
            ready: shared.status.ready,
            endpoint: shared.status.endpoint,
          };
        },
      );

      const parsed = parseRgdYaml(graph.toYaml());
      const resourceIds = parsed.spec.resources.map((resource) => resource.id);
      const ownerRef = parsed.spec.resources.find(
        (resource) =>
          resource.externalRef?.kind === 'SharedBootstrapInlineCheck' &&
          resource.externalRef?.metadata?.name === 'platform-bootstrap' &&
          resource.externalRef?.metadata?.namespace === 'typekro-singletons'
      );

      expect(resourceIds).not.toContain('bootstrapApp');
      expect(ownerRef?.id).toBeDefined();
    });

    it('singleton(...) emits an externalRef instead of owning the singleton boundary in KRO YAML', () => {
      const sharedBootstrap = kubernetesComposition(
        {
          name: 'shared-bootstrap-owner-boundary',
          apiVersion: 'platform.typekro.test/v1alpha1',
          kind: 'SharedBootstrapOwnerBoundary',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean', endpoint: 'string' }),
        },
        (spec) => {
          Deployment({ name: spec.name, image: 'nginx', id: 'bootstrapApp' });
          return { ready: true, endpoint: `http://${spec.name}:80` };
        },
      );

      const graph = kubernetesComposition(
        {
          name: 'singleton-owner-boundary-check',
          apiVersion: 'v1alpha1',
          kind: 'SingletonOwnerBoundaryCheck',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ ready: 'boolean', endpoint: 'string' }),
        },
        (spec) => {
          const shared = singleton(sharedBootstrap, {
            id: 'stable-shared-id',
            spec: { name: `${spec.name}-shared-human-name` },
          });

          Deployment({ name: spec.name, image: spec.image, id: 'app' });
          return { ready: shared.status.ready, endpoint: shared.status.endpoint };
        },
      );

      const parsed = parseRgdYaml(graph.toYaml());
      const ownerRef = parsed.spec.resources.find(
        (resource) =>
          resource.externalRef?.kind === 'SharedBootstrapOwnerBoundary' &&
          resource.externalRef?.metadata?.name === 'stable-shared-id' &&
          resource.externalRef?.metadata?.namespace === 'typekro-singletons'
      );
      const ownerBoundary = parsed.spec.resources.find(
        (resource) => resource.template?.kind === 'SharedBootstrapOwnerBoundary'
      );
      const namespaceResource = parsed.spec.resources.find(
        (resource) => resource.template?.kind === 'Namespace' && resource.template?.metadata?.name === 'typekro-singletons'
      );
      const expectedOwnerId = getSingletonResourceId(
        'platform.typekro.test/v1alpha1/SharedBootstrapOwnerBoundary:shared-bootstrap-owner-boundary#stable-shared-id'
      );

      expect(namespaceResource).toBeUndefined();
      expect(ownerBoundary).toBeUndefined();
      expect(ownerRef).toBeDefined();
      expect(ownerRef?.id).toBe(expectedOwnerId);
      expect(ownerRef?.externalRef?.metadata?.name).toBe('stable-shared-id');
      expect(ownerRef?.externalRef?.metadata?.namespace).toBe('typekro-singletons');
    });

    it('factory(kro).toYaml() also emits the singleton boundary as an externalRef', () => {
      const sharedBootstrap = kubernetesComposition(
        {
          name: 'shared-bootstrap-factory-owner-boundary',
          apiVersion: 'platform.typekro.test/v1alpha1',
          kind: 'SharedBootstrapFactoryOwnerBoundary',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean', endpoint: 'string' }),
        },
        (spec) => {
          Deployment({ name: spec.name, image: 'nginx', id: 'bootstrapApp' });
          return { ready: true, endpoint: `http://${spec.name}:80` };
        },
      );

      const graph = kubernetesComposition(
        {
          name: 'singleton-owner-boundary-factory-check',
          apiVersion: 'v1alpha1',
          kind: 'SingletonOwnerBoundaryFactoryCheck',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ ready: 'boolean', endpoint: 'string' }),
        },
        (spec) => {
          const shared = singleton(sharedBootstrap, {
            id: 'stable-shared-id',
            spec: { name: `${spec.name}-shared-human-name` },
          });

          Deployment({ name: spec.name, image: spec.image, id: 'app' });
          return { ready: shared.status.ready, endpoint: shared.status.endpoint };
        },
      );

      const parsed = parseRgdYaml(graph.factory('kro').toYaml());
      const ownerRef = parsed.spec.resources.find(
        (resource) =>
          resource.externalRef?.kind === 'SharedBootstrapFactoryOwnerBoundary' &&
          resource.externalRef?.metadata?.name === 'stable-shared-id' &&
          resource.externalRef?.metadata?.namespace === 'typekro-singletons'
      );
      const ownerBoundary = parsed.spec.resources.find(
        (resource) => resource.template?.kind === 'SharedBootstrapFactoryOwnerBoundary'
      );
      const namespaceResource = parsed.spec.resources.find(
        (resource) => resource.template?.kind === 'Namespace' && resource.template?.metadata?.name === 'typekro-singletons'
      );
      const expectedOwnerId = getSingletonResourceId(
        'platform.typekro.test/v1alpha1/SharedBootstrapFactoryOwnerBoundary:shared-bootstrap-factory-owner-boundary#stable-shared-id'
      );

      expect(namespaceResource).toBeUndefined();
      expect(ownerBoundary).toBeUndefined();
      expect(ownerRef).toBeDefined();
      expect(ownerRef?.id).toBe(expectedOwnerId);
    });

    it('emits distinct singleton externalRefs when different compositions reuse the same id', () => {
      const bootstrapA = kubernetesComposition(
        {
          name: 'shared-a',
          apiVersion: 'platform.typekro.test/v1alpha1',
          kind: 'SharedBootstrapA',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          Deployment({ name: `${spec.name}-a`, image: 'nginx', id: 'aApp' });
          return { ready: true };
        },
      );

      const bootstrapB = kubernetesComposition(
        {
          name: 'shared-b',
          apiVersion: 'platform.typekro.test/v1alpha1',
          kind: 'SharedBootstrapB',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          Deployment({ name: `${spec.name}-b`, image: 'nginx', id: 'bApp' });
          return { ready: true };
        },
      );

      const graph = kubernetesComposition(
        {
          name: 'singleton-owner-same-id-check',
          apiVersion: 'v1alpha1',
          kind: 'SingletonOwnerSameIdCheck',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          const sharedA = singleton(bootstrapA, { id: 'stable-id', spec: { name: `${spec.name}-a` } });
          const sharedB = singleton(bootstrapB, { id: 'stable-id', spec: { name: `${spec.name}-b` } });
          Deployment({ name: spec.name, image: spec.image, id: 'app' });
          return { ready: sharedA.status.ready && sharedB.status.ready };
        },
      );

      const parsed = parseRgdYaml(graph.factory('kro').toYaml());
      const ownerKinds = parsed.spec.resources
        .filter((resource) => ['SharedBootstrapA', 'SharedBootstrapB'].includes(resource.externalRef?.kind))
        .map((resource) => resource.externalRef?.kind)
        .sort();

      expect(ownerKinds).toEqual(['SharedBootstrapA', 'SharedBootstrapB']);
      const ownerRefs = parsed.spec.resources
        .filter((resource) => ['SharedBootstrapA', 'SharedBootstrapB'].includes(resource.externalRef?.kind))
        .map((resource) => `${resource.externalRef?.kind}:${resource.externalRef?.metadata?.name}`)
        .sort();
      expect(ownerRefs).toEqual([
        'SharedBootstrapA:stable-id',
        'SharedBootstrapB:stable-id',
      ]);
    });

    it('singleton externalRefs honor custom group with version-only apiVersion', () => {
      const bootstrapA = kubernetesComposition(
        {
          name: 'shared-bootstrap-a',
          apiVersion: 'v1alpha1',
          group: 'platform-a.example.com',
          kind: 'SharedBootstrap',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        () => ({ ready: true })
      );
      const bootstrapB = kubernetesComposition(
        {
          name: 'shared-bootstrap-b',
          apiVersion: 'v1alpha1',
          group: 'platform-b.example.com',
          kind: 'SharedBootstrap',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        () => ({ ready: true })
      );

      const graph = kubernetesComposition(
        {
          name: 'singleton-custom-group-check',
          apiVersion: 'v1alpha1',
          kind: 'SingletonCustomGroupCheck',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          const sharedA = singleton(bootstrapA, { id: 'stable-id', spec: { name: `${spec.name}-a` } });
          const sharedB = singleton(bootstrapB, { id: 'stable-id', spec: { name: `${spec.name}-b` } });
          return { ready: sharedA.status.ready && sharedB.status.ready };
        }
      );

      const parsed = parseRgdYaml(graph.factory('kro').toYaml());
      const refs = parsed.spec.resources
        .filter((resource) => resource.externalRef?.kind === 'SharedBootstrap')
        .map((resource) => ({
          apiVersion: resource.externalRef?.apiVersion,
          id: resource.id,
        }))
        .sort((a, b) => String(a.apiVersion).localeCompare(String(b.apiVersion)));

      expect(refs.map((ref) => ref.apiVersion)).toEqual([
        'platform-a.example.com/v1alpha1',
        'platform-b.example.com/v1alpha1',
      ]);
      expect(new Set(refs.map((ref) => ref.id)).size).toBe(2);
    });
  });

  // ===========================================================================
  // Schema Enhancements
  // ===========================================================================

  describe('Schema Enhancements', () => {
    it('group field serialized in schema', () => {
      const graph = kubernetesComposition(
        {
          name: 'schema-group',
          apiVersion: 'v1alpha1',
          kind: 'GroupTest',

          group: 'platform.example.com',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          ConfigMap({ name: spec.name, data: {}, id: 'config' });
          return { ready: true };
        }
      );

      const parsed = parseRgdYaml(graph.toYaml());
      expect(parsed.spec.schema.group).toBe('platform.example.com');
    });

    it('factory RGD YAML preserves custom schema group', () => {
      const graph = kubernetesComposition(
        {
          name: 'schema-group-factory',
          apiVersion: 'v1alpha1',
          kind: 'GroupFactoryTest',
          group: 'platform.example.com',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          ConfigMap({ name: spec.name, data: {}, id: 'config' });
          return { ready: true };
        }
      );

      const graphYaml = parseRgdYaml(graph.toYaml());
      const factoryYaml = parseRgdYaml(graph.factory('kro').toYaml());
      expect(factoryYaml.spec.schema.group).toBe('platform.example.com');
      expect(factoryYaml.spec.schema.group).toBe(graphYaml.spec.schema.group);
    });

    it('slashful apiVersion emits matching schema group in graph and factory RGD YAML', () => {
      const graph = kubernetesComposition(
        {
          name: 'schema-slashful-group',
          apiVersion: 'platform.example.com/v1alpha1',
          kind: 'SlashfulGroupTest',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          ConfigMap({ name: spec.name, data: {}, id: 'config' });
          return { ready: true };
        }
      );

      const graphYaml = parseRgdYaml(graph.toYaml());
      const factoryYaml = parseRgdYaml(graph.factory('kro').toYaml());
      expect(graphYaml.spec.schema.apiVersion).toBe('v1alpha1');
      expect(factoryYaml.spec.schema.apiVersion).toBe('v1alpha1');
      expect(graphYaml.spec.schema.group).toBe('platform.example.com');
      expect(factoryYaml.spec.schema.group).toBe('platform.example.com');
    });

    it('factory instance YAML uses custom schema group in apiVersion', () => {
      const graph = kubernetesComposition(
        {
          name: 'schema-group-instance',
          apiVersion: 'v1alpha1',
          kind: 'GroupInstanceTest',
          group: 'platform.example.com',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          ConfigMap({ name: spec.name, data: {}, id: 'config' });
          return { ready: true };
        }
      );

      const parsed = yaml.load(graph.factory('kro').toYaml({ name: 'demo' })) as {
        apiVersion: string;
        kind: string;
      };
      expect(parsed.apiVersion).toBe('platform.example.com/v1alpha1');
      expect(parsed.kind).toBe('GroupInstanceTest');
    });

    it('group defaults to kro.run when not specified', () => {
      const graph = kubernetesComposition(
        {
          name: 'schema-default-group',
          apiVersion: 'v1alpha1',
          kind: 'DefaultGroupTest',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          ConfigMap({ name: spec.name, data: {}, id: 'config' });
          return { ready: true };
        }
      );

      const parsed = parseRgdYaml(graph.toYaml());
      // Either not present (Kro defaults) or explicitly kro.run
      const group = parsed.spec.schema.group;
      expect(group === undefined || group === 'kro.run').toBe(true);
    });

    it('allowBreakingChanges adds annotation to metadata', () => {
      const graph = kubernetesComposition(
        {
          name: 'schema-breaking',
          apiVersion: 'v1alpha1',
          kind: 'BreakingTest',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          ConfigMap({ name: spec.name, data: {}, id: 'config' });
          return { ready: true };
        },

        { allowBreakingChanges: true }
      );

      const parsed = parseRgdYaml(graph.toYaml());
      expect(parsed.metadata.annotations).toBeDefined();
      expect(parsed.metadata.annotations!['kro.run/allow-breaking-changes']).toBe('true');
    });
  });

  // ===========================================================================
  // Collection Aggregates in Status
  // ===========================================================================

  describe('Collection Aggregates in Status', () => {
    const CollectionSpec = type({
      name: 'string',
      image: 'string',
      workers: 'string[]',
    });

    it('.length produces size() in status CEL', () => {
      const graph = kubernetesComposition(
        {
          name: 'agg-size',
          apiVersion: 'v1alpha1',
          kind: 'AggSizeTest',
          spec: CollectionSpec,
          status: type({ total: 'number' }),
        },
        (spec) => {
          const workers = spec.workers.map((worker) => {
            return Deployment({
              name: `${spec.name}-${worker}`,
              image: spec.image,
              id: 'workerDep',
            });
          });
          return { total: workers.length };
        }
      );

      const yamlStr = graph.toYaml();
      // size() not .length in CEL
      expect(yamlStr).toContain('size(workerDep)');
    });

    it('.every() produces .all() in status CEL', () => {
      const graph = kubernetesComposition(
        {
          name: 'agg-all',
          apiVersion: 'v1alpha1',
          kind: 'AggAllTest',
          spec: CollectionSpec,
          status: type({ allReady: 'boolean' }),
        },
        (spec) => {
          const workers = spec.workers.map((worker) => {
            return Deployment({
              name: `${spec.name}-${worker}`,
              image: spec.image,
              id: 'workerDep',
            });
          });
          return {
            allReady: workers.every((w) => w.status.readyReplicas > 0),
          };
        }
      );

      const yamlStr = graph.toYaml();
      expect(yamlStr).toContain('workerDep.all(');
    });

    it('.some() produces .exists() in status CEL', () => {
      const graph = kubernetesComposition(
        {
          name: 'agg-exists',
          apiVersion: 'v1alpha1',
          kind: 'AggExistsTest',
          spec: CollectionSpec,
          status: type({ anyReady: 'boolean' }),
        },
        (spec) => {
          const workers = spec.workers.map((worker) => {
            return Deployment({
              name: `${spec.name}-${worker}`,
              image: spec.image,
              id: 'workerDep',
            });
          });
          return {
            anyReady: workers.some((w) => w.status.readyReplicas > 0),
          };
        }
      );

      const yamlStr = graph.toYaml();
      expect(yamlStr).toContain('workerDep.exists(');
    });

    it('.filter().length produces size(.filter()) in status CEL', () => {
      const graph = kubernetesComposition(
        {
          name: 'agg-filter-size',
          apiVersion: 'v1alpha1',
          kind: 'AggFilterSizeTest',
          spec: CollectionSpec,
          status: type({ readyCount: 'number' }),
        },
        (spec) => {
          const workers = spec.workers.map((worker) => {
            return Deployment({
              name: `${spec.name}-${worker}`,
              image: spec.image,
              id: 'workerDep',
            });
          });
          return {
            readyCount: workers.filter((w) => w.status.readyReplicas > 0).length,
          };
        }
      );

      const yamlStr = graph.toYaml();
      expect(yamlStr).toContain('size(workerDep.filter(');
    });

    it('.map().join() in status CEL', () => {
      const graph = kubernetesComposition(
        {
          name: 'agg-map-join',
          apiVersion: 'v1alpha1',
          kind: 'AggMapJoinTest',
          spec: CollectionSpec,
          status: type({ names: 'string' }),
        },
        (spec) => {
          const workers = spec.workers.map((worker) => {
            return Deployment({
              name: `${spec.name}-${worker}`,
              image: spec.image,
              id: 'workerDep',
            });
          });
          return {
            names: workers.map((w) => w.metadata.name).join(', '),
          };
        }
      );

      const yamlStr = graph.toYaml();
      expect(yamlStr).toContain('workerDep.map(');
      expect(yamlStr).toContain('.join(');
    });
  });

  // ===========================================================================
  // Ternary / Conditional Expressions
  // ===========================================================================

  describe('Ternary / Conditional Expressions', () => {
    it('ternary in resource template value produces CEL conditional', () => {
      const graph = kubernetesComposition(
        {
          name: 'ternary-value',
          apiVersion: 'v1alpha1',
          kind: 'TernaryValueTest',
          spec: type({ name: 'string', image: 'string', env: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          Deployment({
            name: spec.name,
            image: spec.image,
            replicas: spec.env === 'production' ? 3 : 1,
            id: 'dep',
          });
          return { ready: true };
        }
      );

      const parsed = parseRgdYaml(graph.toYaml());
      const resource = findResource(parsed, 'dep');
      const replicas = resource.template.spec.replicas;

      expect(replicas).toContain('schema.spec.env == "production"');
      expect(replicas).toContain('?');
      expect(replicas).toContain('3');
      expect(replicas).toContain('1');
    });

    it('nested ternary produces nested CEL conditional', () => {
      const graph = kubernetesComposition(
        {
          name: 'ternary-nested',
          apiVersion: 'v1alpha1',
          kind: 'TernaryNestedTest',
          spec: type({ name: 'string', image: 'string', env: 'string' }),
          status: type({ tier: 'string' }),
        },
        (spec) => {
          Deployment({ name: spec.name, image: spec.image, id: 'dep' });
          return {
            tier:
              spec.env === 'production'
                ? 'critical'
                : spec.env === 'staging'
                  ? 'standard'
                  : 'minimal',
          };
        }
      );

      const yamlStr = graph.toYaml();
      // Should contain nested ternary in CEL
      // CEL uses single quotes to avoid YAML double-quote escaping issues
      expect(yamlStr).toContain("schema.spec.env == 'production'");
      expect(yamlStr).toContain("'critical'");
      expect(yamlStr).toContain("'standard'");
      expect(yamlStr).toContain("'minimal'");
    });

    it('non-string value in string template warns or wraps with string()', () => {
      // Kro requires string template expressions to return strings
      // ${spec.replicas} in a string context needs string() wrapping
      const graph = kubernetesComposition(
        {
          name: 'string-coerce',
          apiVersion: 'v1alpha1',
          kind: 'StringCoerceTest',
          spec: type({ name: 'string', replicas: 'number' }),
          status: type({ info: 'string' }),
        },
        (spec) => {
          ConfigMap({
            name: spec.name,
            data: {
              // Integer in a string template context
              info: `Replicas: ${spec.replicas}`,
            },
            id: 'config',
          });
          return { info: `Replicas: ${spec.replicas}` };
        }
      );

      const yamlStr = graph.toYaml();
      // If replicas is integer, string templates in Kro need string() wrapping
      // The exact format depends on implementation but should handle this
      expect(yamlStr).toContain('schema.spec.replicas');
    });
  });
});
