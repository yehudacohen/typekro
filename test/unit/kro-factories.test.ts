/**
 * Test suite for Kro factory functions
 */

import { describe, expect, it } from 'bun:test';
import type { V1CustomResourceDefinition } from '@kubernetes/client-node';
import {
  kroCustomResource,
  kroCustomResourceDefinition,
  resourceGraphDefinition,
} from '../../src/factories/kro/index.js';

describe('Kro Factory Functions', () => {
  describe('resourceGraphDefinition', () => {
    it('should create ResourceGraphDefinition with readiness evaluator', () => {
      const rgd = {
        metadata: { name: 'test-rgd' },
        spec: {
          schema: {
            apiVersion: 'v1alpha1',
            kind: 'TestResource',
          },
          resources: [],
        },
      };

      const enhanced = resourceGraphDefinition(rgd);

      expect(enhanced).toBeDefined();
      expect(enhanced.apiVersion).toBe('kro.run/v1alpha1');
      expect(enhanced.kind).toBe('ResourceGraphDefinition');
      expect((enhanced as any).readinessEvaluator).toBeDefined();
      expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
    });

    it('should evaluate RGD as ready when phase is ready and Ready condition is True', () => {
      const rgd = {
        metadata: { name: 'test-rgd' },
        spec: { schema: { apiVersion: 'v1alpha1', kind: 'TestResource' }, resources: [] },
      };

      const enhanced = resourceGraphDefinition(rgd);
      const evaluator = (enhanced as any).readinessEvaluator;

      const liveRGD = {
        status: {
          state: 'Active',
          conditions: [
            { type: 'ReconcilerReady', status: 'True' },
            { type: 'GraphVerified', status: 'True' },
            { type: 'CustomResourceDefinitionSynced', status: 'True' },
          ],
        },
      };

      const result = evaluator(liveRGD);

      expect(result.ready).toBe(true);
      expect(result.message).toContain('ResourceGraphDefinition is active and ready');
    });

    it('should evaluate RGD as not ready when phase is not ready', () => {
      const rgd = {
        metadata: { name: 'test-rgd' },
        spec: { schema: { apiVersion: 'v1alpha1', kind: 'TestResource' }, resources: [] },
      };

      const enhanced = resourceGraphDefinition(rgd);
      const evaluator = (enhanced as any).readinessEvaluator;

      const liveRGD = {
        status: {
          state: 'processing',
          conditions: [],
        },
      };

      const result = evaluator(liveRGD);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ReconciliationPending');
      expect(result.message).toContain('current state: processing');
      expect(result.details?.state).toBe('processing');
    });

    it('should handle missing status gracefully', () => {
      const rgd = {
        metadata: { name: 'test-rgd' },
        spec: { schema: { apiVersion: 'v1alpha1', kind: 'TestResource' }, resources: [] },
      };

      const enhanced = resourceGraphDefinition(rgd);
      const evaluator = (enhanced as any).readinessEvaluator;

      const result = evaluator({ status: null });

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StatusMissing');
      expect(result.message).toContain('Waiting for Kro controller to initialize status');
    });
  });

  describe('kroCustomResource', () => {
    it('should create Kro custom resource with proper typing', () => {
      interface WebAppSpec {
        name: string;
        replicas: number;
      }

      interface WebAppStatus {
        url: string;
        ready: boolean;
      }

      const resource = {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'WebApplication',
        metadata: { name: 'test-webapp' },
        spec: { name: 'test', replicas: 3 },
      };

      const enhanced = kroCustomResource<WebAppSpec, WebAppStatus>(resource);

      expect(enhanced).toBeDefined();
      expect(enhanced.apiVersion).toBe('kro.run/v1alpha1');
      expect(enhanced.kind).toBe('WebApplication');
      expect((enhanced as any).readinessEvaluator).toBeDefined();
      expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
    });

    it('should evaluate Kro resource as ready when ACTIVE and Ready condition is True', () => {
      const resource = {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'WebApplication',
        metadata: { name: 'test-webapp' },
        spec: { name: 'test', replicas: 3 },
      };

      const enhanced = kroCustomResource(resource);
      const evaluator = (enhanced as any).readinessEvaluator;

      const liveResource = {
        status: {
          state: 'ACTIVE',
          conditions: [{ type: 'Ready', status: 'True', reason: 'AllResourcesReady' }],
          observedGeneration: 1,
        },
      };

      const result = evaluator(liveResource);

      expect(result.ready).toBe(true);
      expect(result.message).toContain('WebApplication instance is active');
    });

    it('should evaluate Kro resource as not ready when PROGRESSING', () => {
      const resource = {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'WebApplication',
        metadata: { name: 'test-webapp' },
        spec: { name: 'test', replicas: 3 },
      };

      const enhanced = kroCustomResource(resource);
      const evaluator = (enhanced as any).readinessEvaluator;

      const liveResource = {
        status: {
          state: 'PROGRESSING',
          conditions: [{ type: 'Ready', status: 'False', reason: 'ResourcesCreating' }],
          observedGeneration: 1,
        },
      };

      const result = evaluator(liveResource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('KroInstanceProgressing');
      expect(result.message).toContain('State: PROGRESSING');
      expect(result.details?.state).toBe('PROGRESSING');
    });

    it('should evaluate Kro resource as failed when FAILED state', () => {
      const resource = {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'WebApplication',
        metadata: { name: 'test-webapp' },
        spec: { name: 'test', replicas: 3 },
      };

      const enhanced = kroCustomResource(resource);
      const evaluator = (enhanced as any).readinessEvaluator;

      const liveResource = {
        status: {
          state: 'FAILED',
          conditions: [
            {
              type: 'Ready',
              status: 'False',
              reason: 'ResourceCreationFailed',
              message: 'Failed to create deployment',
            },
          ],
          observedGeneration: 1,
        },
      };

      const result = evaluator(liveResource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('KroInstanceFailed');
      expect(result.message).toContain('Failed to create deployment');
      expect(result.details?.state).toBe('FAILED');
    });

    it('should handle default resource name', () => {
      const resource = {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'WebApplication',
        metadata: { name: 'test-webapp' },
        spec: { name: 'test', replicas: 3 },
      };

      const enhanced = kroCustomResource(resource);

      // Check that the enhanced resource has the expected structure
      expect(enhanced).toBeDefined();
      expect(enhanced.apiVersion).toBe('kro.run/v1alpha1');
      expect(enhanced.kind).toBe('WebApplication');

      // The metadata should be a proxy, so we check that it exists and has the right structure
      expect(enhanced.metadata).toBeDefined();
      expect(typeof enhanced.metadata).toBe('object');
    });
  });

  describe('kroCustomResourceDefinition', () => {
    it('should create Kro CRD with readiness evaluator', () => {
      const crd: V1CustomResourceDefinition = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'webapplications.kro.run' },
        spec: {
          group: 'kro.run',
          versions: [
            {
              name: 'v1alpha1',
              served: true,
              storage: true,
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  properties: {
                    spec: { type: 'object' },
                    status: { type: 'object' },
                  },
                },
              },
            },
          ],
          scope: 'Namespaced',
          names: {
            plural: 'webapplications',
            singular: 'webapplication',
            kind: 'WebApplication',
          },
        },
      };

      const enhanced = kroCustomResourceDefinition(crd);

      expect(enhanced).toBeDefined();
      expect(enhanced.apiVersion).toBe('apiextensions.k8s.io/v1');
      expect(enhanced.kind).toBe('CustomResourceDefinition');
      expect((enhanced as any).readinessEvaluator).toBeDefined();
      expect(typeof (enhanced as any).readinessEvaluator).toBe('function');
    });

    it('should evaluate Kro CRD as ready when established and names accepted', () => {
      const crd: V1CustomResourceDefinition = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'webapplications.kro.run' },
        spec: {
          group: 'kro.run',
          versions: [{ name: 'v1alpha1', served: true, storage: true }],
          scope: 'Namespaced',
          names: { plural: 'webapplications', singular: 'webapplication', kind: 'WebApplication' },
        },
      };

      const enhanced = kroCustomResourceDefinition(crd);
      const evaluator = (enhanced as any).readinessEvaluator;

      const liveCRD = {
        metadata: { name: 'webapplications.kro.run' },
        status: {
          conditions: [
            { type: 'Established', status: 'True', reason: 'InitialNamesAccepted' },
            { type: 'NamesAccepted', status: 'True', reason: 'NoConflicts' },
          ],
        },
      };

      const result = evaluator(liveCRD);

      expect(result.ready).toBe(true);
      expect(result.message).toContain('webapplications.kro.run is established');
    });

    it('should evaluate non-Kro CRD as not ready', () => {
      const crd: V1CustomResourceDefinition = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'deployments.apps' },
        spec: {
          group: 'apps',
          versions: [{ name: 'v1', served: true, storage: true }],
          scope: 'Namespaced',
          names: { plural: 'deployments', singular: 'deployment', kind: 'Deployment' },
        },
      };

      const enhanced = kroCustomResourceDefinition(crd);
      const evaluator = (enhanced as any).readinessEvaluator;

      const liveCRD = {
        metadata: { name: 'deployments.apps' },
        status: {
          conditions: [
            { type: 'Established', status: 'True', reason: 'InitialNamesAccepted' },
            { type: 'NamesAccepted', status: 'True', reason: 'NoConflicts' },
          ],
        },
      };

      const result = evaluator(liveCRD);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('KroCRDNotReady');
      expect(result.details?.isKroCRD).toBe(false);
    });

    it('should evaluate CRD as not ready when not established', () => {
      const crd: V1CustomResourceDefinition = {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'webapplications.kro.run' },
        spec: {
          group: 'kro.run',
          versions: [{ name: 'v1alpha1', served: true, storage: true }],
          scope: 'Namespaced',
          names: { plural: 'webapplications', singular: 'webapplication', kind: 'WebApplication' },
        },
      };

      const enhanced = kroCustomResourceDefinition(crd);
      const evaluator = (enhanced as any).readinessEvaluator;

      const liveCRD = {
        metadata: { name: 'webapplications.kro.run' },
        status: {
          conditions: [
            { type: 'Established', status: 'False', reason: 'Installing' },
            { type: 'NamesAccepted', status: 'True', reason: 'NoConflicts' },
          ],
        },
      };

      const result = evaluator(liveCRD);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('KroCRDNotReady');
      expect(result.message).toContain('Established: False');
    });
  });

  describe('Serialization Protection', () => {
    it('should exclude readiness evaluators from serialization across all Kro factories', () => {
      const rgd = resourceGraphDefinition({
        metadata: { name: 'test-rgd' },
        spec: { schema: { apiVersion: 'v1alpha1', kind: 'TestResource' }, resources: [] },
      });

      const customResource = kroCustomResource({
        apiVersion: 'kro.run/v1alpha1',
        kind: 'WebApplication',
        metadata: { name: 'test-webapp' },
        spec: { name: 'test', replicas: 3 },
      });

      const crd = kroCustomResourceDefinition({
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'webapplications.kro.run' },
        spec: {
          group: 'kro.run',
          versions: [{ name: 'v1alpha1', served: true, storage: true }],
          scope: 'Namespaced',
          names: { plural: 'webapplications', singular: 'webapplication', kind: 'WebApplication' },
        },
      });

      // All should have readiness evaluators
      expect(typeof (rgd as any).readinessEvaluator).toBe('function');
      expect(typeof (customResource as any).readinessEvaluator).toBe('function');
      expect(typeof (crd as any).readinessEvaluator).toBe('function');

      // None should include evaluators in enumerable properties
      expect(Object.keys(rgd)).not.toContain('readinessEvaluator');
      expect(Object.keys(customResource)).not.toContain('readinessEvaluator');
      expect(Object.keys(crd)).not.toContain('readinessEvaluator');

      // JSON serialization should exclude evaluators
      expect(JSON.stringify(rgd)).not.toContain('readinessEvaluator');
      expect(JSON.stringify(customResource)).not.toContain('readinessEvaluator');
      expect(JSON.stringify(crd)).not.toContain('readinessEvaluator');
    });
  });
});
