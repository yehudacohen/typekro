/**
 * Kro v0.8.x Comprehensive Composition Test
 *
 * A single realistic composition that exercises ALL v0.8.x features together,
 * tested in both Kro mode (YAML serialization) and direct mode (real values).
 *
 * Scenario: A "PlatformStack" that deploys a multi-region web application with:
 * - forEach: Deploys one Deployment + Service per region
 * - includeWhen: Optionally creates monitoring ConfigMap per region
 * - includeWhen: Optionally creates an Ingress for external access
 * - readyWhen: Each regional deployment must have ready replicas
 * - externalRef: References a pre-existing platform ConfigMap for shared config
 * - group: Custom API group for the CRD
 * - Collection aggregates: Status reflects aggregate readiness across regions
 *
 * All tests are .skip'd until the corresponding features are implemented.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import * as yaml from 'js-yaml';
import type { CallableComposition } from '../../src/core/types/deployment.js';
import type { KroCompatibleType } from '../../src/core/types/serialization.js';
import { ConfigMap, Deployment, Ingress, Service } from '../../src/factories/simple/index.js';
import { externalRef, kubernetesComposition } from '../../src/index.js';

// =============================================================================
// Schema — PlatformStack
// =============================================================================

const PlatformStackSpec = type({
  name: 'string',
  image: 'string',
  replicas: 'number',
  regions: 'string[]',
  monitoring: 'boolean',
  ingress: type({
    enabled: 'boolean',
    hostname: 'string',
  }),
  environment: '"production" | "staging" | "development"',
});

const PlatformStackStatus = type({
  totalDeployments: 'number',
  allRegionsReady: 'boolean',
  anyRegionReady: 'boolean',
  readyCount: 'number',
  regionList: 'string',
  phase: '"Pending" | "Deploying" | "Ready" | "Degraded"',
});

// =============================================================================
// Helpers
// =============================================================================

function parseRgdYaml(yamlStr: string): Record<string, unknown> {
  return yaml.load(yamlStr) as Record<string, unknown>;
}

function findResource(
  parsed: Record<string, unknown>,
  id: string
): Record<string, unknown> | undefined {
  const spec = parsed.spec as Record<string, unknown>;
  const resources = spec.resources as Record<string, unknown>[];
  return resources.find((r) => r.id === id);
}

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
// The Composition
// =============================================================================

/**
 * Creates the PlatformStack composition. Extracted as a function so it can
 * be called in both Kro-mode and direct-mode test suites.
 */
function createPlatformStack() {
  return kubernetesComposition(
    {
      name: 'platform-stack',
      apiVersion: 'v1alpha1',
      kind: 'PlatformStack',

      group: 'platform.example.com',
      spec: PlatformStackSpec,
      status: PlatformStackStatus,
    },
    (spec) => {
      // --- externalRef: shared platform config (already exists in cluster) ---

      const _platformConfig = externalRef({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'platform-defaults', namespace: 'platform-system' },
      });

      // --- forEach: one deployment + service per region ---
      const deployments = spec.regions.map((region) => {
        const dep = Deployment({
          name: `${spec.name}-${region}`,
          image: spec.image,
          replicas: spec.replicas,
          env: {
            REGION: region,
            ENV: spec.environment,
          },
          id: 'regionalDeployment',
        });

        Service({
          name: `${spec.name}-${region}-svc`,
          selector: { app: `${spec.name}-${region}` },
          ports: [{ port: 80, targetPort: 8080 }],
          id: 'regionalService',
        });

        // --- includeWhen: monitoring config only if monitoring is enabled ---
        if (spec.monitoring) {
          ConfigMap({
            name: `${spec.name}-${region}-monitoring`,
            data: {
              region,
              metricsEnabled: 'true',
              environment: spec.environment,
            },
            id: 'monitoringConfig',
          });
        }

        // --- readyWhen: each regional deployment must have ready replicas ---

        dep.withReadyWhen(
          (self: { status: { readyReplicas: number } }) => self.status.readyReplicas > 0
        );

        return dep;
      });

      // --- includeWhen: ingress only if enabled ---
      if (spec.ingress.enabled) {
        Ingress({
          name: `${spec.name}-ingress`,
          rules: [
            {
              host: spec.ingress.hostname,
              http: {
                paths: [
                  {
                    path: '/',
                    pathType: 'Prefix',
                    backend: {
                      service: {
                        name: `${spec.name}-frontend-svc`,
                        port: { number: 80 },
                      },
                    },
                  },
                ],
              },
            },
          ],
          id: 'frontendIngress',
        });
      }

      // --- Status with collection aggregates ---
      return {
        totalDeployments: deployments.length,
        allRegionsReady: deployments.every((d) => d.status.readyReplicas > 0),
        anyRegionReady: deployments.some((d) => d.status.readyReplicas > 0),
        readyCount: deployments.filter((d) => d.status.readyReplicas > 0).length,
        regionList: deployments.map((d) => d.metadata.name).join(', '),
        phase: (deployments.every((d) => d.status.readyReplicas > 0)
          ? 'Ready'
          : deployments.some((d) => d.status.readyReplicas > 0)
            ? 'Degraded'
            : 'Deploying') as 'Pending' | 'Deploying' | 'Ready' | 'Degraded',
      };
    }
  );
}

// =============================================================================
// Tests
// =============================================================================

describe.skip('Kro v0.8.x Comprehensive Composition', () => {
  // ===========================================================================
  // Kro Mode — YAML Serialization
  // ===========================================================================

  describe('Kro Mode — YAML Serialization', () => {
    it('composition creates without error', () => {
      const stack = createPlatformStack();
      expect(stack).toBeDefined();
    });

    it('produces valid YAML', () => {
      const stack = createPlatformStack();
      const yamlStr = stack.toYaml();
      expect(yamlStr).toBeDefined();
      expect(yamlStr.length).toBeGreaterThan(0);

      // Should parse without error
      const parsed = parseRgdYaml(yamlStr);
      expect(parsed).toBeDefined();
    });

    it('schema has custom group', () => {
      const stack = createPlatformStack();
      const parsed = parseRgdYaml(stack.toYaml());
      const spec = parsed.spec as Record<string, unknown>;
      const schema = spec.schema as Record<string, unknown>;
      expect(schema.group).toBe('platform.example.com');
    });

    it('schema has correct kind', () => {
      const stack = createPlatformStack();
      const parsed = parseRgdYaml(stack.toYaml());
      const spec = parsed.spec as Record<string, unknown>;
      const schema = spec.schema as Record<string, unknown>;
      expect(schema.kind).toBe('PlatformStack');
    });

    // --- forEach assertions ---

    it('regional deployment has forEach directive', () => {
      const stack = createPlatformStack();
      const parsed = parseRgdYaml(stack.toYaml());
      const dep = findResource(parsed, 'regionalDeployment');

      expect(dep).toBeDefined();
      expect(dep!.forEach).toBeDefined();
      // forEach should reference schema.spec.regions
      const forEach = dep!.forEach as Record<string, string>[];
      const firstDimension = forEach[0];
      expect(firstDimension).toBeDefined();
      // The variable should iterate over the regions array
      const iterExpr = Object.values(firstDimension!)[0];
      expect(iterExpr).toContain('schema.spec.regions');
    });

    it('regional service also has forEach directive', () => {
      const stack = createPlatformStack();
      const parsed = parseRgdYaml(stack.toYaml());
      const svc = findResource(parsed, 'regionalService');

      expect(svc).toBeDefined();
      expect(svc!.forEach).toBeDefined();
    });

    // --- includeWhen assertions ---

    it('monitoring config has includeWhen for monitoring flag', () => {
      const stack = createPlatformStack();
      const parsed = parseRgdYaml(stack.toYaml());
      const mon = findResource(parsed, 'monitoringConfig');

      expect(mon).toBeDefined();
      expect(mon!.includeWhen).toBeDefined();
      const includeWhen = mon!.includeWhen as string[];
      // Should reference schema.spec.monitoring
      expect(includeWhen.some((expr) => expr.includes('schema.spec.monitoring'))).toBe(true);
    });

    it('ingress has includeWhen for ingress.enabled', () => {
      const stack = createPlatformStack();
      const parsed = parseRgdYaml(stack.toYaml());
      const ingress = findResource(parsed, 'frontendIngress');

      expect(ingress).toBeDefined();
      expect(ingress!.includeWhen).toBeDefined();
      const includeWhen = ingress!.includeWhen as string[];
      expect(includeWhen.some((expr) => expr.includes('schema.spec.ingress.enabled'))).toBe(true);
    });

    // --- readyWhen assertions ---

    it('regional deployment has readyWhen with each keyword', () => {
      const stack = createPlatformStack();
      const parsed = parseRgdYaml(stack.toYaml());
      const dep = findResource(parsed, 'regionalDeployment');

      expect(dep).toBeDefined();
      expect(dep!.readyWhen).toBeDefined();
      const readyWhen = dep!.readyWhen as string[];
      // Collections use 'each' keyword for readyWhen
      expect(readyWhen[0]).toContain('each.status.readyReplicas > 0');
    });

    // --- externalRef assertions ---

    it('platform config is serialized as externalRef, not template', () => {
      const stack = createPlatformStack();
      const parsed = parseRgdYaml(stack.toYaml());
      const spec = parsed.spec as Record<string, unknown>;
      const resources = spec.resources as Record<string, unknown>[];

      const extRefResource = resources.find((r) => r.externalRef !== undefined);
      expect(extRefResource).toBeDefined();
      expect(extRefResource!.template).toBeUndefined();

      const extRef = extRefResource!.externalRef as Record<string, unknown>;
      expect(extRef.apiVersion).toBe('v1');
      expect(extRef.kind).toBe('ConfigMap');
    });

    // --- Collection aggregate assertions in status ---

    it('status totalDeployments uses size() CEL', () => {
      const stack = createPlatformStack();
      const yamlStr = stack.toYaml();
      // .length → size() in CEL
      expect(yamlStr).toContain('size(regionalDeployment)');
    });

    it('status allRegionsReady uses .all() CEL', () => {
      const stack = createPlatformStack();
      const yamlStr = stack.toYaml();
      expect(yamlStr).toContain('regionalDeployment.all(');
    });

    it('status anyRegionReady uses .exists() CEL', () => {
      const stack = createPlatformStack();
      const yamlStr = stack.toYaml();
      expect(yamlStr).toContain('regionalDeployment.exists(');
    });

    it('status readyCount uses size(.filter()) CEL', () => {
      const stack = createPlatformStack();
      const yamlStr = stack.toYaml();
      expect(yamlStr).toContain('size(regionalDeployment.filter(');
    });

    it('status regionList uses .map().join() CEL', () => {
      const stack = createPlatformStack();
      const yamlStr = stack.toYaml();
      expect(yamlStr).toContain('regionalDeployment.map(');
      expect(yamlStr).toContain('.join(');
    });

    it('no CEL references use self — resource id is used', () => {
      const stack = createPlatformStack();
      const yamlStr = stack.toYaml();
      // readyWhen should use 'each' (for collections), never 'self'
      expect(yamlStr).not.toContain('self.status');
    });

    it('CEL equality uses == not ===', () => {
      const stack = createPlatformStack();
      const yamlStr = stack.toYaml();
      expect(yamlStr).not.toContain('===');
    });
  });

  // ===========================================================================
  // Direct Mode — Real Values
  // ===========================================================================

  describe('Direct Mode — Real Values', () => {
    const testSpec = {
      name: 'mystack',
      image: 'webapp:2.0',
      replicas: 3,
      regions: ['us-east-1', 'eu-west-1', 'ap-southeast-1'] as string[],
      monitoring: true,
      ingress: { enabled: true, hostname: 'mystack.example.com' },
      environment: 'production' as const,
    };

    it('creates concrete resources for each region', () => {
      const stack = createPlatformStack();
      const directYaml = toDirectYaml(stack, testSpec);

      // 3 regions → 3 Deployments
      expect(directYaml).toContain('mystack-us-east-1');
      expect(directYaml).toContain('mystack-eu-west-1');
      expect(directYaml).toContain('mystack-ap-southeast-1');
    });

    it('creates services for each region', () => {
      const stack = createPlatformStack();
      const directYaml = toDirectYaml(stack, testSpec);

      expect(directYaml).toContain('mystack-us-east-1-svc');
      expect(directYaml).toContain('mystack-eu-west-1-svc');
      expect(directYaml).toContain('mystack-ap-southeast-1-svc');
    });

    it('creates monitoring configs when monitoring=true', () => {
      const stack = createPlatformStack();
      const directYaml = toDirectYaml(stack, testSpec);

      expect(directYaml).toContain('mystack-us-east-1-monitoring');
      expect(directYaml).toContain('mystack-eu-west-1-monitoring');
      expect(directYaml).toContain('mystack-ap-southeast-1-monitoring');
    });

    it('skips monitoring configs when monitoring=false', () => {
      const stack = createPlatformStack();
      const noMonSpec = { ...testSpec, monitoring: false };
      const directYaml = toDirectYaml(stack, noMonSpec);

      expect(directYaml).not.toContain('monitoring');
      // But deployments should still exist
      expect(directYaml).toContain('mystack-us-east-1');
    });

    it('creates ingress when ingress.enabled=true', () => {
      const stack = createPlatformStack();
      const directYaml = toDirectYaml(stack, testSpec);

      expect(directYaml).toContain('mystack-ingress');
      expect(directYaml).toContain('mystack.example.com');
    });

    it('skips ingress when ingress.enabled=false', () => {
      const stack = createPlatformStack();
      const noIngressSpec = {
        ...testSpec,
        ingress: { enabled: false, hostname: '' },
      };
      const directYaml = toDirectYaml(stack, noIngressSpec);

      expect(directYaml).not.toContain('mystack-ingress');
      // Deployments still exist
      expect(directYaml).toContain('mystack-us-east-1');
    });

    it('does not deploy externalRef resource', () => {
      const stack = createPlatformStack();
      const directYaml = toDirectYaml(stack, testSpec);

      // platform-defaults ConfigMap is external — should not be deployed
      expect(directYaml).not.toContain('platform-defaults');
      expect(directYaml).not.toContain('platform-system');
    });

    it('handles empty regions array', () => {
      const stack = createPlatformStack();
      const emptySpec = { ...testSpec, regions: [] as string[] };
      const directYaml = toDirectYaml(stack, emptySpec);

      // No regional resources
      expect(directYaml).not.toContain('mystack-us');
      expect(directYaml).not.toContain('mystack-eu');
    });

    it('produces no CEL expressions in direct mode', () => {
      const stack = createPlatformStack();
      const directYaml = toDirectYaml(stack, testSpec);

      // Direct mode should have resolved values, not CEL
      expect(directYaml).not.toContain('${schema.spec');
      expect(directYaml).not.toContain('forEach');
      expect(directYaml).not.toContain('includeWhen');
      expect(directYaml).not.toContain('readyWhen');
    });

    it('resolves template literals to actual values', () => {
      const stack = createPlatformStack();
      const directYaml = toDirectYaml(stack, testSpec);

      // Template literals should be resolved
      expect(directYaml).toContain('webapp:2.0');
      expect(directYaml).toContain('replicas: 3');
    });

    it('environment values are resolved', () => {
      const stack = createPlatformStack();
      const directYaml = toDirectYaml(stack, testSpec);

      // ENV var should contain the actual value
      expect(directYaml).toContain('production');
    });
  });

  // ===========================================================================
  // Mode Parity — Same composition, both modes work
  // ===========================================================================

  describe('Mode Parity', () => {
    it('same composition produces valid output in both modes', () => {
      const stack = createPlatformStack();

      // Kro mode
      const kroYaml = stack.toYaml();
      expect(kroYaml).toBeDefined();
      expect(kroYaml.length).toBeGreaterThan(0);

      // Direct mode
      const directYaml = toDirectYaml(stack, {
        name: 'parity-test',
        image: 'app:latest',
        replicas: 2,
        regions: ['us', 'eu'],
        monitoring: true,
        ingress: { enabled: true, hostname: 'test.example.com' },
        environment: 'staging' as const,
      });
      expect(directYaml).toBeDefined();
      expect(directYaml.length).toBeGreaterThan(0);
    });

    it('Kro mode uses CEL, direct mode uses real values', () => {
      const stack = createPlatformStack();

      const kroYaml = stack.toYaml();
      // Kro mode has CEL references
      expect(kroYaml).toContain('schema.spec');

      const directYaml = toDirectYaml(stack, {
        name: 'mode-diff',
        image: 'nginx:1.25',
        replicas: 1,
        regions: ['us'],
        monitoring: false,
        ingress: { enabled: false, hostname: '' },
        environment: 'development' as const,
      });
      // Direct mode has resolved values
      expect(directYaml).toContain('mode-diff');
      expect(directYaml).toContain('nginx:1.25');
      expect(directYaml).not.toContain('schema.spec');
    });

    it('Kro YAML is RGD format, direct YAML is raw K8s manifests', () => {
      const stack = createPlatformStack();

      const kroYaml = stack.toYaml();
      const kroParsed = parseRgdYaml(kroYaml);
      // Kro RGD has apiVersion kro.run/v1alpha1
      expect(kroParsed.apiVersion).toBe('kro.run/v1alpha1');
      expect(kroParsed.kind).toBe('ResourceGraphDefinition');

      const directYaml = toDirectYaml(stack, {
        name: 'format-test',
        image: 'app:v1',
        replicas: 1,
        regions: ['us'],
        monitoring: false,
        ingress: { enabled: false, hostname: '' },
        environment: 'development' as const,
      });
      // Direct mode produces raw K8s manifests (Deployment, Service, etc.)
      expect(directYaml).toContain('kind: Deployment');
      expect(directYaml).not.toContain('ResourceGraphDefinition');
    });
  });
});
