/**
 * Tests for ResourceGraphDefinition metadata validation
 * 
 * This test suite verifies that RGDs are created with valid metadata.name fields
 * and that invalid names are rejected early with clear error messages.
 */

import { describe, it, expect } from 'bun:test';
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment } from '../../src/index.js';

describe('RGD Metadata Validation', () => {
  const TestSchema = type({ name: 'string' });

  const createTestGraph = (name: any) => {
    return toResourceGraph(
      {
        name,
        apiVersion: 'v1alpha1',
        kind: 'TestApp',
        spec: TestSchema,
        status: TestSchema,
      },
      (schema) => ({
        deployment: simpleDeployment({
          id: 'testDeployment',
          name: schema.spec.name,
          image: 'nginx:latest',
          replicas: 1,
        }),
      }),
      () => ({ name: 'test' })
    );
  };

  describe('Invalid Names', () => {
    it('should reject empty string names', () => {
      expect(() => createTestGraph('')).toThrow(
        'Invalid resource graph name: "". Resource graph name must be a non-empty string.'
      );
    });

    it('should reject undefined names', () => {
      expect(() => createTestGraph(undefined)).toThrow(
        'Invalid resource graph name: undefined. Resource graph name must be a non-empty string.'
      );
    });

    it('should reject null names', () => {
      expect(() => createTestGraph(null)).toThrow(
        'Invalid resource graph name: null. Resource graph name must be a non-empty string.'
      );
    });

    it('should reject whitespace-only names', () => {
      expect(() => createTestGraph('   ')).toThrow(
        'Invalid resource graph name: Resource graph name cannot be empty or whitespace-only.'
      );
    });

    it('should reject names starting with dash', () => {
      expect(() => createTestGraph('-invalid')).toThrow(
        'Invalid resource graph name: "-invalid" converts to "-invalid" which is not a valid Kubernetes resource name'
      );
    });

    it('should reject names ending with dash', () => {
      expect(() => createTestGraph('invalid-')).toThrow(
        'Invalid resource graph name: "invalid-" converts to "invalid-" which is not a valid Kubernetes resource name'
      );
    });

    it('should reject names with underscores', () => {
      expect(() => createTestGraph('invalid_name')).toThrow(
        'Invalid resource graph name: "invalid_name" converts to "invalid_name" which is not a valid Kubernetes resource name'
      );
    });

    it('should reject names with special characters', () => {
      expect(() => createTestGraph('invalid@name')).toThrow(
        'Invalid resource graph name: "invalid@name" converts to "invalid@name" which is not a valid Kubernetes resource name'
      );
    });

    it('should reject names that are too long', () => {
      const longName = 'a'.repeat(300);
      expect(() => createTestGraph(longName)).toThrow(
        'which exceeds the 253 character limit for Kubernetes resource names'
      );
    });
  });

  describe('Valid Names', () => {
    it('should accept simple valid names', async () => {
      const graph = createTestGraph('valid');
      expect(graph.name).toBe('valid');
      
      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory.name).toBe('valid');
      expect(factory.rgdName).toBe('valid');
    });

    it('should accept names with dashes and numbers', async () => {
      const graph = createTestGraph('valid-name-123');
      expect(graph.name).toBe('valid-name-123');
      
      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory.name).toBe('valid-name-123');
      expect(factory.rgdName).toBe('valid-name-123');
    });

    it('should convert camelCase names to kebab-case', async () => {
      const graph = createTestGraph('validCamelCase');
      expect(graph.name).toBe('validCamelCase');
      
      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory.name).toBe('validCamelCase');
      expect(factory.rgdName).toBe('valid-camel-case');
    });

    it('should handle mixed case names correctly', async () => {
      const graph = createTestGraph('MyAppName');
      expect(graph.name).toBe('MyAppName');
      
      const factory = await graph.factory('kro', { namespace: 'test' });
      expect(factory.name).toBe('MyAppName');
      expect(factory.rgdName).toBe('my-app-name');
    });
  });

  describe('RGD YAML Generation', () => {
    it('should generate RGD YAML with proper metadata.name', async () => {
      const graph = createTestGraph('test-app');
      const factory = await graph.factory('kro', { namespace: 'test-namespace' });
      
      const yaml = factory.toYaml();
      
      // Verify the YAML contains proper metadata
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('name: test-app');
      expect(yaml).toContain('namespace: test-namespace');
    });

    it('should generate RGD YAML with converted camelCase names', async () => {
      const graph = createTestGraph('testAppName');
      const factory = await graph.factory('kro', { namespace: 'test-namespace' });
      
      const yaml = factory.toYaml();
      
      // Verify the YAML contains the converted name
      expect(yaml).toContain('name: test-app-name');
      expect(yaml).toContain('namespace: test-namespace');
    });
  });

  describe('Error Prevention', () => {
    it('should prevent HTTP 422 errors by validating names early', () => {
      // These are the exact scenarios that would cause HTTP 422 errors
      const invalidNames = ['', null, undefined, '   ', '-invalid', 'invalid-'];
      
      for (const invalidName of invalidNames) {
        expect(() => createTestGraph(invalidName)).toThrow();
      }
    });

    it('should provide actionable error messages', () => {
      try {
        createTestGraph('invalid_name');
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect((error as Error).message).toContain('invalid_name');
        expect((error as Error).message).toContain('not a valid Kubernetes resource name');
        expect((error as Error).message).toContain('lowercase alphanumeric characters or \'-\'');
      }
    });
  });
});