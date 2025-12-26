/**
 * Comprehensive tests for the new toResourceGraph API with separate ResourceBuilder and StatusBuilder
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { Cel, toResourceGraph, simple } from '../../src/index.js';

describe('New toResourceGraph API with StatusBuilder', () => {
  const WebAppSpecSchema = type({
    name: 'string',
    image: 'string',
    replicas: 'number%1',
    environment: '"dev" | "staging" | "prod"',
  });

  const WebAppStatusSchema = type({
    url: 'string',
    readyReplicas: 'number%1',
    phase: '"pending" | "running" | "failed"',
    healthy: 'boolean',
  });

  describe('definition-first parameter', () => {
    it('should accept ResourceGraphDefinition as first parameter', () => {
      const graph = toResourceGraph(
        {
          name: 'webapp-definition-first',
          apiVersion: 'example.com/v1alpha1',
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
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
          healthy: true,
        })
      );

      expect(graph.name).toBe('webapp-definition-first');
      expect(graph.resources).toHaveLength(1);
    });

    it('should extract name from definition object', () => {
      const graph = toResourceGraph(
        {
          name: 'extracted-name-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'TestApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        () => ({}),
        () => ({
          url: 'http://test.com',
          readyReplicas: 0,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'pending'`,
          healthy: false,
        })
      );

      expect(graph.name).toBe('extracted-name-test');
    });
  });

  describe('separate ResourceBuilder and StatusBuilder', () => {
    it('should use ResourceBuilder for defining resources', () => {
      const graph = toResourceGraph(
        {
          name: 'resource-builder-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        // ResourceBuilder - defines Kubernetes resources
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          }),
          service: simple.Service({
            name: schema.spec.name,
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: 3000 }],
            id: 'webappService',
          }),
        }),
        // StatusBuilder - defines status field mappings
        (_schema, resources) => ({
          url: resources.service.status.loadBalancer.ingress?.[0]?.hostname || 'http://pending',
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
          healthy: true,
        })
      );

      expect(graph.resources).toHaveLength(2);
      expect(graph.resources.some((r) => r.kind === 'Deployment')).toBe(true);
      expect(graph.resources.some((r) => r.kind === 'Service')).toBe(true);
    });

    it('should use StatusBuilder for defining status mappings', () => {
      const graph = toResourceGraph(
        {
          name: 'status-builder-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'statusBuilderDeployment',
          }),
        }),
        // StatusBuilder receives both schema and resources
        (schema, resources) => {
          // Should have access to schema
          expect(schema.spec.name).toBeDefined();

          // Should have access to resources from ResourceBuilder
          expect(resources.deployment).toBeDefined();

          return {
            url: `http://status-builder-test.example.com`,
            readyReplicas: resources.deployment.status.readyReplicas,
            phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
            healthy: true,
          };
        }
      );

      expect(graph.name).toBe('status-builder-test');
    });
  });

  describe('status field mapping types', () => {
    it('should support simple string values', () => {
      const graph = toResourceGraph(
        {
          name: 'simple-string-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'simpleStringDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: 'http://simple-string.com', // Simple string value
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
          healthy: true,
        })
      );

      expect(() => graph.toYaml()).not.toThrow();
    });

    it('should support resource references', () => {
      const graph = toResourceGraph(
        {
          name: 'resource-ref-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'resourceRefDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: 'http://example.com',
          readyReplicas: resources.deployment.status.readyReplicas, // Resource reference
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
          healthy: true,
        })
      );

      expect(() => graph.toYaml()).not.toThrow();
    });

    it('should support CEL expressions', () => {
      const graph = toResourceGraph(
        {
          name: 'cel-expression-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'celExpressionDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: Cel.expr<string>('"http://" + ${celExpressionDeployment.status.loadBalancer.ingress[0].ip}'),
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
          healthy: Cel.expr<boolean>('${celExpressionDeployment.status.readyReplicas} > 0'), // CEL expression
        })
      );

      expect(() => graph.toYaml()).not.toThrow();
    });
  });

  describe('nested status objects', () => {
    it('should support nested status structures', () => {
      const NestedStatusSchema = type({
        app: {
          url: 'string',
          replicas: 'number%1',
        },
        infrastructure: {
          database: 'boolean',
          cache: 'boolean',
        },
        conditions: 'string[]',
      });

      const graph = toResourceGraph(
        {
          name: 'nested-status-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'ComplexApp',
          spec: WebAppSpecSchema,
          status: NestedStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'nestedStatusDeployment',
          }),
        }),
        (_schema, resources) => ({
          app: {
            url: 'http://nested.example.com',
            replicas: resources.deployment.status.readyReplicas,
          },
          infrastructure: {
            database: true,
            cache: true,
          },
          conditions: ['Ready', 'Available'],
        })
      );

      expect(() => graph.toYaml()).not.toThrow();
      expect(graph.name).toBe('nested-status-test');
    });
  });

  describe('type safety validation', () => {
    it('should maintain type safety without type assertions', () => {
      // This test validates that the new API works without any 'as any' casts
      const graph = toResourceGraph(
        {
          name: 'type-safety-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => {
          // These should all be properly typed as KubernetesRef<T>
          const name = schema.spec.name;
          const image = schema.spec.image;
          const replicas = schema.spec.replicas;
          const environment = schema.spec.environment;

          return {
            deployment: simple.Deployment({
              name,
              image,
              replicas,
              env: {
                NODE_ENV: environment,
              },
              id: 'typeSafetyDeployment',
            }),
          };
        },
        (_schema, resources) => {
          // StatusBuilder should have proper types too
          const deploymentStatus = resources.deployment.status.readyReplicas;

          return {
            url: 'http://type-safe.com',
            readyReplicas: deploymentStatus,
            phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
            healthy: true,
          };
        }
      );

      expect(graph).toBeDefined();
      expect(graph.resources).toHaveLength(1);
    });
  });

  describe('YAML generation with status mappings', () => {
    it('should generate proper CEL expressions in YAML', () => {
      const graph = toResourceGraph(
        {
          name: 'yaml-cel-test',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'yamlCelDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: 'http://yaml-test.com',
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
          healthy: true,
        })
      );

      const yaml = graph.toYaml();

      // Should contain the ResourceGraphDefinition structure
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('name: yaml-cel-test');

      // Should contain status field definitions
      expect(yaml).toContain('status:');
    });
  });
});
