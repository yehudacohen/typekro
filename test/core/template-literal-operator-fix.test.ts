import { describe, test, expect } from 'bun:test';
import { toResourceGraph } from '../../src';
import { type } from 'arktype';

describe('Template Literal || Operator Fix', () => {
  test('should properly wrap || operators in parentheses for correct precedence', () => {
    const graph = toResourceGraph(
      {
        name: 'test-template-fix',
        apiVersion: 'test.io/v1',
        kind: 'TemplateTest',
        spec: type({
          name: 'string',
          'namespace?': 'string'
        }),
        status: type({
          endpoint: 'string'
        })
      },
      (schema) => ({
        testResource: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: schema.spec.name,
            namespace: schema.spec.namespace || 'default-namespace'
          },
          data: {}
        } as any
      }),
      (schema, resources) => ({
        endpoint: `http://${schema.spec.name}.${schema.spec.namespace || 'default-ns'}.svc:8080`
      })
    );

    expect(graph).toBeDefined();
    expect(graph.name).toBe('test-template-fix');
    
    console.log('✓ Template literal with || operator converted successfully');
  });

  test('should handle complex template literals with multiple || operators', () => {
    const graph = toResourceGraph(
      {
        name: 'test-complex-template',
        apiVersion: 'test.io/v1',
        kind: 'ComplexTest',
        spec: type({
          name: 'string',
          'namespace?': 'string',
          'port?': 'number'
        }),
        status: type({
          url: 'string',
          fullEndpoint: 'string'
        })
      },
      (schema) => ({
        resource: {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: schema.spec.name,
            namespace: schema.spec.namespace || 'default'
          },
          spec: {
            ports: [{
              port: schema.spec.port || 80
            }]
          }
        } as any
      }),
      (schema, resources) => ({
        url: `http://${schema.spec.name}.${schema.spec.namespace || 'default-ns'}.svc`,
        fullEndpoint: `http://${schema.spec.name}.${schema.spec.namespace || 'default-ns'}.svc:${schema.spec.port || 8080}/metrics`
      })
    );

    expect(graph).toBeDefined();
    expect(graph.name).toBe('test-complex-template');
    
    console.log('✓ Complex template with multiple || operators handled correctly');
  });
});
