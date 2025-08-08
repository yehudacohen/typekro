/**
 * Tests for Schema Proxy Types and Builder Function Support
 *
 * This test file validates that the new types added for the Kro Factory Pattern
 * compile correctly and provide proper type safety.
 */

import { describe, expect, it } from 'bun:test';
import type {
  Enhanced,
  ResourceBuilder,
  SchemaProxy,
  TypedKroResourceGraphDefinition,
  TypedResourceGraphFactory,
} from '../../src/core.js';
import { pod } from '../../src/factories/index.js';

// Test interfaces for validation - must be compatible with KroCompatibleType
interface TestSpec {
  name: string;
  replicas: number;
  [key: string]: string | number | boolean | Record<string, any> | any[];
}

interface TestStatus {
  ready: boolean;
  url: string;
  [key: string]: string | number | boolean | Record<string, any> | any[];
}

describe('Schema Proxy Types', () => {
  it('should define SchemaProxy with proper structure', () => {
    // This test validates that SchemaProxy type compiles correctly
    const validateSchemaProxy = (proxy: SchemaProxy<TestSpec, TestStatus>) => {
      // Should have spec and status properties that are MagicProxy types
      // These should be accessible without type errors
      expect(proxy.spec).toBeDefined();
      expect(proxy.status).toBeDefined();
    };

    // This function should compile without errors
    expect(validateSchemaProxy).toBeDefined();
  });

  it('should define ResourceBuilder with correct function signature', () => {
    // This test validates that ResourceBuilder type compiles correctly
    const validateBuilder: ResourceBuilder<TestSpec, TestStatus> = (schema) => {
      // Schema should have the correct structure - verify it's accessible
      expect(schema.spec).toBeDefined();
      expect(schema.status).toBeDefined();

      // Should return a record of Enhanced resources
      return {
        testResource: pod({
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'test' },
          spec: {
            containers: [{
              name: 'test',
              image: 'nginx',
            }],
          },
        }),
      };
    };

    expect(validateBuilder).toBeDefined();
  });

  it('should define TypedResourceGraphFactory with all required methods', () => {
    // This test validates that TypedResourceGraphFactory interface compiles correctly
    const validateFactory = (factory: TypedResourceGraphFactory<TestSpec, TestStatus>) => {
      // Should have all required methods and properties
      expect(factory.getInstance).toBeDefined();
      expect(factory.toYaml).toBeDefined();
      expect(factory.schema).toBeDefined();
      expect(factory.definition).toBeDefined();
    };

    expect(validateFactory).toBeDefined();
  });

  it('should define TypedKroResourceGraphDefinition extending base definition', () => {
    // This test validates that TypedKroResourceGraphDefinition compiles correctly
    const validateDefinition = (def: TypedKroResourceGraphDefinition<TestSpec, TestStatus>) => {
      // Should have all base properties
      expect(def.apiVersion).toBe('kro.run/v1alpha1');
      expect(def.kind).toBe('ResourceGraphDefinition');
      expect(def.metadata).toBeDefined();
      expect(def.spec).toBeDefined();

      // Should have typed schema
      expect(def.spec.schema.spec).toBeDefined();
      expect(def.spec.schema.status).toBeDefined();
    };

    // Create a mock definition for testing
    const mockDefinition: TypedKroResourceGraphDefinition<TestSpec, TestStatus> = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: 'test' },
      spec: {
        schema: {
          apiVersion: 'v1alpha1',
          kind: 'Test',
          spec: { name: 'string', replicas: 'number' }, // Use string values for KroSimpleSchema
          status: { ready: 'boolean', url: 'string' }, // Use string values for KroSimpleSchema
          _typedSpec: { name: 'test', replicas: 1 } as TestSpec,
          _typedStatus: { ready: true, url: 'http://test' } as TestStatus,
        },
        resources: [],
      },
    };

    validateDefinition(mockDefinition);
  });
});

describe('Type Safety Validation', () => {
  it('should enforce type safety in ResourceBuilder function', () => {
    // This test validates that the types provide proper type safety
    const typeSafeBuilder: ResourceBuilder<TestSpec, TestStatus> = (schema) => {
      // These should be type-safe accesses
      const nameRef = schema.spec.name; // Should be KubernetesRef<string>
      const replicasRef = schema.spec.replicas; // Should be KubernetesRef<number>
      const readyRef = schema.status.ready; // Should be KubernetesRef<boolean>
      const urlRef = schema.status.url; // Should be KubernetesRef<string>

      // All should be defined (they're KubernetesRef objects)
      expect(nameRef).toBeDefined();
      expect(replicasRef).toBeDefined();
      expect(readyRef).toBeDefined();
      expect(urlRef).toBeDefined();

      return {
        testResource: pod({
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'test' },
          spec: {
            containers: [{
              name: 'test',
              image: 'nginx',
            }],
          },
        }),
      };
    };

    expect(typeSafeBuilder).toBeDefined();
  });

  it('should support Enhanced type in ResourceBuilder return', () => {
    // This test validates that ResourceBuilder can return Enhanced types
    const builderWithEnhanced: ResourceBuilder<TestSpec, TestStatus> = (_schema) => {
      // Mock Enhanced resource
      const enhancedResource = {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'test' },
        spec: {} as any,
        status: {} as any,
      } as Enhanced<any, any>;

      return {
        testResource: enhancedResource,
      };
    };

    expect(builderWithEnhanced).toBeDefined();
  });
});
