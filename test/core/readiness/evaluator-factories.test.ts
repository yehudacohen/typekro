import { describe, expect, it } from 'bun:test';

import {
  createAlwaysReadyEvaluator,
  createConditionBasedReadinessEvaluator,
  createPhaseBasedReadinessEvaluator,
} from '../../../src/core/readiness/evaluator-factories.js';

describe('Readiness Evaluator Factories', () => {
  // ===========================================================================
  // createAlwaysReadyEvaluator
  // ===========================================================================

  describe('createAlwaysReadyEvaluator', () => {
    it('should return ready: true regardless of input', () => {
      const evaluator = createAlwaysReadyEvaluator('ConfigMap');
      const result = evaluator({});
      expect(result.ready).toBe(true);
      expect(result.message).toContain('ConfigMap');
    });

    it('should return ready: true for null/undefined input', () => {
      const evaluator = createAlwaysReadyEvaluator('Secret');
      expect(evaluator(null).ready).toBe(true);
      expect(evaluator(undefined).ready).toBe(true);
    });

    it('should include kind in message', () => {
      const evaluator = createAlwaysReadyEvaluator('ClusterRole');
      const result = evaluator({});
      expect(result.message).toBe('ClusterRole is ready (configuration resource)');
    });
  });

  // ===========================================================================
  // createConditionBasedReadinessEvaluator
  // ===========================================================================

  describe('createConditionBasedReadinessEvaluator', () => {
    const createResource = (
      conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>
    ) => ({
      status: conditions !== undefined ? { conditions } : undefined,
    });

    it('should return not ready when status is missing', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'ClusterIssuer' });
      const result = evaluator({});
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StatusMissing');
      expect(result.message).toContain('ClusterIssuer');
    });

    it('should return not ready when status is null', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'Issuer' });
      const result = evaluator({ status: null });
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StatusMissing');
    });

    it('should return not ready when conditions array is empty', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'Certificate' });
      const result = evaluator(createResource([]));
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ConditionsMissing');
    });

    it('should return not ready when conditions are undefined', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'Certificate' });
      const result = evaluator({ status: {} });
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ConditionsMissing');
    });

    it('should return not ready when Ready condition is missing', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'ClusterIssuer' });
      const result = evaluator(createResource([{ type: 'Healthy', status: 'True' }]));
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('ReadyConditionMissing');
    });

    it('should return ready when Ready condition status is True', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'ClusterIssuer' });
      const result = evaluator(
        createResource([
          { type: 'Ready', status: 'True', message: 'Issuer is ready to issue certificates' },
        ])
      );
      expect(result.ready).toBe(true);
      expect(result.message).toContain('Issuer is ready to issue certificates');
    });

    it('should return not ready when Ready condition status is False', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'Issuer' });
      const result = evaluator(
        createResource([
          { type: 'Ready', status: 'False', reason: 'InvalidConfig', message: 'Missing secret' },
        ])
      );
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('InvalidConfig');
      expect(result.message).toContain('Missing secret');
    });

    it('should use default ready message when condition message is absent', () => {
      const evaluator = createConditionBasedReadinessEvaluator({
        kind: 'GitRepository',
        defaultReadyMessage: 'Repository synced successfully',
      });
      const result = evaluator(createResource([{ type: 'Ready', status: 'True' }]));
      expect(result.ready).toBe(true);
      expect(result.message).toBe('Repository synced successfully');
    });

    it('should fall back to kind-based message when no message or default', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'GitRepository' });
      const result = evaluator(createResource([{ type: 'Ready', status: 'True' }]));
      expect(result.ready).toBe(true);
      expect(result.message).toBe('GitRepository is ready');
    });

    it('should support custom condition type', () => {
      const evaluator = createConditionBasedReadinessEvaluator({
        kind: 'MyResource',
        conditionType: 'Available',
      });
      // Should NOT match 'Ready'
      const resultMissing = evaluator(createResource([{ type: 'Ready', status: 'True' }]));
      expect(resultMissing.ready).toBe(false);
      expect(resultMissing.reason).toBe('AvailableConditionMissing');

      // Should match 'Available'
      const resultFound = evaluator(
        createResource([{ type: 'Available', status: 'True', message: 'All good' }])
      );
      expect(resultFound.ready).toBe(true);
    });

    it('should handle null liveResource gracefully', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'Test' });
      const result = evaluator(null);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StatusMissing');
    });

    it('should use reason from condition when not ready and no message', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'Test' });
      const result = evaluator(
        createResource([{ type: 'Ready', status: 'False', reason: 'Pending' }])
      );
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('Pending');
      // message should fall back to reason
      expect(result.message).toBe('Pending');
    });

    it('should handle Unknown condition status as not ready', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'Test' });
      const result = evaluator(
        createResource([{ type: 'Ready', status: 'Unknown', reason: 'Reconciling' }])
      );
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('Reconciling');
    });
  });

  // ===========================================================================
  // createPhaseBasedReadinessEvaluator
  // ===========================================================================

  describe('createPhaseBasedReadinessEvaluator', () => {
    it('should return not ready when status is missing', () => {
      const evaluator = createPhaseBasedReadinessEvaluator({
        kind: 'Namespace',
        readyPhases: ['Active'],
      });
      const result = evaluator({});
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StatusMissing');
      expect(result.message).toContain('Namespace');
    });

    it('should return ready when phase matches', () => {
      const evaluator = createPhaseBasedReadinessEvaluator({
        kind: 'Namespace',
        readyPhases: ['Active'],
      });
      const result = evaluator({ status: { phase: 'Active' } });
      expect(result.ready).toBe(true);
      expect(result.message).toContain('Active');
    });

    it('should return not ready when phase does not match', () => {
      const evaluator = createPhaseBasedReadinessEvaluator({
        kind: 'Namespace',
        readyPhases: ['Active'],
      });
      const result = evaluator({ status: { phase: 'Terminating' } });
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('PhaseNotReady');
      expect(result.message).toContain('Terminating');
      expect(result.message).toContain('Active');
    });

    it('should support multiple ready phases', () => {
      const evaluator = createPhaseBasedReadinessEvaluator({
        kind: 'PersistentVolume',
        readyPhases: ['Available', 'Bound'],
      });
      expect(evaluator({ status: { phase: 'Available' } }).ready).toBe(true);
      expect(evaluator({ status: { phase: 'Bound' } }).ready).toBe(true);
      expect(evaluator({ status: { phase: 'Released' } }).ready).toBe(false);
    });

    it('should support custom phase field', () => {
      const evaluator = createPhaseBasedReadinessEvaluator({
        kind: 'CustomResource',
        readyPhases: ['Running'],
        phaseField: 'state',
      });
      // Should check 'state' not 'phase'
      const resultWrongField = evaluator({ status: { phase: 'Running' } });
      expect(resultWrongField.ready).toBe(false);

      const resultCorrectField = evaluator({ status: { state: 'Running' } });
      expect(resultCorrectField.ready).toBe(true);
    });

    it('should handle undefined phase', () => {
      const evaluator = createPhaseBasedReadinessEvaluator({
        kind: 'Namespace',
        readyPhases: ['Active'],
      });
      const result = evaluator({ status: {} });
      expect(result.ready).toBe(false);
      expect(result.message).toContain('unknown');
    });

    it('should handle null liveResource gracefully', () => {
      const evaluator = createPhaseBasedReadinessEvaluator({
        kind: 'PVC',
        readyPhases: ['Bound'],
      });
      const result = evaluator(null);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('StatusMissing');
    });
  });

  // ===========================================================================
  // Behavioral parity with existing evaluators
  // ===========================================================================

  describe('Behavioral parity with existing evaluators', () => {
    it('should match ClusterIssuer evaluator behavior for missing status', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'ClusterIssuer' });
      const result = evaluator({});
      expect(result).toEqual({
        ready: false,
        reason: 'StatusMissing',
        message: 'ClusterIssuer status not available',
      });
    });

    it('should match ClusterIssuer evaluator behavior for empty conditions', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'ClusterIssuer' });
      const result = evaluator({ status: { conditions: [] } });
      expect(result).toEqual({
        ready: false,
        reason: 'ConditionsMissing',
        message: 'ClusterIssuer conditions not available',
      });
    });

    it('should match ClusterIssuer evaluator behavior for Ready=True', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'ClusterIssuer' });
      const result = evaluator({
        status: {
          conditions: [
            { type: 'Ready', status: 'True', message: 'Issuer is ready to issue certificates' },
          ],
        },
      });
      expect(result.ready).toBe(true);
      expect(result.message).toBe('Issuer is ready to issue certificates');
      expect(result.reason).toBe('Ready');
    });

    it('should match ClusterIssuer evaluator behavior for Ready=False', () => {
      const evaluator = createConditionBasedReadinessEvaluator({ kind: 'ClusterIssuer' });
      const result = evaluator({
        status: {
          conditions: [
            { type: 'Ready', status: 'False', reason: 'InvalidConfig', message: 'Missing secret' },
          ],
        },
      });
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('InvalidConfig');
      expect(result.message).toBe('Missing secret');
    });

    it('should match Namespace evaluator behavior for Active phase', () => {
      const evaluator = createPhaseBasedReadinessEvaluator({
        kind: 'Namespace',
        readyPhases: ['Active'],
      });
      const result = evaluator({ status: { phase: 'Active' } });
      expect(result.ready).toBe(true);
      expect(result.message).toContain('Active');
    });

    it('should match Namespace evaluator behavior for Terminating phase', () => {
      const evaluator = createPhaseBasedReadinessEvaluator({
        kind: 'Namespace',
        readyPhases: ['Active'],
      });
      const result = evaluator({ status: { phase: 'Terminating' } });
      expect(result.ready).toBe(false);
      expect(result.message).toContain('Terminating');
    });
  });
});
