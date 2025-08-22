/**
 * Test suite for HelmRepository Factory Function
 *
 * This tests the HelmRepository factory with its readiness evaluation logic
 * for both default and OCI repository types.
 */

import { describe, expect, it } from 'bun:test';
import { helmRepository, type HelmRepositoryConfig } from '../../../src/factories/helm/helm-repository.js';

describe('HelmRepository Factory', () => {
  const createTestConfig = (
    name: string = 'test-repo',
    url: string = 'https://charts.bitnami.com/bitnami'
  ): HelmRepositoryConfig => ({
    name,
    url,
    interval: '5m',
    namespace: 'flux-system',
  });

  describe('Factory Creation', () => {
    it('should create helmRepository with proper structure', () => {
      const config = createTestConfig();
      const enhanced = helmRepository(config);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('HelmRepository');
      expect(enhanced.apiVersion).toBe('source.toolkit.fluxcd.io/v1');
      expect(enhanced.metadata.name).toBe('test-repo');
      expect(enhanced.metadata.namespace).toBe('flux-system');
      expect(enhanced.spec.url).toBe('https://charts.bitnami.com/bitnami');
      expect(enhanced.spec.interval).toBe('5m');
    });

    it('should create helmRepository with minimal config', () => {
      const config = { name: 'minimalRepo', url: 'https://example.com/charts' };
      const enhanced = helmRepository(config);

      expect(enhanced).toBeDefined();
      expect(enhanced.kind).toBe('HelmRepository');
      expect(enhanced.spec.url).toBe('https://example.com/charts');
      expect(enhanced.spec.interval).toBe('5m'); // Default interval
      // When no namespace is provided, it gets a proxy function
      expect(enhanced.metadata.namespace).toBeDefined();
    });

    it('should create helmRepository with OCI type', () => {
      const config = createTestConfig('ociRepo', 'oci://ghcr.io/my-org/charts');
      config.type = 'oci';
      const enhanced = helmRepository(config);

      expect(enhanced).toBeDefined();
      expect(enhanced.spec.type).toBe('oci');
      expect(enhanced.spec.url).toBe('oci://ghcr.io/my-org/charts');
    });

    it('should create helmRepository with custom ID', () => {
      const config = createTestConfig();
      config.id = 'customId'; // Use camelCase ID as required by Kro
      const enhanced = helmRepository(config);

      expect(enhanced).toBeDefined();
      expect(enhanced.id).toBe('customId');
    });
  });

  describe('Readiness Evaluator', () => {
    it('should attach readiness evaluator', () => {
      const config = createTestConfig();
      const enhanced = helmRepository(config);

      expect((enhanced as any).readinessEvaluator).toBeDefined();
      expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
    });

    it('should evaluate as ready when Ready condition is True', () => {
      const config = createTestConfig();
      const enhanced = helmRepository(config);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'test-repo' },
        spec: { url: 'https://charts.bitnami.com/bitnami' },
        status: {
          conditions: [
            { type: 'Ready', status: 'True', message: 'Repository is ready' }
          ]
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(true);
      expect(result.message).toBe('HelmRepository is ready');
    });

    it('should evaluate as not ready when Ready condition is False', () => {
      const config = createTestConfig();
      const enhanced = helmRepository(config);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'test-repo' },
        spec: { url: 'https://charts.bitnami.com/bitnami' },
        status: {
          conditions: [
            { type: 'Ready', status: 'False', message: 'Repository not accessible' }
          ]
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.message).toBe('HelmRepository is not ready');
    });

    it('should evaluate OCI repository as ready with metadata', () => {
      const config = createTestConfig('ociRepo', 'oci://ghcr.io/my-org/charts');
      config.type = 'oci';
      const enhanced = helmRepository(config);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { 
          name: 'oci-repo',
          generation: 1,
          resourceVersion: '12345'
        },
        spec: { 
          url: 'oci://ghcr.io/my-org/charts',
          type: 'oci'
        },
        status: {
          conditions: [] // OCI repos may not have status conditions
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(true);
      expect(result.message).toBe('OCI HelmRepository is functional');
    });

    it('should evaluate OCI repository as not ready without metadata', () => {
      const config = createTestConfig('ociRepo', 'oci://ghcr.io/my-org/charts');
      config.type = 'oci';
      const enhanced = helmRepository(config);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'oci-repo' },
        spec: { 
          url: 'oci://ghcr.io/my-org/charts',
          type: 'oci'
        },
        status: {
          conditions: []
        }
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.message).toBe('HelmRepository is not ready');
    });

    it('should handle missing status', () => {
      const config = createTestConfig();
      const enhanced = helmRepository(config);
      const evaluator = (enhanced as any).readinessEvaluator;

      const mockResource = {
        metadata: { name: 'test-repo' },
        spec: { url: 'https://charts.bitnami.com/bitnami' }
        // No status
      };

      const result = evaluator(mockResource);
      expect(result.ready).toBe(false);
      expect(result.message).toBe('HelmRepository is not ready');
    });
  });

  describe('Status Structure', () => {
    it('should initialize status with proper structure', () => {
      const config = createTestConfig();
      const enhanced = helmRepository(config);

      expect(enhanced.status).toBeDefined();
      expect(enhanced.status.conditions).toEqual([]);
      expect(enhanced.status.url).toBe(config.url);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing name gracefully', () => {
      const config = { url: 'https://charts.bitnami.com/bitnami' } as HelmRepositoryConfig;
      const enhanced = helmRepository(config);
      
      // The factory doesn't throw but creates resource with undefined name
      expect(enhanced.metadata.name).toBe(undefined);
      expect(enhanced.spec.url).toBe(config.url);
    });

    it('should handle missing url gracefully', () => {
      const config = { name: 'testRepo' } as HelmRepositoryConfig;
      const enhanced = helmRepository(config);
      
      // The factory doesn't throw but creates resource with undefined url
      expect(enhanced.metadata.name).toBe('testRepo');
      expect(enhanced.spec.url).toBe(undefined);
    });
  });

  describe('TypeScript Compilation', () => {
    it('should compile with strict typing', () => {
      // This test ensures the TypeScript types are correct
      const config: HelmRepositoryConfig = {
        name: 'typedRepo',
        url: 'https://charts.bitnami.com/bitnami',
        interval: '10m',
        type: 'default' as const,
        namespace: 'flux-system',
        id: 'uniqueId' // Use camelCase ID as required by Kro
      };

      const result = helmRepository(config);
      
      // These should compile without type errors
      expect(result.spec.url).toBe(config.url);
      expect(result.spec.interval).toBe(config.interval);
      expect(result.spec.type).toBe(config.type);
    });
  });
});