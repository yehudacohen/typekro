/**
 * Unit tests for the factory pattern interfaces and types
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import type {
  DirectResourceFactory,
  FactoryForMode,
  FactoryOptions,
  KroResourceFactory,
  ResourceFactory,
  TypedResourceGraph,
} from '../../src/core/types/deployment.js';

describe('Factory Pattern Types', () => {
  // Test schema types
  const TestSpecSchema = type({
    name: 'string',
    replicas: 'number%1',
  });

  const TestStatusSchema = type({
    ready: 'boolean',
    replicas: 'number%1',
  });

  type TestSpec = typeof TestSpecSchema.infer;
  type TestStatus = typeof TestStatusSchema.infer;

  describe('TypedResourceGraph interface', () => {
    it('should have correct structure', () => {
      // This test validates the interface structure at compile time
      const mockGraph: TypedResourceGraph<TestSpec, TestStatus> = {
        name: 'test-graph',
        resources: [],
        schema: {} as any, // Mock schema proxy

        async factory(_mode, _options) {
          // Mock implementation
          throw new Error('Not implemented');
        },

        toYaml() {
          return 'mock yaml';
        },
      };

      expect(mockGraph.name).toBe('test-graph');
      expect(mockGraph.resources).toEqual([]);
      expect(typeof mockGraph.factory).toBe('function');
      expect(typeof mockGraph.toYaml).toBe('function');
    });

    it('should support optional schema property', () => {
      // Test that schema is optional
      const mockGraphWithoutSchema: TypedResourceGraph<TestSpec, TestStatus> = {
        name: 'test-graph',
        resources: [],

        async factory() {
          throw new Error('Not implemented');
        },

        toYaml() {
          return 'mock yaml';
        },
      };

      expect(mockGraphWithoutSchema.schema).toBeUndefined();
    });
  });

  describe('FactoryOptions interface', () => {
    it('should accept all optional properties', () => {
      const options: FactoryOptions = {
        namespace: 'test-namespace',
        timeout: 30000,
        waitForReady: true,
        retryPolicy: {
          maxRetries: 3,
          backoffMultiplier: 2,
          initialDelay: 1000,
          maxDelay: 10000,
        },
        progressCallback: (event) => {
          console.log('Progress:', event.message);
        },
      };

      expect(options.namespace).toBe('test-namespace');
      expect(options.timeout).toBe(30000);
      expect(options.waitForReady).toBe(true);
      expect(options.retryPolicy?.maxRetries).toBe(3);
      expect(typeof options.progressCallback).toBe('function');
    });

    it('should work with empty options', () => {
      const options: FactoryOptions = {};
      expect(options).toEqual({});
    });

    it('should support alchemy scope', () => {
      const mockScope = {} as any; // Mock alchemy scope

      const options: FactoryOptions = {
        alchemyScope: mockScope,
      };

      expect(options.alchemyScope).toBe(mockScope);
    });
  });

  describe('ResourceFactory interface', () => {
    it('should define base factory contract', () => {
      // Mock implementation to test interface structure
      const mockFactory: ResourceFactory<TestSpec, TestStatus> = {
        mode: 'direct',
        name: 'test-factory',
        namespace: 'default',
        isAlchemyManaged: false,

        async deploy(_spec) {
          // Mock implementation
          return {} as any;
        },

        async getInstances() {
          return [];
        },

        async deleteInstance(_name) {
          // Mock implementation
        },

        async getStatus() {
          return {
            name: 'test-factory',
            mode: 'direct',
            isAlchemyManaged: false,
            namespace: 'default',
            instanceCount: 0,
            health: 'healthy',
          };
        },
      };

      expect(mockFactory.mode).toBe('direct');
      expect(mockFactory.name).toBe('test-factory');
      expect(mockFactory.namespace).toBe('default');
      expect(mockFactory.isAlchemyManaged).toBe(false);
      expect(typeof mockFactory.deploy).toBe('function');
      expect(typeof mockFactory.getInstances).toBe('function');
      expect(typeof mockFactory.deleteInstance).toBe('function');
      expect(typeof mockFactory.getStatus).toBe('function');
    });
  });

  describe('DirectResourceFactory interface', () => {
    it('should extend ResourceFactory with direct-specific methods', () => {
      const mockDirectFactory: DirectResourceFactory<TestSpec, TestStatus> = {
        mode: 'direct',
        name: 'test-direct-factory',
        namespace: 'default',
        isAlchemyManaged: false,

        async deploy(_spec) {
          return {} as any;
        },

        async getInstances() {
          return [];
        },

        async deleteInstance(_name) {
          // Mock implementation
        },

        async getStatus() {
          return {
            name: 'test-direct-factory',
            mode: 'direct',
            isAlchemyManaged: false,
            namespace: 'default',
            instanceCount: 0,
            health: 'healthy',
          };
        },

        // Direct-specific methods
        async rollback() {
          return {
            deploymentId: 'test-deployment',
            rolledBackResources: [],
            duration: 0,
            status: 'success',
            errors: [],
          };
        },

        async toDryRun(_spec) {
          return {} as any;
        },

        toYaml(_spec) {
          return 'mock deployment yaml';
        },
      };

      expect(mockDirectFactory.mode).toBe('direct');
      expect(typeof mockDirectFactory.rollback).toBe('function');
      expect(typeof mockDirectFactory.toDryRun).toBe('function');
      expect(typeof mockDirectFactory.toYaml).toBe('function');
    });
  });

  describe('KroResourceFactory interface', () => {
    it('should extend ResourceFactory with kro-specific methods', () => {
      const mockKroFactory: KroResourceFactory<TestSpec, TestStatus> = {
        mode: 'kro',
        name: 'test-kro-factory',
        namespace: 'default',
        isAlchemyManaged: false,
        rgdName: 'test-rgd',
        schema: {} as any, // Mock schema proxy

        async deploy(_spec) {
          return {} as any;
        },

        async getInstances() {
          return [];
        },

        async deleteInstance(_name) {
          // Mock implementation
        },

        async getStatus() {
          return {
            name: 'test-kro-factory',
            mode: 'kro',
            isAlchemyManaged: false,
            namespace: 'default',
            instanceCount: 0,
            health: 'healthy',
          };
        },

        // Kro-specific methods
        async getRGDStatus() {
          return {
            name: 'test-rgd',
            phase: 'ready',
            conditions: [],
          };
        },

        toYaml(spec?) {
          if (spec) {
            return 'mock instance yaml';
          }
          return 'mock rgd yaml';
        },
      };

      expect(mockKroFactory.mode).toBe('kro');
      expect(mockKroFactory.rgdName).toBe('test-rgd');
      expect(typeof mockKroFactory.getRGDStatus).toBe('function');
      expect(typeof mockKroFactory.toYaml).toBe('function');
      expect(typeof mockKroFactory.schema).toBe('object');
    });

    it('should support overloaded toYaml method', () => {
      const mockKroFactory: KroResourceFactory<TestSpec, TestStatus> = {
        mode: 'kro',
        name: 'test-kro-factory',
        namespace: 'default',
        isAlchemyManaged: false,
        rgdName: 'test-rgd',
        schema: {} as any,

        async deploy(_spec) {
          return {} as any;
        },

        async getInstances() {
          return [];
        },

        async deleteInstance(_name) {
          // Mock implementation
        },

        async getStatus() {
          return {
            name: 'test-kro-factory',
            mode: 'kro',
            isAlchemyManaged: false,
            namespace: 'default',
            instanceCount: 0,
            health: 'healthy',
          };
        },

        async getRGDStatus() {
          return {
            name: 'test-rgd',
            phase: 'ready',
            conditions: [],
          };
        },

        toYaml(spec?) {
          if (spec) {
            return 'instance yaml with spec';
          }
          return 'rgd yaml without spec';
        },
      };

      // Test both overloads
      expect(mockKroFactory.toYaml()).toBe('rgd yaml without spec');
      expect(mockKroFactory.toYaml({ name: 'test', replicas: 1 })).toBe('instance yaml with spec');
    });
  });

  describe('FactoryForMode type mapping', () => {
    it('should map kro mode to KroResourceFactory', () => {
      // This test validates type mapping at compile time
      type KroFactory = FactoryForMode<'kro', TestSpec, TestStatus>;

      // This should compile without errors
      const mockKroFactory: KroFactory = {
        mode: 'kro',
        name: 'test',
        namespace: 'default',
        isAlchemyManaged: false,
        rgdName: 'test-rgd',
        schema: {} as any,

        async deploy(_spec) {
          return {} as any;
        },

        async getInstances() {
          return [];
        },

        async deleteInstance(_name) {
          // Mock implementation
        },

        async getStatus() {
          return {
            name: 'test',
            mode: 'kro',
            isAlchemyManaged: false,
            namespace: 'default',
            instanceCount: 0,
            health: 'healthy',
          };
        },

        async getRGDStatus() {
          return {
            name: 'test-rgd',
            phase: 'ready',
            conditions: [],
          };
        },

        toYaml(_spec?) {
          return 'yaml';
        },
      };

      expect(mockKroFactory.mode).toBe('kro');
    });

    it('should map direct mode to DirectResourceFactory', () => {
      // This test validates type mapping at compile time
      type DirectFactory = FactoryForMode<'direct', TestSpec, TestStatus>;

      // This should compile without errors
      const mockDirectFactory: DirectFactory = {
        mode: 'direct',
        name: 'test',
        namespace: 'default',
        isAlchemyManaged: false,

        async deploy(_spec) {
          return {} as any;
        },

        async getInstances() {
          return [];
        },

        async deleteInstance(_name) {
          // Mock implementation
        },

        async getStatus() {
          return {
            name: 'test',
            mode: 'direct',
            isAlchemyManaged: false,
            namespace: 'default',
            instanceCount: 0,
            health: 'healthy',
          };
        },

        async rollback() {
          return {
            deploymentId: 'test',
            rolledBackResources: [],
            duration: 0,
            status: 'success',
            errors: [],
          };
        },

        async toDryRun(_spec) {
          return {} as any;
        },

        toYaml(_spec) {
          return 'yaml';
        },
      };

      expect(mockDirectFactory.mode).toBe('direct');
    });
  });

  describe('KroCompatibleType constraint', () => {
    it('should work with arktype schemas', () => {
      // This validates that our KroCompatibleType works with arktype
      const validSchema = type({
        name: 'string',
        count: 'number',
      });

      // This should compile without errors
      type ValidSpec = typeof validSchema.infer;

      // Test that it can be used in factory types
      type TestFactory = ResourceFactory<ValidSpec, ValidSpec>;

      // Mock to ensure it compiles
      const mockFactory: TestFactory = {} as any;
      expect(mockFactory).toBeDefined();
    });
  });
});
