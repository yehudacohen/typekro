import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { toResourceGraph } from '../../../src/core/serialization/index.js';
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
    expect((graph.resources[0] as any).spec.values).toBeDefined();
    expect((graph.resources[0] as any).spec.values.replicaCount).toBeDefined();
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
    expect((graph.resources[0] as any).spec.values.config).toBeDefined();
    expect((graph.resources[0] as any).spec.values.metadata).toBeDefined();
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
    expect((graph.resources[0] as any).spec.values).toBeDefined();
  });
});
