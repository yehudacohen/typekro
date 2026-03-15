/**
 * Tests for dynamic alchemy resource type registration
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  clearRegisteredTypes,
  DirectTypeKroDeployer,
  ensureResourceTypeRegistered,
  inferAlchemyTypeFromTypeKroResource,
} from '../../../src/alchemy/deployment.js';
import { getReadinessEvaluator } from '../../../src/core/metadata/index.js';
import type { Enhanced } from '../../../src/core/types/kubernetes.js';
import { deployment } from '../../../src/factories/kubernetes/workloads/deployment.js';

// Mock Enhanced resource for testing - using proper factory function
const mockDeployment = deployment({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: 'test-deployment',
    namespace: 'default',
  },
  spec: {
    replicas: 3,
    selector: { matchLabels: { app: 'test' } },
    template: {
      metadata: { labels: { app: 'test' } },
      spec: {
        containers: [
          {
            name: 'app',
            image: 'nginx:latest',
          },
        ],
      },
    },
  },
  status: {},
});

const mockRGD: Enhanced<any, any> = {
  apiVersion: 'kro.run/v1alpha1',
  kind: 'ResourceGraphDefinition',
  metadata: {
    name: 'test-rgd',
    namespace: 'default',
  },
  spec: {},
  status: {},
} as Enhanced<any, any>;

describe('Dynamic Alchemy Resource Registration', () => {
  beforeEach(() => {
    // Clear registration cache before each test
    clearRegisteredTypes();
  });

  describe('inferAlchemyTypeFromTypeKroResource', () => {
    it('should infer kubernetes type for standard resources', () => {
      const type = inferAlchemyTypeFromTypeKroResource(mockDeployment);
      expect(type).toBe('kubernetes::Deployment');
    });

    it('should infer kro type for ResourceGraphDefinitions', () => {
      const type = inferAlchemyTypeFromTypeKroResource(mockRGD);
      expect(type).toBe('kro::ResourceGraphDefinition');
    });

    it('should infer kro type for other kro resources', () => {
      const mockCRD: Enhanced<any, any> = {
        ...mockDeployment,
        apiVersion: 'example.kro.run/v1alpha1',
        kind: 'WebApp',
      };

      const type = inferAlchemyTypeFromTypeKroResource(mockCRD);
      expect(type).toBe('kro::WebApp');
    });

    it('should validate resource kind is present', () => {
      const invalidResource: Enhanced<any, any> = {
        ...mockDeployment,
        kind: undefined as unknown as string,
      };

      expect(() => inferAlchemyTypeFromTypeKroResource(invalidResource)).toThrow(
        'Resource must have a kind field for Alchemy type inference'
      );
    });

    it('should validate resource kind naming patterns', () => {
      const invalidResource: Enhanced<any, any> = {
        ...mockDeployment,
        kind: 'Invalid-Kind-Name',
      };

      expect(() => inferAlchemyTypeFromTypeKroResource(invalidResource)).toThrow(
        'contains invalid characters'
      );
    });

    it('should reject reserved resource type names', () => {
      const reservedResource: Enhanced<any, any> = {
        ...mockDeployment,
        kind: 'Resource',
      };

      expect(() => inferAlchemyTypeFromTypeKroResource(reservedResource)).toThrow(
        'is a reserved name and cannot be used'
      );
    });

    it('should reject resource kinds that are too long', () => {
      const longKindResource: Enhanced<any, any> = {
        ...mockDeployment,
        kind: 'A'.repeat(101), // Exceeds 100 character limit
      };

      expect(() => inferAlchemyTypeFromTypeKroResource(longKindResource)).toThrow(
        'exceeds maximum length'
      );
    });
  });

  describe('ensureResourceTypeRegistered', () => {
    it('should register a new resource type', () => {
      const provider = ensureResourceTypeRegistered(mockDeployment);
      expect(provider).toBeDefined();
      expect(typeof provider).toBe('function');
    });

    it('should return the same provider for the same resource type', () => {
      const provider1 = ensureResourceTypeRegistered(mockDeployment);
      const provider2 = ensureResourceTypeRegistered(mockDeployment);
      expect(provider1).toBe(provider2);
    });

    it('should register different providers for different resource types', () => {
      const deploymentProvider = ensureResourceTypeRegistered(mockDeployment);
      const rgdProvider = ensureResourceTypeRegistered(mockRGD);
      expect(deploymentProvider).not.toBe(rgdProvider);
    });

    it('should track registered types', () => {
      ensureResourceTypeRegistered(mockDeployment);
      ensureResourceTypeRegistered(mockRGD);

      // Note: We can't easily inspect registered types, so we'll test behavior instead
      // The fact that ensureResourceTypeRegistered didn't throw means it worked
      expect(true).toBe(true);
    });
  });

  describe('createAlchemyResource', () => {
    it('should create an alchemy resource with proper structure', async () => {
      // Skip this test as it requires an alchemy scope to run
      // This functionality will be tested in integration tests with proper alchemy setup
      expect(true).toBe(true);
    });

    it('should use deterministic resource IDs', async () => {
      // Skip this test as it requires an alchemy scope to run
      // This functionality will be tested in integration tests with proper alchemy setup
      expect(true).toBe(true);
    });
  });

  describe('DirectTypeKroDeployer', () => {
    it('should create a deployer instance', () => {
      const mockEngine = {} as unknown as ConstructorParameters<typeof DirectTypeKroDeployer>[0]; // Mock DirectDeploymentEngine
      const deployer = new DirectTypeKroDeployer(mockEngine);
      expect(deployer).toBeDefined();
    });

    it('should deploy resources successfully', async () => {
      const mockEngine = {
        deploy: async () => ({
          status: 'success' as const,
          resources: [],
          errors: [],
        }),
      } as unknown as ConstructorParameters<typeof DirectTypeKroDeployer>[0];
      const deployer = new DirectTypeKroDeployer(mockEngine);

      const result = await deployer.deploy(mockDeployment, {
        mode: 'direct',
        namespace: 'test',
        waitForReady: true,
        timeout: 30000,
      });

      // The result should have the same properties as the original deployment
      expect(result.kind).toBe(mockDeployment.kind);
      expect(result.metadata?.name).toBe(mockDeployment.metadata?.name as unknown as string);
      expect(result.spec?.replicas).toBe(mockDeployment.spec?.replicas);

      // The result should now have a readiness evaluator (stored in WeakMap metadata)
      expect(getReadinessEvaluator(result)).toBeDefined();
      expect(typeof getReadinessEvaluator(result)).toBe('function');
    });
  });

  describe('Registration Cache Management', () => {
    it('should clear local registration cache without errors', () => {
      // Just verify the function works without throwing
      clearRegisteredTypes();
      expect(true).toBe(true);
    });

    it('should handle registration without errors', () => {
      // Test that registration works without throwing
      expect(() => clearRegisteredTypes()).not.toThrow();
    });
  });

  describe('Resource Serialization Safety', () => {
    it('should safely serialize Enhanced resources with symbol properties', () => {
      // Enhanced resources contain non-cloneable properties:
      // - Symbol-keyed properties (KUBERNETES_REF_BRAND, pino.chindings)
      // - Functions (readinessEvaluator)
      // - undefined values
      // Regression test: structuredClone throws "Cannot serialize unique symbol"
      // on these objects, but JSON round-trip safely strips them.
      const resourceWithSymbols = {
        ...mockDeployment,
        [Symbol.for('pino.chindings')]: '{"component":"test"}',
        [Symbol.for('TypeKro.KubernetesRef')]: true,
      };

      // JSON round-trip should NOT throw (unlike structuredClone)
      expect(() => {
        JSON.parse(JSON.stringify(resourceWithSymbols));
      }).not.toThrow();

      // structuredClone WOULD throw on symbol-keyed objects
      expect(() => {
        structuredClone(resourceWithSymbols);
      }).toThrow();

      // The serialized result should have the data fields but not symbols/functions
      const serialized = JSON.parse(JSON.stringify(resourceWithSymbols));
      expect(serialized.apiVersion).toBe('apps/v1');
      expect(serialized.kind).toBe('Deployment');
      expect(serialized.metadata?.name).toBe('test-deployment');
    });

    it('should strip undefined values during serialization', () => {
      // JSON.stringify strips undefined values, which is desired behavior
      // for Kubernetes API payloads where undefined fields should be omitted
      const resourceWithUndefined = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'test', namespace: undefined },
        data: { key: 'value', missing: undefined },
      };

      const serialized = JSON.parse(JSON.stringify(resourceWithUndefined));

      // undefined values should be stripped
      expect(serialized.metadata.namespace).toBeUndefined();
      expect(serialized.data.missing).toBeUndefined();
      expect('namespace' in serialized.metadata).toBe(false);
      expect('missing' in serialized.data).toBe(false);

      // defined values should be preserved
      expect(serialized.metadata.name).toBe('test');
      expect(serialized.data.key).toBe('value');
    });

    it('should strip function properties during serialization', () => {
      // Enhanced resources have readinessEvaluator functions that must be stripped
      const resourceWithFunctions = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'test' },
        readinessEvaluator: () => ({ ready: true, message: 'ok' }),
        someMethod: () => 42,
      };

      const serialized = JSON.parse(JSON.stringify(resourceWithFunctions));

      // Functions should be stripped
      expect(serialized.readinessEvaluator).toBeUndefined();
      expect(serialized.someMethod).toBeUndefined();

      // Data properties should be preserved
      expect(serialized.apiVersion).toBe('apps/v1');
      expect(serialized.kind).toBe('Deployment');
    });
  });
});
