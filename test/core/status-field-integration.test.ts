/**
 * Integration test to verify status field generation produces correct Kro YAML
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { Cel, toResourceGraph, simple } from '../../src/index.js';

describe('Status Field Integration', () => {
  it('should generate a complete ResourceGraphDefinition with proper status CEL expressions', () => {
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

    const graph = toResourceGraph(
      {
        name: 'webapp-with-status',
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
        service: simple.Service({
          name: schema.spec.name,
          selector: { app: schema.spec.name },
          ports: [{ port: 80, targetPort: 3000 }],
          id: 'webappService',
        }),
      }),
      (_schema, resources) => ({
        url: Cel.template(
          'http://%s.%s.svc.cluster.local',
          resources.service?.metadata?.name,
          resources.service?.metadata?.namespace
        ),
        readyReplicas: resources.deployment?.status.readyReplicas,
        conditions: Cel.expr<string[]>(resources.deployment?.status.conditions, '.map(c, c.type)'),
      })
    );

    const yaml = graph.toYaml();
    console.log('Generated YAML:');
    console.log(yaml);

    // Verify the structure matches Kro expectations
    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: webapp-with-status');

    // Verify schema section has proper status CEL expressions
    expect(yaml).toContain('status:');
    // Should not contain default Kro fields (auto-injected by Kro)
    expect(yaml).not.toContain('phase: string');
    expect(yaml).not.toContain('message: string');
    expect(yaml).not.toContain('observedGeneration: integer');
    // Should contain user-defined status fields as CEL expressions
    expect(yaml).toContain('readyReplicas: ${webappDeployment.status.readyReplicas}');
    expect(yaml).toContain('conditions: ${webappDeployment.status.conditions.map(c, c.type)}');
    expect(yaml).toContain(
      'url: http://${schema.spec.name}.${webappService.metadata.namespace}.svc.cluster.local'
    );

    // Verify resources section
    expect(yaml).toContain('resources:');
    expect(yaml).toContain('id: webappDeployment');
    expect(yaml).toContain('id: webappService');

    // Verify resource templates have proper CEL expressions for cross-references
    expect(yaml).toContain('name: ${schema.spec.name}');
    expect(yaml).toContain('image: ${schema.spec.image}');
    expect(yaml).toContain('replicas: ${schema.spec.replicas}');
  });

  it('should match the format from Kro documentation examples', () => {
    // This test verifies our output matches the format shown in Kro docs
    const AppSpecSchema = type({
      name: 'string',
      image: 'string',
    });

    const AppStatusSchema = type({
      availableReplicas: 'number%1',
      deploymentConditions: 'string[]',
    });

    const graph = toResourceGraph(
      {
        name: 'my-application',
        apiVersion: 'v1alpha1',
        kind: 'Application',
        spec: AppSpecSchema,
        status: AppStatusSchema,
      },
      (schema) => ({
        deployment: simple.Deployment({
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: 3,
          id: 'deployment',
        }),
        service: simple.Service({
          name: schema.spec.name,
          selector: { app: schema.spec.name },
          ports: [{ port: 80, targetPort: 80 }],
          id: 'service',
        }),
      }),
      (_schema, resources) => ({
        availableReplicas: resources.deployment?.status.availableReplicas,
        deploymentConditions: Cel.expr<string[]>(
          resources.deployment?.status.conditions,
          '.map(c, c.type)'
        ),
      })
    );

    const yaml = graph.toYaml();

    // Should match the pattern from Kro documentation:
    // status:
    //   deploymentConditions: ${deployment.status.conditions}
    //   availableReplicas: ${deployment.status.availableReplicas}
    expect(yaml).toContain('deploymentConditions: ${deployment.status.conditions.map(c, c.type)}');
    expect(yaml).toContain('availableReplicas: ${deployment.status.availableReplicas}');

    // Should have proper resource templates
    expect(yaml).toContain('template:');
    expect(yaml).toContain('apiVersion: apps/v1');
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('apiVersion: v1');
    expect(yaml).toContain('kind: Service');
  });
});
