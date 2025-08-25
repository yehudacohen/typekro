/**
 * Unit tests for the new toResourceGraph API
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { Cel, toResourceGraph, simple } from '../../src/index.js';

describe('toResourceGraph API', () => {
  const WebAppSpecSchema = type({
    name: 'string',
    image: 'string',
    replicas: 'number%1',
  });

  const WebAppStatusSchema = type({
    url: 'string',
    readyReplicas: 'number%1',
  });

  // type WebAppSpec = typeof WebAppSpecSchema.infer; // Unused for now
  // type WebAppStatus = typeof WebAppStatusSchema.infer; // Unused for now

  describe('basic functionality', () => {
    it('should create a typed resource graph', () => {
      const graph = toResourceGraph(
        {
          name: 'test-webapp',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: 'http://example.com',
          readyReplicas: resources.deployment.status.readyReplicas,
        })
      );

      expect(graph.name).toBe('test-webapp');
      expect(graph.resources).toHaveLength(1);
      expect(graph.schema).toBeDefined();
    });

    it('should generate YAML without errors', () => {
      const graph = toResourceGraph(
        {
          name: 'test-webapp',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: 'http://example.com',
          readyReplicas: resources.deployment.status.readyReplicas,
        })
      );

      expect(() => graph.toYaml()).not.toThrow();

      const yaml = graph.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('name: test-webapp');
    });

    it('should have schema proxy with proper structure', () => {
      const graph = toResourceGraph(
        {
          name: 'test-webapp',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: 'http://example.com',
          readyReplicas: resources.deployment.status.readyReplicas,
        })
      );

      expect(graph.schema).toBeDefined();
      expect(graph.schema?.spec).toBeDefined();
      expect(graph.schema?.status).toBeDefined();
    });
  });

  describe('factory method', () => {
    it('should create kro factory successfully', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-webapp',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: 'http://example.com',
          readyReplicas: resources.deployment.status.readyReplicas,
        })
      );

      const kroFactory = await graph.factory('kro');

      expect(kroFactory.mode).toBe('kro');
      expect(kroFactory.name).toBe('test-webapp');
      expect(kroFactory.rgdName).toBe('test-webapp');
      expect(kroFactory.schema).toBeDefined();
    });

    it('should create direct factory successfully', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-webapp',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: 'http://example.com',
          readyReplicas: resources.deployment.status.readyReplicas,
        })
      );

      const directFactory = await graph.factory('direct');

      expect(directFactory.mode).toBe('direct');
      expect(directFactory.name).toBe('test-webapp');
      expect(typeof directFactory.rollback).toBe('function');
      expect(typeof directFactory.toDryRun).toBe('function');
    });

    it('should accept factory options', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-webapp',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: 'http://example.com',
          readyReplicas: resources.deployment.status.readyReplicas,
        })
      );

      const factoryOptions = {
        namespace: 'test-namespace',
        timeout: 30000,
        waitForReady: true,
      };

      const kroFactory = await graph.factory('kro', factoryOptions);

      expect(kroFactory.namespace).toBe('test-namespace');
      expect(kroFactory.mode).toBe('kro');
    });
  });

  describe('type safety', () => {
    it('should maintain type safety in builder function', () => {
      // This test validates that TypeScript compilation succeeds
      // without any type assertions or 'as any' casts
      const graph = toResourceGraph(
        {
          name: 'type-safe-webapp',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => {
          // These should all be properly typed without assertions
          const name = schema.spec.name; // Should be KubernetesRef<string>
          const image = schema.spec.image; // Should be KubernetesRef<string>
          const replicas = schema.spec.replicas; // Should be KubernetesRef<number>

          return {
            deployment: simple.Deployment({
              name,
              image,
              replicas,
              id: 'typeSafeDeployment',
            }),
          };
        },
        (_schema, resources) => ({
          url: 'http://example.com',
          readyReplicas: resources.deployment.status.readyReplicas,
        })
      );

      expect(graph).toBeDefined();
      expect(graph.resources).toHaveLength(1);
    });

    it('should work with complex nested schemas', () => {
      const ComplexSpecSchema = type({
        metadata: {
          name: 'string',
          labels: 'Record<string, string>',
        },
        config: {
          database: {
            host: 'string',
            port: 'number%1',
          },
          features: 'string[]',
        },
      });

      const ComplexStatusSchema = type({
        phase: '"pending" | "ready" | "failed"',
        conditions: 'string[]',
      });

      const graph = toResourceGraph(
        {
          name: 'complex-app',
          apiVersion: 'v1alpha1',
          kind: 'ComplexApp',
          spec: ComplexSpecSchema,
          status: ComplexStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.metadata.name,
            image: 'nginx:latest',
            replicas: 1,
            id: 'complexDeployment',
          }),
        }),
        (_schema, _resources) => ({
          phase: Cel.expr<'pending' | 'ready' | 'failed'>`'ready'`,
          conditions: ['Ready', 'Available'],
        })
      );

      expect(graph.name).toBe('complex-app');
      expect(graph.resources).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('should handle empty resource builder', () => {
      const graph = toResourceGraph(
        {
          name: 'empty-app',
          apiVersion: 'v1alpha1',
          kind: 'EmptyApp',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        () => ({}),
        (_schema, _resources) => ({
          ready: false,
        })
      );

      expect(graph.name).toBe('empty-app');
      expect(graph.resources).toHaveLength(0);
    });

    it('should handle YAML generation with empty resources', () => {
      const graph = toResourceGraph(
        {
          name: 'empty-app',
          apiVersion: 'v1alpha1',
          kind: 'EmptyApp',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        () => ({}),
        (_schema, _resources) => ({
          ready: false,
        })
      );

      expect(() => graph.toYaml()).not.toThrow();

      const yaml = graph.toYaml();
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
    });
  });
});
