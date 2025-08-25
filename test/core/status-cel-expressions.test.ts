/**
 * Tests for status CEL expression generation
 *
 * This test file validates that status fields in Kro schemas are correctly
 * mapped to CEL expressions that reference actual Kubernetes resource fields.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { Cel, toResourceGraph, simple } from '../../src/index.js';

describe('Status CEL Expression Generation', () => {
  it('should generate correct CEL expressions for deployment readiness', () => {
    const WebAppSpecSchema = type({
      name: 'string',
      image: 'string',
      replicas: 'number%1',
    });

    const WebAppStatusSchema = type({
      ready: 'boolean',
      url: 'string',
    });

    const graph = toResourceGraph(
      {
        name: 'test-webapp',
        apiVersion: 'v1alpha1',
        kind: 'TestWebApp',
        spec: WebAppSpecSchema,
        status: WebAppStatusSchema,
      },
      (schema) => ({
        webappDeployment: simple.Deployment({
          id: 'webappDeployment',
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: schema.spec.replicas,
        }),
        webappService: simple.Service({
          id: 'webappService',
          name: 'webapp-service',
          selector: { app: schema.spec.name },
          ports: [{ port: 80, targetPort: 3000 }],
          type: 'ClusterIP',
        }),
      }),
      (_schema, resources) => ({
        ready: Cel.expr<boolean>(resources.webappDeployment.status.readyReplicas, ' > 0'),
        url: `http://webapp-service`,
      })
    );

    const yaml = graph.toYaml();

    // Verify that the status expressions use the correct resource IDs
    expect(yaml).toContain('webappDeployment.status.readyReplicas > 0');
    // Static URL should NOT be in YAML (it's hydrated directly by TypeKro)
    expect(yaml).not.toContain('http://webapp-service');

    // Verify that the expressions don't use generic names like 'deployment' or 'service'
    expect(yaml).not.toContain('deployment.status.ready');
    expect(yaml).not.toContain('service.status.loadBalancer');
  });

  it('should handle different resource types correctly', () => {
    const AppSpecSchema = type({
      name: 'string',
      image: 'string',
    });

    const AppStatusSchema = type({
      replicas: 'number',
      availableReplicas: 'number',
    });

    const graph = toResourceGraph(
      {
        name: 'test-app',
        apiVersion: 'v1alpha1',
        kind: 'TestApp',
        spec: AppSpecSchema,
        status: AppStatusSchema,
      },
      (schema) => ({
        myDeployment: simple.Deployment({
          id: 'myDeployment',
          name: schema.spec.name,
          image: schema.spec.image,
        }),
      }),
      (_schema, resources) => ({
        replicas: resources.myDeployment.status.replicas,
        availableReplicas: resources.myDeployment.status.availableReplicas,
      })
    );

    const yaml = graph.toYaml();

    // Verify that status expressions use the correct resource ID
    expect(yaml).toContain('myDeployment.status.replicas');
    expect(yaml).toContain('myDeployment.status.availableReplicas');
  });

  it('should generate valid Kro ResourceGraphDefinition structure', () => {
    const SimpleSpecSchema = type({
      name: 'string',
    });

    const SimpleStatusSchema = type({
      ready: 'boolean',
    });

    const graph = toResourceGraph(
      {
        name: 'simple-app',
        apiVersion: 'v1alpha1',
        kind: 'SimpleApp',
        spec: SimpleSpecSchema,
        status: SimpleStatusSchema,
      },
      (schema) => ({
        deployment: simple.Deployment({
          id: 'deployment',
          name: schema.spec.name,
          image: 'nginx',
        }),
      }),
      (_schema, resources) => ({
        ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
      })
    );

    const yaml = graph.toYaml();

    // Verify basic RGD structure
    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: simple-app');

    // Verify schema structure
    expect(yaml).toContain('kind: SimpleApp');
    expect(yaml).toContain('apiVersion: v1alpha1');

    // Verify resources structure
    expect(yaml).toContain('- id: deployment');
    expect(yaml).toContain('template:');

    // Verify status CEL expression
    expect(yaml).toContain('ready: ${deployment.status.readyReplicas > 0}');
  });
});
