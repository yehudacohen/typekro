/**
 * Tests for proper status field generation with CEL expressions
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import {
  Cel,
  simpleConfigMap,
  simpleDeployment,
  simpleService,
  toResourceGraph,
} from '../../src/index.js';

describe('Status Field Generation', () => {
  const WebAppSpecSchema = type({
    name: 'string',
    image: 'string',
    replicas: 'number%1',
  });

  const WebAppStatusSchema = type({
    url: 'string',
    readyReplicas: 'number%1',
    conditions: 'string[]',
  });

  describe('CEL expression generation', () => {
    it('should generate CEL expressions for status fields based on available resources', () => {
      const graph = toResourceGraph(
        {
          name: 'webapp-with-status',
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
            name: schema.spec.name,
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: 3000 }],
            id: 'webappService',
          }),
        }),
        (_schema, resources) => ({
          readyReplicas: resources.deployment?.status.readyReplicas,
          url: Cel.template('http://%s', resources.service?.status.loadBalancer?.ingress?.[0]?.ip),
          conditions: Cel.expr<string[]>(
            resources.deployment?.status.conditions,
            '.map(c, c.type)'
          ),
        })
      );

      const yaml = graph.toYaml();

      // Should contain CEL expressions for status fields, not type definitions
      expect(yaml).toContain('readyReplicas: ${webappDeployment.status.readyReplicas}');
      expect(yaml).toContain('url: http://${webappService.status.loadBalancer.ingress.0.ip}');
      expect(yaml).toContain('conditions: ${webappDeployment.status.conditions.map(c, c.type)}');

      // Should not contain type definitions for user status fields
      expect(yaml).not.toContain('readyReplicas: integer');
      expect(yaml).not.toContain('conditions: string[]');
      expect(yaml).not.toContain('url: string');

      // Should not contain default Kro status fields (these are auto-injected by Kro)
      expect(yaml).not.toContain('phase: string');
      expect(yaml).not.toContain('message: string');
      expect(yaml).not.toContain('observedGeneration: integer');
    });

    it('should map common status field names to appropriate resources', () => {
      const graph = toResourceGraph(
        {
          name: 'deployment-status-test',
          apiVersion: 'v1alpha1',
          kind: 'DeploymentApp',
          spec: WebAppSpecSchema,
          status: type({
            availableReplicas: 'number%1',
            deploymentConditions: 'string[]',
            replicas: 'number%1',
          }),
        },
        (schema) => ({
          webDeployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webDeployment',
          }),
        }),
        (_schema, resources) => ({
          availableReplicas: resources.webDeployment?.status.availableReplicas,
          deploymentConditions: Cel.expr<string[]>(
            resources.webDeployment?.status.conditions,
            '.map(c, c.type)'
          ),
          replicas: resources.webDeployment?.status.replicas,
        })
      );

      const yaml = graph.toYaml();

      // Should map to deployment status fields
      expect(yaml).toContain('availableReplicas: ${webDeployment.status.availableReplicas}');
      expect(yaml).toContain(
        'deploymentConditions: ${webDeployment.status.conditions.map(c, c.type)}'
      );
      expect(yaml).toContain('replicas: ${webDeployment.status.replicas}');
    });

    it('should handle service endpoint status fields', () => {
      const graph = toResourceGraph(
        {
          name: 'service-status-test',
          apiVersion: 'v1alpha1',
          kind: 'ServiceApp',
          spec: WebAppSpecSchema,
          status: type({
            endpoint: 'string',
            serviceEndpoint: 'string',
            url: 'string',
          }),
        },
        (schema) => ({
          webService: simpleService({
            name: schema.spec.name,
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: 3000 }],
            id: 'webService',
          }),
        }),
        (_schema, resources) => ({
          endpoint: resources.webService.status.loadBalancer.ingress?.[0]?.ip,
          serviceEndpoint: resources.webService.status.loadBalancer.ingress?.[0]?.hostname,
          url: Cel.template('http://%s', resources.webService?.metadata?.name),
        })
      );

      const yaml = graph.toYaml();

      // Should map to service status fields
      expect(yaml).toContain('endpoint: ${webService.status.loadBalancer.ingress.0.ip}');
      expect(yaml).toContain(
        'serviceEndpoint: ${webService.status.loadBalancer.ingress.0.hostname}'
      );
      expect(yaml).toContain('url: http://${schema.spec.name}');
    });

    it('should handle mixed resource types correctly', () => {
      const graph = toResourceGraph(
        {
          name: 'mixed-resources-test',
          apiVersion: 'v1alpha1',
          kind: 'MixedApp',
          spec: WebAppSpecSchema,
          status: type({
            readyReplicas: 'number%1',
            url: 'string',
            customField: 'string',
          }),
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'appDeployment',
          }),
          service: simpleService({
            name: schema.spec.name,
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: 3000 }],
            id: 'appService',
          }),
        }),
        (_schema, resources) => ({
          readyReplicas: resources.deployment?.status.readyReplicas,
          url: resources.service.status.loadBalancer?.ingress?.[0]?.ip,
          customField: 'custom-value',
        })
      );

      const yaml = graph.toYaml();

      // Should map deployment fields to deployment
      expect(yaml).toContain('readyReplicas: ${appDeployment.status.readyReplicas}');

      // Should map service fields to service
      expect(yaml).toContain('url: ${appService.status.loadBalancer.ingress.0.ip}');

      // Static fields should NOT be in the YAML (they're hydrated directly by TypeKro)
      expect(yaml).not.toContain('customField:');
    });

    it('should provide fallback for resources without matching types', () => {
      const graph = toResourceGraph(
        {
          name: 'fallback-test',
          apiVersion: 'v1alpha1',
          kind: 'ConfigApp',
          spec: type({ name: 'string' }),
          status: type({
            readyReplicas: 'number%1',
            url: 'string',
          }),
        },
        () => ({
          // No deployment or service, just a config map
          configMap: simpleConfigMap({
            name: 'test-config',
            id: 'testConfig',
            data: { key: 'value' },
          }),
        }),
        (_schema, _resources) => ({
          readyReplicas: 0,
          url: '',
        })
      );

      const yaml = graph.toYaml();

      // Static fallback values should NOT be in the YAML (they're hydrated directly by TypeKro)
      expect(yaml).not.toContain('readyReplicas:');
      expect(yaml).not.toContain('url:');
    });
  });

  // Note: Backward compatibility test removed - automatic schema reference fallbacks
  // are no longer supported. Status fields must be explicitly defined in status builders.
});
