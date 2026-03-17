/**
 * Unit tests for the serialization pipeline:
 * - schema.ts: generateKroSchema, generateKroSchemaFromArktype
 * - validation.ts: validateResourceGraph, getDependencyOrder, visualizeDependencies
 * - yaml.ts: serializeResourceGraphToYaml
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as yaml from 'js-yaml';
import { KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import {
  generateKroSchema,
  generateKroSchemaFromArktype,
} from '../../src/core/serialization/schema.js';
import {
  getDependencyOrder,
  validateResourceGraph,
  visualizeDependencies,
} from '../../src/core/serialization/validation.js';
import { serializeResourceGraphToYaml } from '../../src/core/serialization/yaml.js';
import type { KubernetesResource } from '../../src/core/types.js';

// =============================================================================
// Helpers
// =============================================================================

/** Create a minimal KubernetesResource */
function makeResource(
  kind: string,
  name: string,
  overrides?: Partial<KubernetesResource>
): KubernetesResource {
  return {
    apiVersion: 'v1',
    kind,
    metadata: { name },
    ...overrides,
  };
}

/** Create a KubernetesRef-like object for embedding in resources */
function makeRef(resourceId: string, fieldPath: string): unknown {
  return {
    [KUBERNETES_REF_BRAND]: true,
    resourceId,
    fieldPath,
  };
}

// =============================================================================
// 1. generateKroSchema tests
// =============================================================================

describe('generateKroSchema', () => {
  test('generates schema with PascalCase kind from hyphenated name', () => {
    const schema = generateKroSchema('my-web-app', {});

    expect(schema.kind).toBe('MyWebApp');
    expect(schema.apiVersion).toBe('v1alpha1');
    expect(schema.spec).toHaveProperty('name');
    expect(schema.spec.name).toBe('string | default="my-web-app"');
  });

  test('generates schema with PascalCase kind from camelCase name', () => {
    const schema = generateKroSchema('myWebApp', {});

    // pascalCase treats 'myWebApp' as a single token — capitalizes first letter only
    expect(schema.kind).toBe('Mywebapp');
  });

  test('generates schema with simple name', () => {
    const schema = generateKroSchema('database', {});

    expect(schema.kind).toBe('Database');
    expect(schema.spec.name).toBe('string | default="database"');
  });

  test('always produces empty status object', () => {
    const schema = generateKroSchema('test', {});

    expect(schema.status).toBeDefined();
    expect(Object.keys(schema.status!)).toHaveLength(0);
  });

  test('ignores the resources parameter', () => {
    const withResources = generateKroSchema('test', {
      deployment: makeResource('Deployment', 'my-app'),
      service: makeResource('Service', 'my-svc'),
    });
    const withoutResources = generateKroSchema('test', {});

    expect(withResources.spec).toEqual(withoutResources.spec);
    expect(withResources.kind).toEqual(withoutResources.kind);
  });
});

// =============================================================================
// 2. generateKroSchemaFromArktype tests
// =============================================================================

describe('generateKroSchemaFromArktype', () => {
  test('generates schema from arktype spec and status', () => {
    const schema = generateKroSchemaFromArktype('my-app', {
      apiVersion: 'example.com/v1alpha1',
      kind: 'MyApp',
      spec: type({ name: 'string', replicas: 'number' }),
      status: type({ ready: 'boolean' }),
    });

    expect(schema.kind).toBeDefined();
    expect(schema.apiVersion).toBeDefined();
    expect(schema.spec).toBeDefined();
  });

  test('passes through to arktypeToKroSchema with optional resources', () => {
    const resources = { svc: makeResource('Service', 'svc') };
    const schema = generateKroSchemaFromArktype(
      'test',
      {
        apiVersion: 'v1alpha1',
        kind: 'Test',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      resources
    );

    // Should produce a valid schema regardless of resources
    expect(schema.kind).toBeDefined();
  });
});

// =============================================================================
// 3. validateResourceGraph tests
// =============================================================================

describe('validateResourceGraph', () => {
  test('empty resource graph is valid', () => {
    const result = validateResourceGraph({});

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('single resource with no references is valid', () => {
    const result = validateResourceGraph({
      deployment: makeResource('Deployment', 'my-app'),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('multiple independent resources are valid', () => {
    const result = validateResourceGraph({
      deployment: makeResource('Deployment', 'app'),
      service: makeResource('Service', 'svc'),
      configmap: makeResource('ConfigMap', 'cfg'),
    });

    expect(result.valid).toBe(true);
  });

  test('detects missing dependency reference', () => {
    // Resource with a KubernetesRef pointing to a non-existent resource
    const resource = makeResource('Deployment', 'my-app', {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'app',
                image: makeRef('nonExistentResource', 'status.host'),
              },
            ],
          },
        },
      },
    });

    const result = validateResourceGraph({ deployment: resource });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('nonExistentResource'))).toBe(true);
  });

  test('valid cross-references between resources pass', () => {
    // Two resources with embedded IDs that reference each other correctly
    const service = {
      ...makeResource('Service', 'my-svc'),
      __resourceId: 'serviceMyService',
    };
    const deployment = {
      ...makeResource('Deployment', 'my-app', {
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: 'app',
                  env: [
                    {
                      name: 'SERVICE_HOST',
                      value: makeRef('serviceMyService', 'spec.clusterIP'),
                    },
                  ],
                },
              ],
            },
          },
        },
      }),
      __resourceId: 'deploymentMyApp',
    };

    const result = validateResourceGraph({
      service: service as unknown as KubernetesResource,
      deployment: deployment as unknown as KubernetesResource,
    });

    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// 4. getDependencyOrder tests
// =============================================================================

describe('getDependencyOrder', () => {
  test('empty resources returns empty order', () => {
    const order = getDependencyOrder({});

    expect(order).toHaveLength(0);
  });

  test('single resource returns that resource', () => {
    const order = getDependencyOrder({
      deployment: makeResource('Deployment', 'app'),
    });

    expect(order).toHaveLength(1);
    expect(order).toContain('deployment');
  });

  test('independent resources all appear in order', () => {
    const order = getDependencyOrder({
      a: makeResource('Deployment', 'a'),
      b: makeResource('Service', 'b'),
      c: makeResource('ConfigMap', 'c'),
    });

    expect(order).toHaveLength(3);
    expect(order).toContain('a');
    expect(order).toContain('b');
    expect(order).toContain('c');
  });
});

// =============================================================================
// 5. visualizeDependencies tests
// =============================================================================

describe('visualizeDependencies', () => {
  test('produces header for empty resources', () => {
    const output = visualizeDependencies({});

    expect(output).toContain('Resource Dependency Graph:');
    expect(output).toContain('========================');
    expect(output).toContain('Deployment Order:');
  });

  test('shows resources with no dependencies', () => {
    const output = visualizeDependencies({
      myService: makeResource('Service', 'svc'),
    });

    expect(output).toContain('myService');
    expect(output).toContain('no dependencies');
  });

  test('shows deployment order', () => {
    const output = visualizeDependencies({
      a: makeResource('Deployment', 'a'),
      b: makeResource('Service', 'b'),
    });

    expect(output).toContain('Deployment Order:');
    // Should list both resources in the order section
    expect(output).toContain('1.');
    expect(output).toContain('2.');
  });
});

// =============================================================================
// 6. serializeResourceGraphToYaml tests
// =============================================================================

describe('serializeResourceGraphToYaml', () => {
  test('produces valid YAML with correct structure', () => {
    const yamlStr = serializeResourceGraphToYaml('test-app', {
      deployment: makeResource('Deployment', 'my-app'),
    });

    const parsed = yaml.load(yamlStr) as Record<string, unknown>;

    expect(parsed.apiVersion).toBe('kro.run/v1alpha1');
    expect(parsed.kind).toBe('ResourceGraphDefinition');
    expect((parsed.metadata as Record<string, unknown>).name).toBe('test-app');
  });

  test('defaults namespace to "default"', () => {
    const yamlStr = serializeResourceGraphToYaml('test', {
      svc: makeResource('Service', 'svc'),
    });

    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    expect((parsed.metadata as Record<string, unknown>).namespace).toBe('default');
  });

  test('uses custom namespace from options', () => {
    const yamlStr = serializeResourceGraphToYaml(
      'test',
      { svc: makeResource('Service', 'svc') },
      { namespace: 'production' }
    );

    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    expect((parsed.metadata as Record<string, unknown>).namespace).toBe('production');
  });

  test('produces empty resources array for empty input', () => {
    const yamlStr = serializeResourceGraphToYaml('empty', {});

    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const spec = parsed.spec as Record<string, unknown>;
    expect(spec.resources).toEqual([]);
  });

  test('generates schema when no custom schema provided', () => {
    const yamlStr = serializeResourceGraphToYaml('my-app', {
      deployment: makeResource('Deployment', 'app'),
    });

    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const spec = parsed.spec as Record<string, unknown>;
    const schema = spec.schema as Record<string, unknown>;

    // Auto-generated schema should have PascalCase kind
    expect(schema.kind).toBe('MyApp');
    expect(schema.apiVersion).toBe('v1alpha1');
  });

  test('uses custom schema when provided', () => {
    const customSchema = {
      apiVersion: 'custom/v1',
      kind: 'CustomKind',
      spec: { port: 'integer' },
      status: { ready: 'boolean' },
    };

    const yamlStr = serializeResourceGraphToYaml(
      'test',
      { svc: makeResource('Service', 'svc') },
      undefined,
      customSchema
    );

    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const spec = parsed.spec as Record<string, unknown>;
    const schema = spec.schema as Record<string, unknown>;

    expect(schema.kind).toBe('CustomKind');
    expect(schema.apiVersion).toBe('custom/v1');
  });

  test('resource templates include kind and metadata', () => {
    const yamlStr = serializeResourceGraphToYaml('test', {
      deployment: makeResource('Deployment', 'my-app'),
    });

    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const spec = parsed.spec as Record<string, unknown>;
    const resources = spec.resources as Record<string, unknown>[];

    expect(resources).toHaveLength(1);
    expect(resources[0]).toHaveProperty('id');
    expect(resources[0]).toHaveProperty('template');

    const template = resources[0]!.template as Record<string, unknown>;
    expect(template.kind).toBe('Deployment');
    expect((template.metadata as Record<string, unknown>).name).toBe('my-app');
  });

  test('multiple resources produce multiple entries', () => {
    const yamlStr = serializeResourceGraphToYaml('test', {
      deployment: makeResource('Deployment', 'app'),
      service: makeResource('Service', 'svc'),
      configmap: makeResource('ConfigMap', 'cfg'),
    });

    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const spec = parsed.spec as Record<string, unknown>;
    const resources = spec.resources as Record<string, unknown>[];

    expect(resources).toHaveLength(3);
  });

  test('resource with embedded __resourceId uses that ID', () => {
    const resource = {
      ...makeResource('Deployment', 'my-app'),
      __resourceId: 'customDeploymentId',
    };

    const yamlStr = serializeResourceGraphToYaml('test', {
      deployment: resource as unknown as KubernetesResource,
    });

    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const spec = parsed.spec as Record<string, unknown>;
    const resources = spec.resources as Record<string, unknown>[];

    expect(resources[0]!.id).toBe('customDeploymentId');
  });

  test('resource without kind falls back to Resource', () => {
    const resource: KubernetesResource = {
      apiVersion: 'v1',
      kind: '', // empty kind
      metadata: { name: 'test' },
    };

    // Should not throw — falls back to 'Resource' for ID generation
    const yamlStr = serializeResourceGraphToYaml('test', { item: resource });
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;

    expect(parsed).toBeDefined();
  });

  test('YAML output is deterministic for same input', () => {
    const resources = {
      deployment: makeResource('Deployment', 'app'),
      service: makeResource('Service', 'svc'),
    };

    const yaml1 = serializeResourceGraphToYaml('test', resources);
    const yaml2 = serializeResourceGraphToYaml('test', resources);

    expect(yaml1).toBe(yaml2);
  });
});
