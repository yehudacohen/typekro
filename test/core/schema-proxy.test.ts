/**
 * Tests for Schema Proxy Factory
 *
 * This test file validates that the createSchemaProxy function works correctly
 * and creates proper KubernetesRef objects for schema field access.
 */

import { describe, expect, it } from 'bun:test';
import { KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import type { KubernetesRef } from '../../src/index';
import { createSchemaProxy, isSchemaReference } from '../../src/index';
import { isKubernetesRef } from '../../src/utils/type-guards.js';

describe('Schema Proxy Factory', () => {
  // Define test types - must be compatible with KroCompatibleType
  interface TestSpec {
    name: string;
    replicas: number;
    config: {
      database: string;
      cache: boolean;
      [key: string]: string | number | boolean | Record<string, any> | any[];
    };
    [key: string]: string | number | boolean | Record<string, any> | any[];
  }

  interface TestStatus {
    ready: boolean;
    url: string;
    conditions: {
      healthy: boolean;
      deployed: boolean;
      [key: string]: string | number | boolean | Record<string, any> | any[];
    };
    [key: string]: string | number | boolean | Record<string, any> | any[];
  }

  describe('createSchemaProxy', () => {
    it('should create schema proxy with spec and status properties', () => {
      const schema = createSchemaProxy<TestSpec, TestStatus>();

      expect(schema.spec).toBeDefined();
      expect(schema.status).toBeDefined();
    });

    it('should return KubernetesRef objects for spec field access', () => {
      const schema = createSchemaProxy<TestSpec, TestStatus>();

      const nameRef = schema.spec.name;
      const replicasRef = schema.spec.replicas;

      // Should be KubernetesRef objects
      expect(isKubernetesRef(nameRef)).toBe(true);
      expect(nameRef).toHaveProperty('resourceId', '__schema__');
      expect(nameRef).toHaveProperty('fieldPath', 'spec.name');

      expect(isKubernetesRef(replicasRef)).toBe(true);
      expect(replicasRef).toHaveProperty('resourceId', '__schema__');
      expect(replicasRef).toHaveProperty('fieldPath', 'spec.replicas');
    });

    it('should return KubernetesRef objects for status field access', () => {
      const schema = createSchemaProxy<TestSpec, TestStatus>();

      const readyRef = schema.status.ready;
      const urlRef = schema.status.url;

      // Should be KubernetesRef objects
      expect(isKubernetesRef(readyRef)).toBe(true);
      expect(readyRef).toHaveProperty('resourceId', '__schema__');
      expect(readyRef).toHaveProperty('fieldPath', 'status.ready');

      expect(isKubernetesRef(urlRef)).toBe(true);
      expect(urlRef).toHaveProperty('resourceId', '__schema__');
      expect(urlRef).toHaveProperty('fieldPath', 'status.url');
    });

    it('should support nested field access', () => {
      const schema = createSchemaProxy<TestSpec, TestStatus>();

      const databaseRef = schema.spec.config.database;
      const healthyRef = schema.status.conditions.healthy;

      // Should create proper nested field paths
      expect(databaseRef).toHaveProperty('fieldPath', 'spec.config.database');
      expect(healthyRef).toHaveProperty('fieldPath', 'status.conditions.healthy');

      // Should still be schema references
      expect(databaseRef).toHaveProperty('resourceId', '__schema__');
      expect(healthyRef).toHaveProperty('resourceId', '__schema__');
    });

    it('should support deep nested field access', () => {
      const schema = createSchemaProxy<TestSpec, TestStatus>();

      // Access deeply nested properties that don't exist in the type
      const deepRef = (schema.spec as any).some.very.deep.nested.property;

      expect(isKubernetesRef(deepRef)).toBe(true);
      expect(deepRef).toHaveProperty('resourceId', '__schema__');
      expect(deepRef).toHaveProperty('fieldPath', 'spec.some.very.deep.nested.property');
    });
  });

  describe('isSchemaReference', () => {
    it('should identify schema references correctly', () => {
      const schema = createSchemaProxy<TestSpec, TestStatus>();

      const nameRef = schema.spec.name;
      const readyRef = schema.status.ready;

      expect(isSchemaReference(nameRef as any)).toBe(true);
      expect(isSchemaReference(readyRef as any)).toBe(true);
    });

    it('should distinguish schema references from external references', () => {
      const schema = createSchemaProxy<TestSpec, TestStatus>();
      const schemaRef = schema.spec.name;

      // Create a mock external reference (like what externalRef would create)
      const externalRef = {
        [KUBERNETES_REF_BRAND]: true as const,
        resourceId: 'some-external-resource-id',
        fieldPath: 'status.someField',
      } as KubernetesRef<any>;

      expect(isSchemaReference(schemaRef as any)).toBe(true);
      expect(isSchemaReference(externalRef)).toBe(false);
    });
  });

  describe('Type Safety', () => {
    it('should provide type-safe access to known properties', () => {
      const schema = createSchemaProxy<TestSpec, TestStatus>();

      // These should be accessible without TypeScript errors
      const nameRef = schema.spec.name;
      const replicasRef = schema.spec.replicas;
      const readyRef = schema.status.ready;
      const urlRef = schema.status.url;

      expect(nameRef).toBeDefined();
      expect(replicasRef).toBeDefined();
      expect(readyRef).toBeDefined();
      expect(urlRef).toBeDefined();
    });

    it('should allow access to any string property (MagicProxy behavior)', () => {
      const schema = createSchemaProxy<TestSpec, TestStatus>();

      // Should be able to access properties not in the type definition
      const unknownSpecRef = (schema.spec as any).unknownProperty;
      const unknownStatusRef = (schema.status as any).anotherUnknownProperty;

      expect(isKubernetesRef(unknownSpecRef)).toBe(true);
      expect(unknownSpecRef).toHaveProperty('fieldPath', 'spec.unknownProperty');

      expect(isKubernetesRef(unknownStatusRef)).toBe(true);
      expect(unknownStatusRef).toHaveProperty('fieldPath', 'status.anotherUnknownProperty');
    });
  });

  describe('Integration with Existing System', () => {
    it('should create references compatible with existing KubernetesRef interface', () => {
      const schema = createSchemaProxy<TestSpec, TestStatus>();
      const ref = schema.spec.name;

      // Should have all required KubernetesRef properties
      expect(isKubernetesRef(ref)).toBe(true);
      expect(ref).toHaveProperty('resourceId');
      expect(ref).toHaveProperty('fieldPath');

      // Should be a function (proxy target)
      expect(typeof ref).toBe('function');
    });

    it('should work with existing utility functions', () => {
      const schema = createSchemaProxy<TestSpec, TestStatus>();
      const ref = schema.spec.name;

      // Should be identifiable as a schema reference
      expect(isSchemaReference(ref as any)).toBe(true);

      // Should have the correct structure for serialization
      expect((ref as any).resourceId).toBe('__schema__');
      expect((ref as any).fieldPath).toBe('spec.name');
    });
  });
});
