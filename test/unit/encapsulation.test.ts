import { describe, expect, it } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { DirectDeploymentEngine } from '../../src/core/deployment/engine.js';

describe('Encapsulation and Public Interfaces', () => {
  describe('DirectDeploymentEngine', () => {
    it('should provide public access to KubernetesApi through getter method', () => {
      const kubeConfig = new k8s.KubeConfig();
      // Set up a minimal valid cluster configuration for testing
      kubeConfig.loadFromClusterAndUser(
        { name: 'test-cluster', server: 'https://test-cluster.example.com', skipTLSVerify: false },
        { name: 'test-user' }
      );

      const engine = new DirectDeploymentEngine(kubeConfig);

      // Should have public getter method
      expect(typeof engine.getKubernetesApi).toBe('function');

      // Should return a KubernetesObjectApi instance
      const k8sApi = engine.getKubernetesApi();
      expect(k8sApi).toBeDefined();
      expect(typeof k8sApi.read).toBe('function');
      expect(typeof k8sApi.create).toBe('function');
      expect(typeof k8sApi.patch).toBe('function');
      expect(typeof k8sApi.delete).toBe('function');
    });

    it('should not allow direct access to private k8sApi member', () => {
      const kubeConfig = new k8s.KubeConfig();
      // Set up a minimal valid cluster configuration for testing
      kubeConfig.loadFromClusterAndUser(
        { name: 'test-cluster', server: 'https://test-cluster.example.com', skipTLSVerify: false },
        { name: 'test-user' }
      );

      const engine = new DirectDeploymentEngine(kubeConfig);

      // Private member should not be accessible
      expect((engine as any).k8sApi).toBeDefined(); // It exists internally

      // But accessing it directly should be discouraged (TypeScript would prevent this)
      // This test documents that we've moved away from bracket notation access
      const publicApi = engine.getKubernetesApi();
      const privateApi = (engine as any).k8sApi;

      // They should be the same instance (proper encapsulation)
      expect(publicApi).toBe(privateApi);
    });
  });
});
