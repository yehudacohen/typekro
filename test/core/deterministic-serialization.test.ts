import { describe, expect, it } from 'bun:test';
import { Cel } from '../../src';
import { simpleDeployment, toResourceGraph } from '../../src/core.js';

describe('Deterministic Serialization', () => {
  it('should generate consistent YAML with deterministic resource IDs', async () => {
    const webapp1 = simpleDeployment({
      name: 'web-app',
      image: 'nginx:latest',
    });

    const webapp2 = simpleDeployment({
      name: 'web-app',
      image: 'nginx:latest',
    });

    const { type } = await import('arktype');
    const TestSchema = type({ name: 'string' });
    const resourceGraph1 = toResourceGraph(
      {
        name: 'test-stack',
        apiVersion: 'test.com/v1',
        kind: 'TestResource',
        spec: TestSchema,
        status: TestSchema,
      },
      () => ({ webapp: webapp1 }),
      () => ({ name: 'test-status' })
    );
    const resourceGraph2 = toResourceGraph(
      {
        name: 'test-stack',
        apiVersion: 'test.com/v1',
        kind: 'TestResource',
        spec: TestSchema,
        status: TestSchema,
      },
      () => ({ webapp: webapp2 }),
      () => ({ name: 'test-status' })
    );
    const yaml1 = resourceGraph1.toYaml();
    const yaml2 = resourceGraph2.toYaml();

    // Both YAML outputs should be identical
    expect(yaml1).toBe(yaml2);

    // Should contain the deterministic ID
    expect(yaml1).toContain('id: deploymentWebApp');
  });

  it('should handle different namespaces in deterministic IDs', async () => {
    const defaultApp = simpleDeployment({
      name: 'web-app',
      image: 'nginx:latest',
    });

    const prodApp = simpleDeployment({
      name: 'web-app',
      image: 'nginx:latest',
      namespace: 'production',
    });

    const { type } = await import('arktype');
    const TestSchema = type({ name: 'string' });
    const defaultResourceGraph = toResourceGraph(
      {
        name: 'test-stack',
        apiVersion: 'test.com/v1',
        kind: 'TestResource',
        spec: TestSchema,
        status: TestSchema,
      },
      () => ({ webapp: defaultApp }),
      () => ({ name: 'test-status' })
    );
    const prodResourceGraph = toResourceGraph(
      {
        name: 'test-stack',
        apiVersion: 'test.com/v1',
        kind: 'TestResource',
        spec: TestSchema,
        status: TestSchema,
      },
      () => ({ webapp: prodApp }),
      () => ({ name: 'test-status' })
    );
    const defaultYaml = defaultResourceGraph.toYaml();
    const prodYaml = prodResourceGraph.toYaml();

    expect(defaultYaml).toContain('id: deploymentWebApp');
    expect(prodYaml).toContain('id: deploymentWebApp');
    expect(defaultYaml).not.toBe(prodYaml);
  });

  it('should support explicit IDs in serialization', async () => {
    const webapp = simpleDeployment({
      name: 'web-app',
      image: 'nginx:latest',
      id: 'myCustomWebappId',
    });

    const { type } = await import('arktype');
    const TestSchema = type({ name: 'string' });
    const resourceGraph = toResourceGraph(
      {
        name: 'test-stack',
        apiVersion: 'test.com/v1',
        kind: 'TestResource',
        spec: TestSchema,
        status: TestSchema,
      },
      () => ({ webapp }),
      () => ({ name: 'test-status' })
    );
    const yaml = resourceGraph.toYaml();

    expect(yaml).toContain('id: myCustomWebappId');
    expect(yaml).not.toContain('deployment-default-web-app');
  });

  it('should maintain deterministic cross-resource references', async () => {
    const database = simpleDeployment({
      name: 'postgres',
      image: 'postgres:13',
    });

    const webapp = simpleDeployment({
      name: 'web-app',
      image: 'nginx:latest',
      env: {
        DB_READY: Cel.string(database.status?.readyReplicas),
      },
    });

    const { type } = await import('arktype');
    const TestSchema = type({ name: 'string' });
    const resourceGraph1 = toResourceGraph(
      {
        name: 'test-stack',
        apiVersion: 'test.com/v1',
        kind: 'TestResource',
        spec: TestSchema,
        status: TestSchema,
      },
      () => ({ database, webapp }),
      () => ({ name: 'test-status' })
    );
    const resourceGraph2 = toResourceGraph(
      {
        name: 'test-stack',
        apiVersion: 'test.com/v1',
        kind: 'TestResource',
        spec: TestSchema,
        status: TestSchema,
      },
      () => ({ database, webapp }),
      () => ({ name: 'test-status' })
    );
    const yaml1 = resourceGraph1.toYaml();
    const yaml2 = resourceGraph2.toYaml();

    // Both should be identical
    expect(yaml1).toBe(yaml2);

    // Should contain deterministic reference with string() wrapper
    expect(yaml1).toContain('${string(deploymentPostgres.status.readyReplicas)}');
  });
});
