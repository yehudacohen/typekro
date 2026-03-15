/**
 * Tests for cross-composition status references
 *
 * Validates that CallableComposition.status works correctly for accessing
 * status fields from nested compositions within parent compositions.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { simple } from '../../src/index.js';
import { expectKubernetesRef } from '../utils/mock-factories.js';

describe('Cross-Composition Status References', () => {
  it('should allow accessing .status on CallableComposition', () => {
    // Create a nested composition
    const NestedSpec = type({
      name: 'string',
      replicas: 'number',
    });

    const NestedStatus = type({
      ready: 'boolean',
      availableReplicas: 'number',
      phase: 'string',
    });

    const nestedComposition = kubernetesComposition(
      {
        name: 'nested-composition',
        kind: 'NestedComposition',
        spec: NestedSpec,
        status: NestedStatus,
      },
      (spec) => {
        const deploy = simple.Deployment({
          name: spec.name,
          image: 'nginx:latest',
          replicas: spec.replicas,
          id: 'mainDeployment',
        });

        return {
          ready: deploy.status.readyReplicas === spec.replicas,
          availableReplicas: deploy.status.availableReplicas || 0,
          phase: deploy.status.phase || 'Pending',
        };
      }
    );

    // Verify that nestedComposition has a .status property
    expect(nestedComposition.status).toBeDefined();
    expect(typeof nestedComposition.status).toBe('object');

    // Access nested status fields
    const readyRef = nestedComposition.status.ready;
    const replicasRef = nestedComposition.status.availableReplicas;
    const phaseRef = nestedComposition.status.phase;

    // Verify these are KubernetesRef objects with correct resourceId and fieldPath
    expectKubernetesRef(readyRef, {
      resourceId: 'nested-composition',
      fieldPath: 'status.ready',
    });

    expectKubernetesRef(replicasRef, {
      resourceId: 'nested-composition',
      fieldPath: 'status.availableReplicas',
    });

    expectKubernetesRef(phaseRef, {
      resourceId: 'nested-composition',
      fieldPath: 'status.phase',
    });
  });

  it('should support nested status field access', () => {
    // Create a composition with nested status structure
    const NestedSpec = type({
      name: 'string',
    });

    const NestedStatus = type({
      components: {
        database: 'boolean',
        api: 'boolean',
        cache: 'boolean',
      },
      health: {
        overall: 'string',
        lastCheck: 'string',
      },
    });

    const nestedComposition = kubernetesComposition(
      {
        name: 'complex-app',
        kind: 'ComplexApp',
        spec: NestedSpec,
        status: NestedStatus,
      },
      (_spec) => {
        return {
          components: {
            database: true,
            api: true,
            cache: false,
          },
          health: {
            overall: 'healthy',
            lastCheck: '2025-01-01T00:00:00Z',
          },
        };
      }
    );

    // Access nested status fields
    const dbStatus = nestedComposition.status.components;
    const healthStatus = nestedComposition.status.health;

    // These should be KubernetesRef objects that support further nesting
    expectKubernetesRef(dbStatus, { fieldPath: 'status.components' });
    expectKubernetesRef(healthStatus, { fieldPath: 'status.health' });

    // Access deeply nested fields via proxy (dynamic properties not on KubernetesRefRuntime)
    const dbReady = (nestedComposition.status.components as Record<string, unknown>).database;
    const overallHealth = (nestedComposition.status.health as Record<string, unknown>).overall;

    expectKubernetesRef(dbReady, { fieldPath: 'status.components.database' });
    expectKubernetesRef(overallHealth, { fieldPath: 'status.health.overall' });
  });

  it('should work in parent composition status builders', () => {
    // Create a nested infrastructure composition
    const InfraSpec = type({
      name: 'string',
    });

    const InfraStatus = type({
      databaseReady: 'boolean',
      cacheReady: 'boolean',
      apiReady: 'boolean',
    });

    const infraComposition = kubernetesComposition(
      {
        name: 'infrastructure',
        kind: 'Infrastructure',
        spec: InfraSpec,
        status: InfraStatus,
      },
      (_spec) => {
        return {
          databaseReady: true,
          cacheReady: true,
          apiReady: false,
        };
      }
    );

    // Create a parent composition that references the nested composition's status
    const AppSpec = type({
      name: 'string',
      infraName: 'string',
    });

    const AppStatus = type({
      ready: 'boolean',
      infraReady: 'boolean',
      databaseAvailable: 'boolean',
    });

    const appComposition = kubernetesComposition(
      {
        name: 'application',
        kind: 'Application',
        spec: AppSpec,
        status: AppStatus,
      },
      (_spec) => {
        // Reference nested composition status in parent status builder
        // This is the key pattern we're testing!
        return {
          ready: infraComposition.status.databaseReady && infraComposition.status.apiReady,
          infraReady: infraComposition.status.databaseReady,
          databaseAvailable: infraComposition.status.databaseReady,
        };
      }
    );

    // Verify the app composition was created successfully
    expect(appComposition).toBeDefined();
    expect(typeof appComposition.toYaml).toBe('function');

    // The status builder captured references to infraComposition.status fields
    // These will be serialized as CEL expressions when deployed
    const yaml = appComposition.toYaml();
    expect(yaml).toContain('kind: Application');
    expect(yaml).toContain('apiVersion:');
  });

  it('should maintain correct resourceId across multiple references', () => {
    const ServiceSpec = type({ name: 'string' });
    const ServiceStatus = type({ healthy: 'boolean', port: 'number' });

    const serviceA = kubernetesComposition(
      {
        name: 'service-a',
        kind: 'ServiceA',
        spec: ServiceSpec,
        status: ServiceStatus,
      },
      (_spec) => ({ healthy: true, port: 8080 })
    );

    const serviceB = kubernetesComposition(
      {
        name: 'service-b',
        kind: 'ServiceB',
        spec: ServiceSpec,
        status: ServiceStatus,
      },
      (_spec) => ({ healthy: true, port: 8081 })
    );

    // Access status from both services
    const healthA = serviceA.status.healthy;
    const healthB = serviceB.status.healthy;

    // Verify they have different resourceIds but the same fieldPath
    expectKubernetesRef(healthA, {
      resourceId: 'service-a',
      fieldPath: 'status.healthy',
    });

    expectKubernetesRef(healthB, {
      resourceId: 'service-b',
      fieldPath: 'status.healthy',
    });

    // Verify they're distinct objects
    expect(healthA).not.toBe(healthB);
  });

  it('should handle external reference marker correctly', () => {
    const TestSpec = type({ name: 'string' });
    const TestStatus = type({ ready: 'boolean' });

    const testComposition = kubernetesComposition(
      {
        name: 'test-composition',
        kind: 'TestComposition',
        spec: TestSpec,
        status: TestStatus,
      },
      (_spec) => ({ ready: true })
    );

    const statusRef = testComposition.status.ready;

    // Should be a KubernetesRef with the __nestedComposition marker
    expectKubernetesRef(statusRef, { nestedComposition: true });
  });
});
