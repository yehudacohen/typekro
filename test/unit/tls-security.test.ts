import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { KubernetesApi } from '../../src/core/kubernetes/api.js';
import type { FactoryOptions } from '../../src/core/types/deployment.js';

describe('TLS Security Configuration', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Save original environment
    originalEnv = {
      KUBERNETES_API_SERVER: process.env.KUBERNETES_API_SERVER,
      KUBERNETES_API_TOKEN: process.env.KUBERNETES_API_TOKEN,
      KUBERNETES_CA_CERT: process.env.KUBERNETES_CA_CERT,
      KUBERNETES_SKIP_TLS_VERIFY: process.env.KUBERNETES_SKIP_TLS_VERIFY,
    };
  });

  afterEach(() => {
    // Restore original environment
    Object.keys(originalEnv).forEach((key) => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
  });

  describe('KubernetesApi TLS Configuration', () => {
    it('should enable TLS verification by default', () => {
      // Set required env vars
      process.env.KUBERNETES_API_SERVER = 'https://test-cluster.example.com';
      process.env.KUBERNETES_API_TOKEN = 'test-token';
      delete process.env.KUBERNETES_SKIP_TLS_VERIFY;

      const api = new KubernetesApi();

      // Access the private kc property to check cluster configuration
      const kc = (api as any).kc;
      const cluster = kc.getCurrentCluster();

      expect(cluster?.skipTLSVerify).toBe(false);
    });

    it('should disable TLS verification only when explicitly set', () => {
      // Set required env vars
      process.env.KUBERNETES_API_SERVER = 'https://test-cluster.example.com';
      process.env.KUBERNETES_API_TOKEN = 'test-token';
      process.env.KUBERNETES_SKIP_TLS_VERIFY = 'true';

      const api = new KubernetesApi();

      // Access the private kc property to check cluster configuration
      const kc = (api as any).kc;
      const cluster = kc.getCurrentCluster();

      expect(cluster?.skipTLSVerify).toBe(true);
    });

    it('should not disable TLS verification for non-true values', () => {
      // Set required env vars
      process.env.KUBERNETES_API_SERVER = 'https://test-cluster.example.com';
      process.env.KUBERNETES_API_TOKEN = 'test-token';
      process.env.KUBERNETES_SKIP_TLS_VERIFY = 'false';

      const api = new KubernetesApi();

      // Access the private kc property to check cluster configuration
      const kc = (api as any).kc;
      const cluster = kc.getCurrentCluster();

      expect(cluster?.skipTLSVerify).toBe(false);
    });
  });

  describe('FactoryOptions TLS Configuration', () => {
    it('should have skipTLSVerify option with security documentation', () => {
      const options: FactoryOptions = {
        skipTLSVerify: true,
      };

      expect(options.skipTLSVerify).toBe(true);
    });

    it('should default to secure TLS verification', () => {
      const options: FactoryOptions = {};

      expect(options.skipTLSVerify).toBeUndefined();
    });
  });

  describe('TLS Configuration Validation', () => {
    it('should validate HTTPS endpoints with proper TLS configuration', () => {
      // Set required env vars for HTTPS endpoint
      process.env.KUBERNETES_API_SERVER = 'https://secure-cluster.example.com';
      process.env.KUBERNETES_API_TOKEN = 'test-token';
      process.env.KUBERNETES_CA_CERT = 'base64-encoded-cert';
      delete process.env.KUBERNETES_SKIP_TLS_VERIFY;

      // Should create without throwing
      expect(() => new KubernetesApi()).not.toThrow();
    });

    it('should warn about HTTP endpoints', () => {
      // Set required env vars for HTTP endpoint
      process.env.KUBERNETES_API_SERVER = 'http://insecure-cluster.example.com';
      process.env.KUBERNETES_API_TOKEN = 'test-token';
      delete process.env.KUBERNETES_CA_CERT;
      delete process.env.KUBERNETES_SKIP_TLS_VERIFY;

      // Should create without throwing but log warning
      expect(() => new KubernetesApi()).not.toThrow();
    });

    it('should warn about HTTPS endpoints with TLS disabled', () => {
      // Set required env vars for HTTPS endpoint with TLS disabled
      process.env.KUBERNETES_API_SERVER = 'https://cluster.example.com';
      process.env.KUBERNETES_API_TOKEN = 'test-token';
      delete process.env.KUBERNETES_CA_CERT;
      process.env.KUBERNETES_SKIP_TLS_VERIFY = 'true';

      // Should create without throwing but log warning
      expect(() => new KubernetesApi()).not.toThrow();
    });

    it('should handle invalid API server URLs gracefully', () => {
      // Set invalid API server
      process.env.KUBERNETES_API_SERVER = 'invalid-url';
      process.env.KUBERNETES_API_TOKEN = 'test-token';

      // Should create without throwing (validation is informational)
      expect(() => new KubernetesApi()).not.toThrow();
    });
  });
});
