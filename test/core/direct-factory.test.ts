/**
 * Unit tests for DirectResourceFactory implementation
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { toResourceGraph, simpleDeployment, simpleService, Cel } from '../../src/index.js';

describe('DirectResourceFactory', () => {
  const WebAppSpecSchema = type({
    name: 'string',
    image: 'string',
    replicas: 'number%1',
    port: 'number%1',
  });

  const WebAppStatusSchema = type({
    phase: '"pending" | "running" | "failed"',
    url: 'string',
    readyReplicas: 'number%1',
  });

  type WebAppSpec = typeof WebAppSpecSchema.infer;
  // type WebAppStatus = typeof WebAppStatusSchema.infer; // Unused for now

  describe('Factory Creation', () => {
    it('should create DirectResourceFactory with correct properties', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-webapp',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          }),
          service: simpleService({
            name: Cel.template('%s-service', schema.spec.name),
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: schema.spec.port }],
            id: 'webappService',
          }),
        }),
        (_schema, resources) => ({
          readyReplicas: resources.deployment?.status.readyReplicas,
          url: 'http://webapp-service',
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct', {
        namespace: 'test-namespace',
        timeout: 30000,
        waitForReady: true,
      });

      expect(factory.mode).toBe('direct');
      expect(factory.name).toBe('test-webapp');
      expect(factory.namespace).toBe('test-namespace');
      expect(factory.isAlchemyManaged).toBe(false);
    });

    it('should create factory with default options', async () => {
      const graph = toResourceGraph(
        {
          name: 'simple-app',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'appDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.status.podIP}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct');

      expect(factory.mode).toBe('direct');
      expect(factory.name).toBe('simple-app');
      expect(factory.namespace).toBe('default');
      expect(factory.isAlchemyManaged).toBe(false);
    });
  });

  describe('YAML Generation', () => {
    it('should generate YAML for instance deployment', async () => {
      const graph = toResourceGraph(
        {
          name: 'yaml-test',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'testDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.status.podIP}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct', { namespace: 'production' });

      const spec: WebAppSpec = {
        name: 'my-app',
        image: 'nginx:latest',
        replicas: 3,
        port: 8080,
      };

      const yaml = factory.toYaml(spec);

      // DirectResourceFactory.toYaml() should generate individual Kubernetes manifests, not RGD
      expect(yaml).toContain('apiVersion: apps/v1');
      expect(yaml).toContain('kind: Deployment');
      expect(yaml).toContain('name: my-app');
      expect(typeof yaml).toBe('string');
      expect(yaml.length).toBeGreaterThan(0);
    });

    it('should generate consistent YAML for same spec', async () => {
      const graph = toResourceGraph(
        {
          name: 'consistency-test',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'consistentDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.status.podIP}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct');

      const spec: WebAppSpec = {
        name: 'test-app',
        image: 'nginx:1.21',
        replicas: 2,
        port: 3000,
      };

      const yaml1 = factory.toYaml(spec);
      const yaml2 = factory.toYaml(spec);

      expect(yaml1).toBe(yaml2);
    });
  });

  describe('Factory Status', () => {
    it('should return factory status', async () => {
      const graph = toResourceGraph(
        {
          name: 'status-test',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'statusDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.status.podIP}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct', { namespace: 'test' });
      const status = await factory.getStatus();

      expect(status.name).toBe('status-test');
      expect(status.mode).toBe('direct');
      expect(status.isAlchemyManaged).toBe(false);
      expect(status.namespace).toBe('test');
      expect(status.instanceCount).toBe(0); // No instances deployed yet
      expect(status.health).toBe('healthy');
    });
  });

  describe('Instance Management', () => {
    it('should return empty instances list initially', async () => {
      const graph = toResourceGraph(
        {
          name: 'instances-test',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'instancesDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.status.podIP}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct');
      const instances = await factory.getInstances();

      expect(instances).toEqual([]);
    });

    it('should throw error for unimplemented deleteInstance', async () => {
      const graph = toResourceGraph(
        {
          name: 'delete-test',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'deleteDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.status.podIP}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const factory = await graph.factory('direct');

      await expect(factory.deleteInstance('test-instance')).rejects.toThrow(
        'Instance not found: test-instance'
      );
    });
  });

  describe('Deterministic Behavior', () => {
    it('should create identical factories from same resource graph', async () => {
      const createGraph = () => toResourceGraph(
        {
          name: 'deterministic-test',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'deterministicDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.status.podIP}`,
          readyReplicas: resources.deployment.status.readyReplicas,
          phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
        })
      );

      const graph1 = createGraph();
      const graph2 = createGraph();

      const factory1 = await graph1.factory('direct', { namespace: 'test' });
      const factory2 = await graph2.factory('direct', { namespace: 'test' });

      expect(factory1.name).toBe(factory2.name);
      expect(factory1.namespace).toBe(factory2.namespace);
      expect(factory1.mode).toBe(factory2.mode);
      expect(factory1.isAlchemyManaged).toBe(factory2.isAlchemyManaged);

      // YAML generation should also be identical
      const spec: WebAppSpec = {
        name: 'test-app',
        image: 'nginx:latest',
        replicas: 1,
        port: 8080,
      };

      const yaml1 = factory1.toYaml(spec);
      const yaml2 = factory2.toYaml(spec);

      expect(yaml1).toBe(yaml2);
    });
  });
});