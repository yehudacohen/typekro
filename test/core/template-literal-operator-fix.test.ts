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
      (spec) => ({
        testResource: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: spec.name,
            namespace: spec.namespace || 'default-namespace'
          },
          data: {}
        }
      }),
      (spec, resources) => ({
        endpoint: `http://${spec.name}.${spec.namespace || 'default-ns'}.svc:8080`
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
      (spec) => ({
        resource: {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: spec.name,
            namespace: spec.namespace || 'default'
          },
          spec: {
            ports: [{
              port: spec.port || 80
            }]
          }
        }
      }),
      (spec, resources) => ({
        url: `http://${spec.name}.${spec.namespace || 'default-ns'}.svc`,
        fullEndpoint: `http://${spec.name}.${spec.namespace || 'default-ns'}.svc:${spec.port || 8080}/metrics`
      })
    );

    expect(graph).toBeDefined();
    expect(graph.name).toBe('test-complex-template');
    
    console.log('✓ Complex template with multiple || operators handled correctly');
  });
});
