/**
 * Integration test for Kro factory functions working together
 */

import { describe, expect, it } from 'bun:test';
import { resourceGraphDefinition, kroCustomResource, kroCustomResourceDefinition } from '../../src/factories/kro/index.js';

describe('Kro Factory Integration', () => {
  it('should demonstrate complete Kro workflow with all factory types', () => {
    // 1. Create a ResourceGraphDefinition
    const rgd = resourceGraphDefinition({
      metadata: { name: 'webapp-stack', namespace: 'default' },
      spec: {
        schema: {
          apiVersion: 'v1alpha1',
          kind: 'WebApplication',
          spec: {
            name: 'string',
            replicas: 'number'
          },
          status: {
            url: 'string',
            ready: 'boolean'
          }
        },
        resources: [
          {
            id: 'deployment',
            template: {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              metadata: { name: '${schema.spec.name}' },
              spec: { replicas: '${schema.spec.replicas}' }
            }
          }
        ]
      }
    });

    // 2. Create the corresponding CRD
    const crd = kroCustomResourceDefinition({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'webapplications.kro.run' },
      spec: {
        group: 'kro.run',
        versions: [{
          name: 'v1alpha1',
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: {
              type: 'object',
              properties: {
                spec: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    replicas: { type: 'number' }
                  }
                },
                status: {
                  type: 'object',
                  properties: {
                    url: { type: 'string' },
                    ready: { type: 'boolean' }
                  }
                }
              }
            }
          }
        }],
        scope: 'Namespaced',
        names: {
          plural: 'webapplications',
          singular: 'webapplication',
          kind: 'WebApplication'
        }
      }
    });

    // 3. Create a custom resource instance
    interface WebAppSpec {
      name: string;
      replicas: number;
    }
    
    interface WebAppStatus {
      url: string;
      ready: boolean;
    }

    const webappInstance = kroCustomResource<WebAppSpec, WebAppStatus>({
      apiVersion: 'kro.run/v1alpha1',
      kind: 'WebApplication',
      metadata: { name: 'my-webapp', namespace: 'default' },
      spec: { name: 'my-webapp', replicas: 3 }
    });

    // Verify all resources are created with readiness evaluators
    expect((rgd as any).readinessEvaluator).toBeDefined();
    expect((crd as any).readinessEvaluator).toBeDefined();
    expect((webappInstance as any).readinessEvaluator).toBeDefined();

    // Test the complete workflow readiness evaluation
    
    // 1. RGD should be ready when state is Active with proper conditions
    const rgdResult = (rgd as any).readinessEvaluator({
      status: {
        state: 'Active',
        conditions: [
          { type: 'ReconcilerReady', status: 'True' },
          { type: 'GraphVerified', status: 'True' },
          { type: 'CustomResourceDefinitionSynced', status: 'True' }
        ]
      }
    });
    expect(rgdResult.ready).toBe(true);

    // 2. CRD should be ready when established
    const crdResult = (crd as any).readinessEvaluator({
      metadata: { name: 'webapplications.kro.run' },
      status: {
        conditions: [
          { type: 'Established', status: 'True' },
          { type: 'NamesAccepted', status: 'True' }
        ]
      }
    });
    expect(crdResult.ready).toBe(true);

    // 3. Custom resource instance should be ready when ACTIVE
    const instanceResult = (webappInstance as any).readinessEvaluator({
      status: {
        state: 'ACTIVE',
        conditions: [{ type: 'Ready', status: 'True' }],
        // User-defined status fields
        url: 'https://my-webapp.example.com',
        ready: true
      }
    });
    expect(instanceResult.ready).toBe(true);

    // Verify type safety - the webapp instance should have proper typing
    expect(webappInstance.apiVersion).toBe('kro.run/v1alpha1');
    expect(webappInstance.kind).toBe('WebApplication');
    
    // All resources should exclude evaluators from serialization
    const resources = { rgd, crd, webappInstance };
    Object.values(resources).forEach(resource => {
      expect(Object.keys(resource)).not.toContain('readinessEvaluator');
      expect(JSON.stringify(resource)).not.toContain('readinessEvaluator');
    });
  });

  it('should handle error scenarios across all Kro factory types', () => {
    const rgd = resourceGraphDefinition({
      metadata: { name: 'test-rgd' },
      spec: { schema: { apiVersion: 'v1alpha1', kind: 'TestResource' }, resources: [] }
    });

    const customResource = kroCustomResource({
      apiVersion: 'kro.run/v1alpha1',
      kind: 'TestResource',
      metadata: { name: 'test-resource' },
      spec: { test: true }
    });

    const crd = kroCustomResourceDefinition({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'testresources.kro.run' },
      spec: {
        group: 'kro.run',
        versions: [{ name: 'v1alpha1', served: true, storage: true }],
        scope: 'Namespaced',
        names: { plural: 'testresources', singular: 'testresource', kind: 'TestResource' }
      }
    });

    // Test error handling for all factory types
    const rgdError = (rgd as any).readinessEvaluator(null);
    const customResourceError = (customResource as any).readinessEvaluator(null);
    const crdError = (crd as any).readinessEvaluator(null);

    // All should handle errors gracefully
    expect(rgdError.ready).toBe(false);
    expect(rgdError.reason).toBe('ResourceNotFound');
    
    expect(customResourceError.ready).toBe(false);
    expect(customResourceError.reason).toBe('EvaluationError');
    
    expect(crdError.ready).toBe(false);
    expect(crdError.reason).toBe('EvaluationError');

    // Error details should be present for evaluation errors
    expect(crdError.details?.error).toBeDefined();
    expect(customResourceError.details?.error).toBeDefined();
    expect(crdError.details?.error).toBeDefined();
  });

  it('should demonstrate different readiness states in a realistic scenario', () => {
    // Simulate a realistic Kro deployment scenario
    
    // 1. RGD is created but not yet ready
    const rgd = resourceGraphDefinition({
      metadata: { name: 'webapp-stack' },
      spec: { schema: { apiVersion: 'v1alpha1', kind: 'WebApp' }, resources: [] }
    });

    let rgdStatus = (rgd as any).readinessEvaluator({
      status: { state: 'processing', conditions: [] }
    });
    expect(rgdStatus.ready).toBe(false);
    expect(rgdStatus.message).toContain('current state: processing');

    // 2. CRD is being established
    const crd = kroCustomResourceDefinition({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'webapps.kro.run' },
      spec: {
        group: 'kro.run',
        versions: [{ name: 'v1alpha1', served: true, storage: true }],
        scope: 'Namespaced',
        names: { plural: 'webapps', singular: 'webapp', kind: 'WebApp' }
      }
    });

    let crdStatus = (crd as any).readinessEvaluator({
      metadata: { name: 'webapps.kro.run' },
      status: {
        conditions: [
          { type: 'Established', status: 'False', reason: 'Installing' },
          { type: 'NamesAccepted', status: 'True' }
        ]
      }
    });
    expect(crdStatus.ready).toBe(false);
    expect(crdStatus.message).toContain('Established: False');

    // 3. Custom resource instance is progressing
    const webapp = kroCustomResource({
      apiVersion: 'kro.run/v1alpha1',
      kind: 'WebApp',
      metadata: { name: 'my-webapp' },
      spec: { name: 'my-webapp', replicas: 2 }
    });

    let webappStatus = (webapp as any).readinessEvaluator({
      status: {
        state: 'PROGRESSING',
        conditions: [{ type: 'Ready', status: 'False', reason: 'CreatingResources' }]
      }
    });
    expect(webappStatus.ready).toBe(false);
    expect(webappStatus.reason).toBe('KroInstanceProgressing');

    // 4. Now everything becomes ready
    
    // RGD becomes ready
    rgdStatus = (rgd as any).readinessEvaluator({
      status: {
        state: 'Active',
        conditions: [
          { type: 'ReconcilerReady', status: 'True' },
          { type: 'GraphVerified', status: 'True' },
          { type: 'CustomResourceDefinitionSynced', status: 'True' }
        ]
      }
    });
    expect(rgdStatus.ready).toBe(true);

    // CRD becomes established
    crdStatus = (crd as any).readinessEvaluator({
      metadata: { name: 'webapps.kro.run' },
      status: {
        conditions: [
          { type: 'Established', status: 'True' },
          { type: 'NamesAccepted', status: 'True' }
        ]
      }
    });
    expect(crdStatus.ready).toBe(true);

    // Custom resource becomes active
    webappStatus = (webapp as any).readinessEvaluator({
      status: {
        state: 'ACTIVE',
        conditions: [{ type: 'Ready', status: 'True' }],
        observedGeneration: 1
      }
    });
    expect(webappStatus.ready).toBe(true);
    expect(webappStatus.message).toContain('WebApp instance is active');
  });
});