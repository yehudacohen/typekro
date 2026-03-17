/**
 * Unit tests for the factory pattern interfaces and types
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import type {
  DeploymentResult,
  DirectResourceFactory,
  FactoryForMode,
  FactoryOptions,
  InternalFactoryOptions,
  KroResourceFactory,
  PublicFactoryOptions,
  ResourceFactory,
  TypedResourceGraph,
} from '../../src/core/types/deployment.js';
import type { Enhanced } from '../../src/core/types/kubernetes.js';
import type { SchemaProxy, Scope } from '../../src/core/types/schema.js';

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
        schema: {} as unknown as SchemaProxy<TestSpec, TestStatus>, // Mock schema proxy

        factory(_mode, _options) {
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

        factory() {
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
      const mockScope = {} as unknown as Scope; // Mock alchemy scope

      const options: FactoryOptions = {
        alchemyScope: mockScope,
      };

      expect(options.alchemyScope).toBe(mockScope);
    });
  });

  describe('PublicFactoryOptions interface', () => {
    it('should contain only user-facing fields', () => {
      const options: PublicFactoryOptions = {
        namespace: 'prod',
        timeout: 60000,
        waitForReady: true,
        hydrateStatus: true,
        skipTLSVerify: false,
        eventMonitoring: { enabled: true },
        debugLogging: { enabled: false },
        autoFix: { fluxCRDs: true },
      };

      expect(options.namespace).toBe('prod');
      expect(options.hydrateStatus).toBe(true);
      expect(options.skipTLSVerify).toBe(false);
      expect(options.eventMonitoring?.enabled).toBe(true);
    });

    it('should NOT expose internal fields', () => {
      const options: PublicFactoryOptions = {};
      // Compile-time check: these properties should not exist on PublicFactoryOptions
      // @ts-expect-error compositionFn is internal-only
      void options.compositionFn;
      // @ts-expect-error compositionDefinition is internal-only
      void options.compositionDefinition;
      // @ts-expect-error compositionOptions is internal-only
      void options.compositionOptions;
      // @ts-expect-error factoryType is internal-only
      void options.factoryType;
      // @ts-expect-error statusMappings is internal-only
      void options.statusMappings;
      expect(options).toEqual({});
    });

    it('should be assignable to FactoryOptions', () => {
      const publicOpts: PublicFactoryOptions = { namespace: 'test' };
      // PublicFactoryOptions is a subset of FactoryOptions
      const fullOpts: FactoryOptions = publicOpts;
      expect(fullOpts.namespace).toBe('test');
    });
  });

  describe('InternalFactoryOptions interface', () => {
    it('should contain only internal fields', () => {
      const internal: InternalFactoryOptions = {
        compositionFn: (spec) => spec,
        compositionDefinition: { name: 'test' },
        compositionOptions: {},
        factoryType: 'direct',
        statusMappings: { ready: true },
      };

      expect(typeof internal.compositionFn).toBe('function');
      expect(internal.factoryType).toBe('direct');
      expect(internal.statusMappings).toEqual({ ready: true });
    });

    it('should work with empty options', () => {
      const internal: InternalFactoryOptions = {};
      expect(internal).toEqual({});
    });
  });

  describe('FactoryOptions = PublicFactoryOptions & InternalFactoryOptions', () => {
    it('should accept both public and internal fields', () => {
      const options: FactoryOptions = {
        // Public fields
        namespace: 'prod',
        timeout: 30000,
        hydrateStatus: true,
        // Internal fields
        compositionFn: (spec) => spec,
        factoryType: 'kro',
        statusMappings: { phase: 'Ready' },
      };

      expect(options.namespace).toBe('prod');
      expect(typeof options.compositionFn).toBe('function');
      expect(options.factoryType).toBe('kro');
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
          // Mock implementation - never called in type-validation tests
          return {} as unknown as Enhanced<TestSpec, TestStatus>;
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
          return {} as unknown as Enhanced<TestSpec, TestStatus>;
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
          return {} as unknown as DeploymentResult;
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
        schema: {} as unknown as SchemaProxy<TestSpec, TestStatus>, // Mock schema proxy

        async deploy(_spec) {
          return {} as unknown as Enhanced<TestSpec, TestStatus>;
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
        schema: {} as unknown as SchemaProxy<TestSpec, TestStatus>,

        async deploy(_spec) {
          return {} as unknown as Enhanced<TestSpec, TestStatus>;
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
        schema: {} as unknown as SchemaProxy<TestSpec, TestStatus>,

        async deploy(_spec) {
          return {} as unknown as Enhanced<TestSpec, TestStatus>;
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
          return {} as unknown as Enhanced<TestSpec, TestStatus>;
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
          return {} as unknown as DeploymentResult;
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
      const mockFactory: TestFactory = {} as unknown as TestFactory;
      expect(mockFactory).toBeDefined();
    });
  });
});
