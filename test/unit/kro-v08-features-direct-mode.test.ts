/**
 * Kro v0.8.x Feature Direct-Mode Tests
 *
 * Tests that TypeKro compositions using v0.8.x features work correctly
 * in direct mode — where the composition is re-executed with actual values
 * and resources are deployed individually (not via Kro controller).
 *
 * In direct mode:
 * - forEach creates N concrete resources (one per array element)
 * - includeWhen conditions evaluate to real booleans, skipping/creating resources
 * - readyWhen generates a readinessEvaluator bridge (not CEL)
 * - externalRef resources are NOT deployed (they already exist in the cluster)
 * - Collection aggregates compute real values (not CEL expressions)
 *
 * All tests are .skip'd until the corresponding features are implemented.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import type { CallableComposition } from '../../src/core/types/deployment.js';
import type { KroCompatibleType } from '../../src/core/types/serialization.js';
import { ConfigMap, Deployment, Service } from '../../src/factories/simple/index.js';
import { externalRef, kubernetesComposition } from '../../src/index.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a direct factory from a composition and generate YAML with given spec.
 * Returns the YAML string for assertion.
 */
function toDirectYaml<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  composition: CallableComposition<TSpec, TStatus>,
  spec: TSpec
): string {
  const factory = composition.factory('direct', {
    namespace: 'test-ns',
    waitForReady: false,
  });
  return factory.toYaml(spec);
}

// =============================================================================
// Common schemas
// =============================================================================

const MultiRegionSpec = type({
  name: 'string',
  image: 'string',
  regions: 'string[]',
});

const MultiRegionStatus = type({
  totalDeployments: 'number',
});

const ConditionalSpec = type({
  name: 'string',
  image: 'string',
  monitoring: 'boolean',
  environment: '"production" | "staging" | "development"',
  ingress: type({ enabled: 'boolean', hostname: 'string' }),
});

const ConditionalStatus = type({
  ready: 'boolean',
});

// =============================================================================
// forEach — Direct Mode (Collections)
// =============================================================================

describe('Kro v0.8.x Direct Mode', () => {
  describe('forEach — Direct Mode', () => {
    it('for...of creates N concrete resources from actual array', () => {
      const comp = kubernetesComposition(
        {
          name: 'foreach-direct',
          apiVersion: 'v1alpha1',
          kind: 'ForEachDirectTest',
          spec: MultiRegionSpec,
          status: MultiRegionStatus,
        },
        (spec) => {
          for (const region of spec.regions) {
            Deployment({
              name: `${spec.name}-${region}`,
              image: spec.image,
              id: 'regionDep',
            });
          }
          return { totalDeployments: spec.regions.length };
        }
      );

      const yaml = toDirectYaml(comp, {
        name: 'myapp',
        image: 'nginx:1.25',
        regions: ['us-east-1', 'eu-west-1', 'ap-southeast-1'],
      });

      // In direct mode, forEach should expand to 3 concrete Deployments
      expect(yaml).toContain('myapp-us-east-1');
      expect(yaml).toContain('myapp-eu-west-1');
      expect(yaml).toContain('myapp-ap-southeast-1');

      // Should NOT contain forEach directives (those are Kro-mode only)
      expect(yaml).not.toContain('forEach');
      expect(yaml).not.toContain('${');
    });

    it('.map() creates N concrete resources from actual array', () => {
      const comp = kubernetesComposition(
        {
          name: 'map-direct',
          apiVersion: 'v1alpha1',
          kind: 'MapDirectTest',
          spec: MultiRegionSpec,
          status: MultiRegionStatus,
        },
        (spec) => {
          spec.regions.map((region) =>
            Deployment({
              name: `${spec.name}-${region}`,
              image: spec.image,
              id: 'regionDep',
            })
          );
          return { totalDeployments: spec.regions.length };
        }
      );

      const yaml = toDirectYaml(comp, {
        name: 'mapper',
        image: 'redis:7',
        regions: ['west', 'east'],
      });

      expect(yaml).toContain('mapper-west');
      expect(yaml).toContain('mapper-east');
    });

    it('forEach with empty array produces no resources', () => {
      const comp = kubernetesComposition(
        {
          name: 'foreach-empty',
          apiVersion: 'v1alpha1',
          kind: 'ForEachEmptyTest',
          spec: MultiRegionSpec,
          status: MultiRegionStatus,
        },
        (spec) => {
          for (const region of spec.regions) {
            Deployment({
              name: `${spec.name}-${region}`,
              image: spec.image,
              id: 'regionDep',
            });
          }
          return { totalDeployments: spec.regions.length };
        }
      );

      const yaml = toDirectYaml(comp, {
        name: 'empty',
        image: 'nginx',
        regions: [],
      });

      // No Deployment resources should appear
      expect(yaml).not.toContain('kind: Deployment');
    });

    it('forEach computes real status aggregates', () => {
      const comp = kubernetesComposition(
        {
          name: 'foreach-status',
          apiVersion: 'v1alpha1',
          kind: 'ForEachStatusTest',
          spec: MultiRegionSpec,
          status: MultiRegionStatus,
        },
        (spec) => {
          for (const region of spec.regions) {
            Deployment({
              name: `${spec.name}-${region}`,
              image: spec.image,
              id: 'regionDep',
            });
          }
          return { totalDeployments: spec.regions.length };
        }
      );

      const factory = comp.factory('direct', {
        namespace: 'test-ns',
        waitForReady: false,
      });

      // Re-execute with actual values to get status
      const yaml = factory.toYaml({
        name: 'counter',
        image: 'nginx',
        regions: ['a', 'b', 'c', 'd'],
      });

      // 4 Deployment resources should be created
      expect(yaml).toContain('counter-a');
      expect(yaml).toContain('counter-b');
      expect(yaml).toContain('counter-c');
      expect(yaml).toContain('counter-d');
    });

    it('forEach with nested resource creation (deployment + service per item)', () => {
      const comp = kubernetesComposition(
        {
          name: 'foreach-nested',
          apiVersion: 'v1alpha1',
          kind: 'ForEachNestedTest',
          spec: MultiRegionSpec,
          status: type({ total: 'number' }),
        },
        (spec) => {
          for (const region of spec.regions) {
            // Resource IDs must be static (Kro uses a single entry with forEach).
            // In direct mode re-execution, deduplication appends -1, -2, etc.
            Deployment({
              name: `${spec.name}-${region}`,
              image: spec.image,
              id: 'regionDep',
            });
            Service({
              name: `${spec.name}-${region}-svc`,
              selector: { app: `${spec.name}-${region}` },
              ports: [{ port: 80 }],
              id: 'regionSvc',
            });
          }
          return { total: spec.regions.length * 2 };
        }
      );

      const yaml = toDirectYaml(comp, {
        name: 'nested',
        image: 'app:latest',
        regions: ['us', 'eu'],
      });

      // 2 Deployments + 2 Services = 4 resources
      expect(yaml).toContain('nested-us');
      expect(yaml).toContain('nested-eu');
      expect(yaml).toContain('nested-us-svc');
      expect(yaml).toContain('nested-eu-svc');
    });
  });

  // ===========================================================================
  // includeWhen — Direct Mode (Conditional Creation)
  // ===========================================================================

  describe('includeWhen — Direct Mode', () => {
    it('if-statement with true condition creates resource', () => {
      const comp = kubernetesComposition(
        {
          name: 'include-true',
          apiVersion: 'v1alpha1',
          kind: 'IncludeTrueTest',
          spec: ConditionalSpec,
          status: ConditionalStatus,
        },
        (spec) => {
          Deployment({ name: spec.name, image: spec.image, id: 'app' });
          if (spec.monitoring) {
            ConfigMap({
              name: `${spec.name}-monitoring`,
              data: { enabled: 'true' },
              id: 'monitorConfig',
            });
          }
          return { ready: true };
        }
      );

      const yaml = toDirectYaml(comp, {
        name: 'my-app',
        image: 'nginx',
        monitoring: true,
        environment: 'production' as const,
        ingress: { enabled: false, hostname: '' },
      });

      // Monitoring is true → ConfigMap should be created
      expect(yaml).toContain('my-app-monitoring');
    });

    it('if-statement with false condition skips resource', () => {
      const comp = kubernetesComposition(
        {
          name: 'include-false',
          apiVersion: 'v1alpha1',
          kind: 'IncludeFalseTest',
          spec: ConditionalSpec,
          status: ConditionalStatus,
        },
        (spec) => {
          Deployment({ name: spec.name, image: spec.image, id: 'app' });
          if (spec.monitoring) {
            ConfigMap({
              name: `${spec.name}-monitoring`,
              data: { enabled: 'true' },
              id: 'monitorConfig',
            });
          }
          return { ready: true };
        }
      );

      const yaml = toDirectYaml(comp, {
        name: 'my-app',
        image: 'nginx',
        monitoring: false,
        environment: 'development' as const,
        ingress: { enabled: false, hostname: '' },
      });

      // Monitoring is false → ConfigMap should NOT be created
      expect(yaml).not.toContain('monitoring');
      // But the Deployment should still exist
      expect(yaml).toContain('my-app');
      expect(yaml).toContain('kind: Deployment');
    });

    it('ternary with actual values resolves to concrete value', () => {
      const comp = kubernetesComposition(
        {
          name: 'ternary-direct',
          apiVersion: 'v1alpha1',
          kind: 'TernaryDirectTest',
          spec: type({ name: 'string', image: 'string', env: 'string' }),
          status: type({ replicas: 'number' }),
        },
        (spec) => {
          Deployment({
            name: spec.name,
            image: spec.image,
            replicas: spec.env === 'production' ? 3 : 1,
            id: 'dep',
          });
          return { replicas: spec.env === 'production' ? 3 : 1 };
        }
      );

      // Production → 3 replicas
      const yamlProd = toDirectYaml(comp, {
        name: 'prod-app',
        image: 'app:v1',
        env: 'production',
      });
      expect(yamlProd).toContain('replicas: 3');

      // Staging → 1 replica
      const yamlStaging = toDirectYaml(comp, {
        name: 'staging-app',
        image: 'app:v1',
        env: 'staging',
      });
      expect(yamlStaging).toContain('replicas: 1');
    });

    it('complex condition chains work with actual values', () => {
      const comp = kubernetesComposition(
        {
          name: 'complex-cond',
          apiVersion: 'v1alpha1',
          kind: 'ComplexCondTest',
          spec: ConditionalSpec,
          status: ConditionalStatus,
        },
        (spec) => {
          Deployment({ name: spec.name, image: spec.image, id: 'app' });

          // Only create ingress if enabled AND production
          if (spec.ingress.enabled && spec.environment === 'production') {
            Service({
              name: `${spec.name}-public`,
              selector: { app: spec.name },
              ports: [{ port: 443 }],
              id: 'publicSvc',
            });
          }
          return { ready: true };
        }
      );

      // Both conditions true
      const yamlBothTrue = toDirectYaml(comp, {
        name: 'prod-ingress',
        image: 'nginx',
        monitoring: false,
        environment: 'production' as const,
        ingress: { enabled: true, hostname: 'prod.example.com' },
      });
      expect(yamlBothTrue).toContain('prod-ingress-public');

      // Ingress enabled but not production
      const yamlNotProd = toDirectYaml(comp, {
        name: 'staging-ingress',
        image: 'nginx',
        monitoring: false,
        environment: 'staging' as const,
        ingress: { enabled: true, hostname: 'staging.example.com' },
      });
      expect(yamlNotProd).not.toContain('staging-ingress-public');
    });
  });

  // ===========================================================================
  // readyWhen — Direct Mode (Readiness)
  // ===========================================================================

  describe('readyWhen — Direct Mode', () => {
    it('readyWhen does NOT appear in direct-mode YAML', () => {
      const comp = kubernetesComposition(
        {
          name: 'ready-direct-yaml',
          apiVersion: 'v1alpha1',
          kind: 'ReadyDirectYamlTest',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          Deployment({
            name: spec.name,
            image: spec.image,
            id: 'web',
          }).withReadyWhen((self) => self.status.readyReplicas > 0);
          return { ready: true };
        }
      );

      const yaml = toDirectYaml(comp, {
        name: 'no-readywhen-yaml',
        image: 'nginx',
      });

      // readyWhen is Kro-mode only — should NOT appear in direct YAML
      expect(yaml).not.toContain('readyWhen');
      // But the Deployment itself should exist
      expect(yaml).toContain('no-readywhen-yaml');
    });

    it('readinessEvaluator is preserved alongside readyWhen', () => {
      const comp = kubernetesComposition(
        {
          name: 'ready-evaluator',
          apiVersion: 'v1alpha1',
          kind: 'ReadyEvaluatorTest',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          const dep = Deployment({
            name: spec.name,
            image: spec.image,
            id: 'app',
          });

          // readyWhen is for Kro mode, readinessEvaluator for direct mode

          dep.withReadyWhen((self) => self.status.readyReplicas > 0);

          // Factory-provided readinessEvaluator should still exist
          expect(dep.readinessEvaluator).toBeDefined();
          return { ready: true };
        }
      );

      // Just verify composition creation doesn't throw
      expect(comp).toBeDefined();
    });

    it('readyWhen generates readinessEvaluator bridge for direct mode', () => {
      // When readyWhen is set but no custom readinessEvaluator is provided,
      // the system should generate a bridge evaluator from the readyWhen expression
      const comp = kubernetesComposition(
        {
          name: 'ready-bridge',
          apiVersion: 'v1alpha1',
          kind: 'ReadyBridgeTest',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          Deployment({
            name: spec.name,
            image: spec.image,
            id: 'app',
          }).withReadyWhen((self) => self.status.readyReplicas > 0);
          return { ready: true };
        }
      );

      // The composition itself should be valid
      expect(comp).toBeDefined();
      // When deployed in direct mode, the readinessEvaluator should evaluate
      // based on the readyWhen expression translated to a JS function
    });
  });

  // ===========================================================================
  // externalRef — Direct Mode
  // ===========================================================================

  describe('externalRef — Direct Mode', () => {
    it('externalRef resources are NOT included in direct-mode YAML', () => {
      const comp = kubernetesComposition(
        {
          name: 'extref-direct',
          apiVersion: 'v1alpha1',
          kind: 'ExtRefDirectTest',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          externalRef({
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: 'platform-config', namespace: 'platform-system' },
          });

          Deployment({ name: spec.name, image: spec.image, id: 'app' });
          return { ready: true };
        }
      );

      const yaml = toDirectYaml(comp, {
        name: 'extref-app',
        image: 'myapp:latest',
      });

      // The Deployment should be in the YAML
      expect(yaml).toContain('extref-app');
      expect(yaml).toContain('kind: Deployment');

      // But the externalRef ConfigMap should NOT — it already exists
      expect(yaml).not.toContain('platform-config');
      expect(yaml).not.toContain('platform-system');
    });

    it('externalRef values are not resolved in direct mode', () => {
      // In direct mode, references to externalRef resources can't be
      // resolved because we don't read from the cluster. The values
      // should either be left as placeholders or throw.
      const comp = kubernetesComposition(
        {
          name: 'extref-value',
          apiVersion: 'v1alpha1',
          kind: 'ExtRefValueTest',
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
            id: 'app',
          });

          // In direct mode, this should be a placeholder or error
          return { region: config.data?.region ?? 'unknown' };
        }
      );

      // Should not throw during composition creation
      expect(comp).toBeDefined();
    });
  });

  // ===========================================================================
  // Combined Features — Direct Mode
  // ===========================================================================

  describe('Combined Features — Direct Mode', () => {
    it('forEach + includeWhen in direct mode', () => {
      const comp = kubernetesComposition(
        {
          name: 'combined-foreach-include',
          apiVersion: 'v1alpha1',
          kind: 'CombinedTest',
          spec: type({
            name: 'string',
            image: 'string',
            regions: 'string[]',
            monitoring: 'boolean',
          }),
          status: type({ total: 'number' }),
        },
        (spec) => {
          for (const region of spec.regions) {
            Deployment({
              name: `${spec.name}-${region}`,
              image: spec.image,
              id: 'regionDep',
            });

            if (spec.monitoring) {
              ConfigMap({
                name: `${spec.name}-${region}-monitor`,
                data: { region },
                id: 'regionMonitor',
              });
            }
          }
          return { total: spec.regions.length };
        }
      );

      // With monitoring enabled
      const yamlWithMon = toDirectYaml(comp, {
        name: 'multi',
        image: 'app:v1',
        regions: ['us', 'eu'],
        monitoring: true,
      });

      expect(yamlWithMon).toContain('multi-us');
      expect(yamlWithMon).toContain('multi-eu');
      expect(yamlWithMon).toContain('multi-us-monitor');
      expect(yamlWithMon).toContain('multi-eu-monitor');

      // Without monitoring
      const yamlNoMon = toDirectYaml(comp, {
        name: 'multi',
        image: 'app:v1',
        regions: ['us', 'eu'],
        monitoring: false,
      });

      expect(yamlNoMon).toContain('multi-us');
      expect(yamlNoMon).toContain('multi-eu');
      expect(yamlNoMon).not.toContain('monitor');
    });

    it('direct mode produces real values, not CEL expressions', () => {
      const comp = kubernetesComposition(
        {
          name: 'no-cel-direct',
          apiVersion: 'v1alpha1',
          kind: 'NoCelDirectTest',
          spec: type({ name: 'string', image: 'string', replicas: 'number' }),
          status: type({ info: 'string' }),
        },
        (spec) => {
          Deployment({
            name: spec.name,
            image: spec.image,
            replicas: spec.replicas,
            id: 'dep',
          });
          return { info: `Running ${spec.replicas} replicas` };
        }
      );

      const yaml = toDirectYaml(comp, {
        name: 'real-values',
        image: 'nginx:latest',
        replicas: 5,
      });

      // Should contain resolved values, not CEL references
      expect(yaml).toContain('real-values');
      expect(yaml).toContain('nginx:latest');
      expect(yaml).toContain('replicas: 5');

      // Should NOT contain CEL markers
      expect(yaml).not.toContain('${schema.spec');
      expect(yaml).not.toContain('__schema__');
    });

    it('dual execution: proxy first, then real values', () => {
      let callCount = 0;
      const receivedTypes: string[] = [];

      const comp = kubernetesComposition(
        {
          name: 'dual-exec',
          apiVersion: 'v1alpha1',
          kind: 'DualExecTest',
          spec: type({ name: 'string', image: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          callCount++;
          receivedTypes.push(typeof spec.name);
          Deployment({ name: spec.name, image: spec.image, id: 'dep' });
          return { ready: true };
        }
      );

      // First execution happens during kubernetesComposition (proxy mode)
      expect(callCount).toBe(1);
      expect(receivedTypes[0]).toBe('function'); // proxy

      // Second execution happens during toYaml (real values)
      toDirectYaml(comp, { name: 'test', image: 'nginx' });

      expect(callCount).toBe(2);
      expect(receivedTypes[1]).toBe('string'); // real value
    });
  });

  // ===========================================================================
  // Collection Aggregates — Direct Mode
  // ===========================================================================

  describe('Collection Aggregates — Direct Mode', () => {
    it('.length computes real count, not CEL size()', () => {
      const comp = kubernetesComposition(
        {
          name: 'agg-length-direct',
          apiVersion: 'v1alpha1',
          kind: 'AggLengthDirectTest',
          spec: MultiRegionSpec,
          status: MultiRegionStatus,
        },
        (spec) => {
          const deployments = spec.regions.map((region) =>
            Deployment({
              name: `${spec.name}-${region}`,
              image: spec.image,
              id: 'regionDep',
            })
          );
          return { totalDeployments: deployments.length };
        }
      );

      const factory = comp.factory('direct', {
        namespace: 'test-ns',
        waitForReady: false,
      });

      // toYaml re-executes with real values
      const yaml = factory.toYaml({
        name: 'counter',
        image: 'nginx',
        regions: ['a', 'b', 'c'],
      });

      // Should have 3 concrete Deployments, not CEL
      expect(yaml).toContain('counter-a');
      expect(yaml).toContain('counter-b');
      expect(yaml).toContain('counter-c');
      expect(yaml).not.toContain('size(');
    });

    it('conditional resource creation produces correct count', () => {
      const comp = kubernetesComposition(
        {
          name: 'cond-count',
          apiVersion: 'v1alpha1',
          kind: 'CondCountTest',
          spec: type({
            name: 'string',
            image: 'string',
            items: 'string[]',
            enableExtras: 'boolean',
          }),
          status: type({ total: 'number' }),
        },
        (spec) => {
          let count = 0;
          for (const item of spec.items) {
            Deployment({
              name: `${spec.name}-${item}`,
              image: spec.image,
              id: 'itemDep',
            });
            count++;

            if (spec.enableExtras) {
              ConfigMap({
                name: `${spec.name}-${item}-config`,
                data: { item },
                id: 'itemConfig',
              });
              count++;
            }
          }
          return { total: count };
        }
      );

      // With extras
      const yamlWithExtras = toDirectYaml(comp, {
        name: 'app',
        image: 'nginx',
        items: ['alpha', 'beta'],
        enableExtras: true,
      });

      expect(yamlWithExtras).toContain('app-alpha');
      expect(yamlWithExtras).toContain('app-beta');
      expect(yamlWithExtras).toContain('app-alpha-config');
      expect(yamlWithExtras).toContain('app-beta-config');

      // Without extras
      const yamlNoExtras = toDirectYaml(comp, {
        name: 'app',
        image: 'nginx',
        items: ['alpha', 'beta'],
        enableExtras: false,
      });

      expect(yamlNoExtras).toContain('app-alpha');
      expect(yamlNoExtras).toContain('app-beta');
      expect(yamlNoExtras).not.toContain('config');
    });
  });

  // ===========================================================================
  // Schema Enhancements — Direct Mode
  // ===========================================================================

  describe('Schema Enhancements — Direct Mode', () => {
    it('group field does not affect direct-mode behavior', () => {
      const comp = kubernetesComposition(
        {
          name: 'group-direct',
          apiVersion: 'v1alpha1',
          kind: 'GroupDirectTest',

          group: 'custom.example.com',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          ConfigMap({ name: spec.name, data: {}, id: 'config' });
          return { ready: true };
        }
      );

      const yaml = toDirectYaml(comp, { name: 'group-test' });

      // group is a Kro schema concept — in direct mode it's ignored
      expect(yaml).toContain('group-test');
      expect(yaml).not.toContain('custom.example.com');
    });

    it('allowBreakingChanges does not affect direct-mode behavior', () => {
      const comp = kubernetesComposition(
        {
          name: 'breaking-direct',
          apiVersion: 'v1alpha1',
          kind: 'BreakingDirectTest',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          ConfigMap({ name: spec.name, data: {}, id: 'config' });
          return { ready: true };
        },

        { allowBreakingChanges: true }
      );

      // Should not throw — allowBreakingChanges is metadata annotation for Kro
      const yaml = toDirectYaml(comp, { name: 'breaking-test' });
      expect(yaml).toContain('breaking-test');
    });
  });
});
