import { describe, expect, it } from 'bun:test';
import { kustomizationReadinessEvaluator } from '../../src/factories/flux/kustomize/readiness-evaluators.js';

describe('Kustomize Readiness Evaluators', () => {
  describe('kustomizationReadinessEvaluator', () => {
    it('should return not ready when status is missing', () => {
      const liveResource = {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
        kind: 'Kustomization',
        metadata: { name: 'test-kustomization' },
      };

      const result = kustomizationReadinessEvaluator(liveResource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StatusMissing');
      expect(result.message).toBe('Kustomization status not available yet');
    });

    it('should return not ready when conditions are missing', () => {
      const liveResource = {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
        kind: 'Kustomization',
        metadata: { name: 'test-kustomization' },
        status: {},
      };

      const result = kustomizationReadinessEvaluator(liveResource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ConditionsMissing');
      expect(result.message).toBe('Kustomization conditions not available');
    });

    it('should return not ready when Ready condition is missing', () => {
      const liveResource = {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
        kind: 'Kustomization',
        metadata: { name: 'test-kustomization' },
        status: {
          conditions: [
            {
              type: 'Reconciling',
              status: 'True',
              reason: 'Progressing',
              message: 'Reconciliation in progress',
            },
          ],
        },
      };

      const result = kustomizationReadinessEvaluator(liveResource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ReadyConditionMissing');
      expect(result.message).toBe('Ready condition not found in Kustomization status');
    });

    it('should return not ready when Ready condition is False', () => {
      const liveResource = {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
        kind: 'Kustomization',
        metadata: { name: 'test-kustomization' },
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'False',
              reason: 'BuildFailed',
              message: 'Kustomization build failed',
            },
          ],
        },
      };

      const result = kustomizationReadinessEvaluator(liveResource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('BuildFailed');
      expect(result.message).toBe('Kustomization build failed');
    });

    it('should return not ready when Healthy condition is False', () => {
      const liveResource = {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
        kind: 'Kustomization',
        metadata: { name: 'test-kustomization' },
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'True',
              reason: 'ReconciliationSucceeded',
              message: 'Applied revision: main@sha1:abc123',
            },
            {
              type: 'Healthy',
              status: 'False',
              reason: 'HealthCheckFailed',
              message: 'Health check failed for Deployment/webapp',
            },
          ],
        },
      };

      const result = kustomizationReadinessEvaluator(liveResource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('HealthCheckFailed');
      expect(result.message).toBe('Health check failed for Deployment/webapp');
    });

    it('should return not ready when no resources have been applied', () => {
      const liveResource = {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
        kind: 'Kustomization',
        metadata: { name: 'test-kustomization' },
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'True',
              reason: 'ReconciliationSucceeded',
              message: 'Applied revision: main@sha1:abc123',
            },
          ],
          inventory: {
            entries: [],
          },
        },
      };

      const result = kustomizationReadinessEvaluator(liveResource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('NoResourcesApplied');
      expect(result.message).toBe('No resources have been applied by this Kustomization');
    });

    it('should return ready when all conditions are met', () => {
      const liveResource = {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
        kind: 'Kustomization',
        metadata: { name: 'test-kustomization' },
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'True',
              reason: 'ReconciliationSucceeded',
              message: 'Applied revision: main@sha1:abc123',
            },
            {
              type: 'Healthy',
              status: 'True',
              reason: 'HealthCheckSucceeded',
              message: 'All resources are healthy',
            },
          ],
          inventory: {
            entries: [
              { id: 'apps_v1_Deployment_default_webapp', v: 'v1' },
              { id: 'v1_Service_default_webapp', v: 'v1' },
            ],
          },
        },
      };

      const result = kustomizationReadinessEvaluator(liveResource);

      expect(result.ready).toBe(true);
      expect(result.message).toBe('Kustomization is ready with 2 applied resources');
    });

    it('should return ready when Ready is True and Healthy condition is not present', () => {
      const liveResource = {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
        kind: 'Kustomization',
        metadata: { name: 'test-kustomization' },
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'True',
              reason: 'ReconciliationSucceeded',
              message: 'Applied revision: main@sha1:abc123',
            },
          ],
          inventory: {
            entries: [{ id: 'apps_v1_Deployment_default_webapp', v: 'v1' }],
          },
        },
      };

      const result = kustomizationReadinessEvaluator(liveResource);

      expect(result.ready).toBe(true);
      expect(result.message).toBe('Kustomization is ready with 1 applied resources');
    });

    it('should handle evaluation errors gracefully', () => {
      const liveResource = null;

      const result = kustomizationReadinessEvaluator(liveResource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('EvaluationError');
      expect(result.message).toContain('Error evaluating Kustomization readiness');
    });

    it('should handle malformed conditions gracefully', () => {
      const liveResource = {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
        kind: 'Kustomization',
        metadata: { name: 'test-kustomization' },
        status: {
          conditions: 'not-an-array', // Invalid conditions
        },
      };

      const result = kustomizationReadinessEvaluator(liveResource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ConditionsMissing');
      expect(result.message).toBe('Kustomization conditions not available');
    });

    it('should handle Ready condition without reason or message', () => {
      const liveResource = {
        apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
        kind: 'Kustomization',
        metadata: { name: 'test-kustomization' },
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'False',
              // No reason or message
            },
          ],
        },
      };

      const result = kustomizationReadinessEvaluator(liveResource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('NotReady');
      expect(result.message).toBe('Kustomization is not ready');
    });
  });
});
