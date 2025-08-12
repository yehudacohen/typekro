/**
 * Tests for Kro Schema Constraints
 *
 * This test file validates that the KroCompatibleType constraint works correctly
 * and prevents incompatible types from being used with Kro schemas.
 */

import { describe, expect, it } from 'bun:test';
import type { KroCompatibleType, KubernetesRef } from '../../src/index';
import { createSchemaProxy } from '../../src/index';
import { isKubernetesRef } from '../../src/utils/type-guards.js';

describe('Kro Schema Constraints', () => {
  describe('KroCompatibleType validation', () => {
    it('should accept valid Kro-compatible spec types', () => {
      // These types should be compatible with Kro Simple Schema
      interface ValidSpec extends KroCompatibleType {
        name: string;
        replicas: number;
        enabled: boolean;
        tags: string[];
        ports: number[];
        labels: Record<string, string>;
        config: {
          database: string;
          timeout: number;
        };
      }

      interface ValidStatus extends KroCompatibleType {
        ready: boolean;
        url: string;
        conditions: string[];
        metrics: Record<string, number>;
      }

      // This should compile without errors
      const schema = createSchemaProxy<ValidSpec, ValidStatus>();

      expect(schema.spec).toBeDefined();
      expect(schema.status).toBeDefined();
    });

    it('should provide type-safe access to Kro-compatible fields', () => {
      interface KroSpec extends KroCompatibleType {
        appName: string;
        replicas: number;
        ingress: {
          enabled: boolean;
          host: string;
        };
        env: Record<string, string>;
        ports: number[];
      }

      interface KroStatus extends KroCompatibleType {
        phase: string;
        availableReplicas: number;
        conditions: string[];
        endpoints: Record<string, string>;
      }

      const schema = createSchemaProxy<KroSpec, KroStatus>();

      // Test spec field access
      const nameRef = schema.spec.appName;
      const replicasRef = schema.spec.replicas;
      const ingressEnabledRef = schema.spec.ingress.enabled;
      const envRef = schema.spec.env.DATABASE_URL;
      const portsRef = schema.spec.ports;

      // Test status field access
      const phaseRef = schema.status.phase;
      const availableRef = schema.status.availableReplicas;
      const conditionsRef = schema.status.conditions;
      const endpointsRef = schema.status.endpoints.web;

      // All should be KubernetesRef objects
      expect(isKubernetesRef(nameRef)).toBe(true);
      expect(isKubernetesRef(replicasRef)).toBe(true);
      expect(isKubernetesRef(ingressEnabledRef)).toBe(true);
      expect(isKubernetesRef(envRef)).toBe(true);
      expect(isKubernetesRef(portsRef)).toBe(true);
      expect(isKubernetesRef(phaseRef)).toBe(true);
      expect(isKubernetesRef(availableRef)).toBe(true);
      expect(isKubernetesRef(conditionsRef)).toBe(true);
      expect(isKubernetesRef(endpointsRef)).toBe(true);

      // Check field paths
      expect((nameRef as unknown as KubernetesRef<string>).fieldPath).toBe('spec.appName');
      expect((ingressEnabledRef as unknown as KubernetesRef<string>).fieldPath).toBe(
        'spec.ingress.enabled'
      );
      expect((envRef as unknown as KubernetesRef<string>).fieldPath).toBe('spec.env.DATABASE_URL');
      expect((phaseRef as unknown as KubernetesRef<string>).fieldPath).toBe('status.phase');
      expect((endpointsRef as unknown as KubernetesRef<string>).fieldPath).toBe(
        'status.endpoints.web'
      );
    });

    it('should work with nested Kro-compatible structures', () => {
      interface NestedSpec extends KroCompatibleType {
        app: {
          name: string;
          version: string;
          config: {
            database: {
              host: string;
              port: number;
              ssl: boolean;
            };
            cache: {
              enabled: boolean;
              ttl: number;
            };
          };
        };
        deployment: {
          replicas: number;
          strategy: string;
          resources: Record<string, string>;
        };
      }

      interface NestedStatus extends KroCompatibleType {
        deployment: {
          ready: boolean;
          available: number;
          conditions: string[];
        };
        services: Record<string, string>;
      }

      const schema = createSchemaProxy<NestedSpec, NestedStatus>();

      // Test deeply nested access
      const dbHostRef = schema.spec.app.config.database.host;
      const cacheEnabledRef = schema.spec.app.config.cache.enabled;
      const deploymentReadyRef = schema.status.deployment.ready;
      const servicesRef = schema.status.services.web;

      expect((dbHostRef as unknown as KubernetesRef<string>).fieldPath).toBe(
        'spec.app.config.database.host'
      );
      expect((cacheEnabledRef as unknown as KubernetesRef<string>).fieldPath).toBe(
        'spec.app.config.cache.enabled'
      );
      expect((deploymentReadyRef as unknown as KubernetesRef<string>).fieldPath).toBe(
        'status.deployment.ready'
      );
      expect((servicesRef as unknown as KubernetesRef<string>).fieldPath).toBe(
        'status.services.web'
      );
    });

    it('should work with array and map types', () => {
      interface ArrayMapSpec extends KroCompatibleType {
        tags: string[];
        ports: number[];
        flags: boolean[];
        labels: Record<string, string>;
        annotations: Record<string, number>;
        metadata: Record<string, boolean>;
      }

      interface ArrayMapStatus extends KroCompatibleType {
        endpoints: string[];
        metrics: Record<string, number>;
        conditions: string[];
      }

      const schema = createSchemaProxy<ArrayMapSpec, ArrayMapStatus>();

      // Test array access
      const tagsRef = schema.spec.tags;
      const portsRef = schema.spec.ports;
      const endpointsRef = schema.status.endpoints;

      // Test map access
      const labelsRef = schema.spec.labels.app;
      const annotationsRef = schema.spec.annotations.priority;
      const metricsRef = schema.status.metrics.cpu;

      expect((tagsRef as unknown as KubernetesRef<string>).fieldPath).toBe('spec.tags');
      expect((portsRef as unknown as KubernetesRef<string>).fieldPath).toBe('spec.ports');
      expect((endpointsRef as unknown as KubernetesRef<string>).fieldPath).toBe('status.endpoints');
      expect((labelsRef as unknown as KubernetesRef<string>).fieldPath).toBe('spec.labels.app');
      expect((annotationsRef as unknown as KubernetesRef<string>).fieldPath).toBe(
        'spec.annotations.priority'
      );
      expect((metricsRef as unknown as KubernetesRef<string>).fieldPath).toBe('status.metrics.cpu');
    });
  });

  describe('Type constraint enforcement', () => {
    it('should demonstrate Kro-compatible type patterns', () => {
      // These are examples of types that SHOULD work with Kro
      interface GoodWebAppSpec extends KroCompatibleType {
        // Basic Kro types
        name: string; // string
        replicas: number; // integer
        enabled: boolean; // boolean

        // Array types (Kro: []string, []integer, []boolean)
        tags: string[];
        ports: number[];
        features: boolean[];

        // Map types (Kro: map[string]string, map[string]integer, etc.)
        labels: Record<string, string>;
        limits: Record<string, number>;
        flags: Record<string, boolean>;

        // Nested objects (Kro custom types)
        ingress: {
          enabled: boolean;
          host: string;
          path: string;
        };

        // Deeply nested (Kro custom types with nested custom types)
        database: {
          connection: {
            host: string;
            port: number;
            ssl: boolean;
          };
          pool: {
            min: number;
            max: number;
          };
        };
      }

      interface GoodWebAppStatus extends KroCompatibleType {
        phase: string;
        ready: boolean;
        replicas: number;
        conditions: string[];
        endpoints: Record<string, string>;
        metrics: {
          cpu: number;
          memory: number;
          requests: number;
        };
      }

      // This should compile successfully
      const schema = createSchemaProxy<GoodWebAppSpec, GoodWebAppStatus>();
      expect(schema).toBeDefined();
    });

    // Note: We can't easily test compile-time type errors in runtime tests,
    // but the following would be examples of types that should NOT compile:

    // interface BadSpec extends KroCompatibleType {
    //   // These would cause TypeScript errors:
    //   callback: () => void;           // Functions not allowed
    //   date: Date;                     // Complex objects not allowed
    //   buffer: Buffer;                 // Node.js types not allowed
    //   mixed: string | number | null;  // Union types not allowed
    //   optional?: string;              // Optional fields need careful handling
    // }
  });

  describe('Integration with existing functionality', () => {
    it('should work with existing schema proxy functionality', () => {
      interface TestSpec extends KroCompatibleType {
        name: string;
        config: {
          enabled: boolean;
          timeout: number;
        };
      }

      interface TestStatus extends KroCompatibleType {
        ready: boolean;
        url: string;
      }

      const schema = createSchemaProxy<TestSpec, TestStatus>();

      // Should work with existing isSchemaReference function
      const nameRef = schema.spec.name;
      const readyRef = schema.status.ready;

      expect((nameRef as unknown as KubernetesRef<string>).resourceId).toBe('__schema__');
      expect((readyRef as unknown as KubernetesRef<string>).resourceId).toBe('__schema__');
      expect((nameRef as unknown as KubernetesRef<string>).fieldPath).toBe('spec.name');
      expect((readyRef as unknown as KubernetesRef<string>).fieldPath).toBe('status.ready');
    });
  });
});
