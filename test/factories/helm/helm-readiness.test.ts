import { describe, expect, it } from 'bun:test';
import {
  createComprehensiveHelmReadinessEvaluator,
  createHelmRevisionReadinessEvaluator,
  createHelmTestReadinessEvaluator,
  createHelmTimeoutReadinessEvaluator,
  helmReleaseReadinessEvaluator,
} from '../../../src/factories/helm/readiness-evaluators.js';

describe('Helm Readiness Evaluators', () => {
  describe('helmReleaseReadinessEvaluator', () => {
    it('should return not ready when status is missing', () => {
      const resource = { metadata: { name: 'test' } };
      const result = helmReleaseReadinessEvaluator(resource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('Installing');
      expect(result.message).toContain('status not available');
    });

    it('should return ready when phase is Ready', () => {
      const resource = {
        metadata: { name: 'test' },
        status: { phase: 'Ready', revision: 1 },
      };
      const result = helmReleaseReadinessEvaluator(resource);

      expect(result.ready).toBe(true);
      expect(result.message).toContain('revision 1');
    });

    it('should return not ready when phase is Failed', () => {
      const resource = {
        metadata: { name: 'test' },
        status: { phase: 'Failed', message: 'Installation failed' },
      };
      const result = helmReleaseReadinessEvaluator(resource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('InstallationFailed');
      expect(result.message).toBe('Installation failed');
    });

    it('should return not ready when Installing', () => {
      const resource = {
        metadata: { name: 'test' },
        status: { phase: 'Installing' },
      };
      const result = helmReleaseReadinessEvaluator(resource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('Installing');
      expect(result.message).toContain('installation in progress');
    });

    it('should return not ready when Upgrading', () => {
      const resource = {
        metadata: { name: 'test' },
        status: { phase: 'Upgrading' },
      };
      const result = helmReleaseReadinessEvaluator(resource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('Upgrading');
      expect(result.message).toContain('upgrade in progress');
    });

    it('should handle Flux CD v2 conditions', () => {
      const resource = {
        metadata: { name: 'test' },
        status: {
          conditions: [{ type: 'Ready', status: 'True', message: 'Release is ready' }],
          revision: 2,
        },
      };
      const result = helmReleaseReadinessEvaluator(resource);

      expect(result.ready).toBe(true);
      expect(result.message).toContain('Release is ready');
    });

    it('waits for Flux to observe an updated HelmRelease generation', () => {
      const resource = {
        metadata: { name: 'test', generation: 3 },
        status: {
          observedGeneration: 2,
          conditions: [
            {
              type: 'Ready',
              status: 'True',
              observedGeneration: 2,
              message: 'The preceding release is ready',
            },
          ],
        },
      };

      expect(helmReleaseReadinessEvaluator(resource)).toMatchObject({
        ready: false,
        reason: 'GenerationNotObserved',
        details: { desiredGeneration: 3, observedGeneration: 2 },
      });
    });

    it('does not accept Ready before Flux publishes any observation for the generation', () => {
      const resource = {
        metadata: { name: 'test', generation: 3 },
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'True',
              message: 'The preceding release is still reported ready',
            },
          ],
        },
      };

      expect(helmReleaseReadinessEvaluator(resource)).toEqual({
        ready: false,
        reason: 'GenerationNotObserved',
        message: 'HelmRelease has not observed generation 3 yet',
        details: { desiredGeneration: 3 },
      });
    });

    it('accepts Ready only after Flux observes the current generation', () => {
      const resource = {
        metadata: { name: 'test', generation: 3 },
        status: {
          observedGeneration: 3,
          conditions: [
            {
              type: 'Ready',
              status: 'True',
              observedGeneration: 3,
              message: 'Release is ready',
            },
          ],
        },
      };

      expect(helmReleaseReadinessEvaluator(resource)).toMatchObject({ ready: true });
    });

    it('rejects a stale Ready condition even when top-level observation is current', () => {
      const resource = {
        metadata: { name: 'test', generation: 3 },
        status: {
          observedGeneration: 3,
          conditions: [
            {
              type: 'Ready',
              status: 'True',
              observedGeneration: 2,
            },
          ],
        },
      };

      expect(helmReleaseReadinessEvaluator(resource)).toMatchObject({
        ready: false,
        reason: 'GenerationNotObserved',
      });
    });

    it('should handle not ready conditions', () => {
      const resource = {
        metadata: { name: 'test' },
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'False',
              reason: 'InstallFailed',
              message: 'Chart installation failed',
            },
          ],
        },
      };
      const result = helmReleaseReadinessEvaluator(resource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('InstallFailed');
      expect(result.message).toBe('Chart installation failed');
    });
  });

  // ── Flux v2 condition sequences (issue #191) ───────────────────────────────
  //
  // The looser evaluator accepted a `Ready=True` that belonged to the previous
  // release, so `waitForReady` on a Helm-backed bootstrap returned ~90s before
  // the chart had installed. These cases walk the sequences Flux actually
  // emits, so the contract is pinned rather than described.
  describe('helmReleaseReadinessEvaluator over Flux v2 condition sequences', () => {
    /** Fresh install, step 1: Flux has created status but released nothing. */
    const freshInstallReconciling = {
      metadata: { name: 'op', generation: 1 },
      status: {
        observedGeneration: 1,
        lastAttemptedRevision: '0.27.1',
        conditions: [
          {
            type: 'Reconciling',
            status: 'True',
            reason: 'Progressing',
            observedGeneration: 1,
            message: 'Running \'install\' action with timeout of 5m0s',
          },
          { type: 'Ready', status: 'Unknown', reason: 'Progressing', observedGeneration: 1 },
        ],
      },
    };

    /** Fresh install, step 2: released and settled. */
    const freshInstallReleased = {
      metadata: { name: 'op', generation: 1 },
      status: {
        observedGeneration: 1,
        lastAttemptedRevision: '0.27.1',
        history: [{ chartVersion: '0.27.1', version: 1, status: 'deployed' }],
        conditions: [
          {
            type: 'Released',
            status: 'True',
            reason: 'InstallSucceeded',
            observedGeneration: 1,
          },
          {
            type: 'Ready',
            status: 'True',
            reason: 'InstallSucceeded',
            observedGeneration: 1,
            message: 'Helm install succeeded for release op/op.v1 with chart op@0.27.1',
          },
        ],
      },
    };

    it('is not ready while Flux is still installing (Reconciling=True)', () => {
      expect(helmReleaseReadinessEvaluator(freshInstallReconciling)).toMatchObject({
        ready: false,
        reason: 'Reconciling',
      });
    });

    it('is ready once the fresh install is released and Reconciling has cleared', () => {
      expect(helmReleaseReadinessEvaluator(freshInstallReleased)).toMatchObject({ ready: true });
    });

    it('is not ready when Reconciling=True co-exists with a stale Ready=True', () => {
      // The exact #191 shape: an upgrade has started (generation 2 observed),
      // and the Ready=True still describes revision 0.27.1.
      const upgradeInFlight = {
        metadata: { name: 'op', generation: 2 },
        status: {
          observedGeneration: 2,
          lastAttemptedRevision: '0.28.0',
          history: [{ chartVersion: '0.27.1', version: 1, status: 'deployed' }],
          conditions: [
            { type: 'Reconciling', status: 'True', reason: 'Progressing', observedGeneration: 2 },
            {
              type: 'Released',
              status: 'True',
              reason: 'InstallSucceeded',
              observedGeneration: 2,
            },
            { type: 'Ready', status: 'True', reason: 'InstallSucceeded', observedGeneration: 2 },
          ],
        },
      };

      expect(helmReleaseReadinessEvaluator(upgradeInFlight)).toMatchObject({
        ready: false,
        reason: 'Reconciling',
      });
    });

    it('is ready after an upgrade releases the attempted revision', () => {
      const upgraded = {
        metadata: { name: 'op', generation: 2 },
        status: {
          observedGeneration: 2,
          lastAttemptedRevision: '0.28.0',
          history: [
            { chartVersion: '0.28.0', version: 2, status: 'deployed' },
            { chartVersion: '0.27.1', version: 1, status: 'superseded' },
          ],
          conditions: [
            {
              type: 'Released',
              status: 'True',
              reason: 'UpgradeSucceeded',
              observedGeneration: 2,
            },
            { type: 'Ready', status: 'True', reason: 'UpgradeSucceeded', observedGeneration: 2 },
          ],
        },
      };

      expect(helmReleaseReadinessEvaluator(upgraded)).toMatchObject({ ready: true });
    });

    it('is not ready when a failed upgrade rolled back to the previous revision', () => {
      // Flux remediated: the attempted 0.28.0 failed and 0.27.1 is what is
      // installed. `Ready` is False here, but the revision check is the one
      // that holds even when a Ready=True lingers.
      const rolledBack = {
        metadata: { name: 'op', generation: 3 },
        status: {
          observedGeneration: 3,
          lastAttemptedRevision: '0.28.0',
          history: [{ chartVersion: '0.27.1', version: 3, status: 'deployed' }],
          conditions: [
            { type: 'Remediated', status: 'True', reason: 'RollbackSucceeded', observedGeneration: 3 },
            { type: 'Released', status: 'False', reason: 'UpgradeFailed', observedGeneration: 3 },
            {
              type: 'Ready',
              status: 'True',
              reason: 'UpgradeFailed',
              observedGeneration: 3,
              message: 'stale ready from before the failed upgrade',
            },
          ],
        },
      };

      expect(helmReleaseReadinessEvaluator(rolledBack)).toMatchObject({
        ready: false,
        reason: 'RevisionNotReleased',
        details: { attemptedRevision: '0.28.0', releasedRevision: '0.27.1' },
      });
    });

    it('is not ready when Released is present but not True', () => {
      const notReleased = {
        metadata: { name: 'op', generation: 1 },
        status: {
          observedGeneration: 1,
          conditions: [
            {
              type: 'Released',
              status: 'False',
              reason: 'InstallFailed',
              message: 'chart install failed',
              observedGeneration: 1,
            },
            { type: 'Ready', status: 'True', observedGeneration: 1 },
          ],
        },
      };

      expect(helmReleaseReadinessEvaluator(notReleased)).toMatchObject({
        ready: false,
        reason: 'InstallFailed',
        message: 'chart install failed',
      });
    });

    it('is not ready when the release has stalled', () => {
      const stalled = {
        metadata: { name: 'op', generation: 2 },
        status: {
          observedGeneration: 2,
          conditions: [
            {
              type: 'Stalled',
              status: 'True',
              reason: 'RetriesExceeded',
              message: 'exhausted upgrade retries',
              observedGeneration: 2,
            },
            { type: 'Ready', status: 'False', reason: 'UpgradeFailed', observedGeneration: 2 },
          ],
        },
      };

      expect(helmReleaseReadinessEvaluator(stalled)).toMatchObject({
        ready: false,
        reason: 'RetriesExceeded',
        message: 'exhausted upgrade retries',
      });
    });

    it('rejects a Released condition observed at a different generation', () => {
      const staleReleased = {
        metadata: { name: 'op', generation: 4 },
        status: {
          observedGeneration: 4,
          conditions: [
            { type: 'Released', status: 'True', observedGeneration: 3 },
            { type: 'Ready', status: 'True', observedGeneration: 4 },
          ],
        },
      };

      expect(helmReleaseReadinessEvaluator(staleReleased)).toMatchObject({
        ready: false,
        reason: 'GenerationNotObserved',
      });
    });

    it('does not treat a Reconciling=False condition as in-flight', () => {
      const settled = {
        metadata: { name: 'op', generation: 1 },
        status: {
          observedGeneration: 1,
          conditions: [
            { type: 'Reconciling', status: 'False', observedGeneration: 1 },
            { type: 'Ready', status: 'True', observedGeneration: 1 },
          ],
        },
      };

      expect(helmReleaseReadinessEvaluator(settled)).toMatchObject({ ready: true });
    });

    it('accepts the beta-shape lastAppliedRevision as the released revision', () => {
      const betaShape = {
        metadata: { name: 'op', generation: 1 },
        status: {
          observedGeneration: 1,
          lastAttemptedRevision: '0.27.1',
          lastAppliedRevision: '0.27.1',
          conditions: [{ type: 'Ready', status: 'True', observedGeneration: 1 }],
        },
      };

      expect(helmReleaseReadinessEvaluator(betaShape)).toMatchObject({ ready: true });
    });

    it('gates the legacy status.phase on Reconciling too', () => {
      // A `phase: 'Ready'` from the Helm Operator v1 shape must not outrank an
      // in-flight Flux reconcile when both are present.
      const legacyPhaseWhileReconciling = {
        metadata: { name: 'op', generation: 1 },
        status: {
          phase: 'Ready',
          revision: 1,
          observedGeneration: 1,
          conditions: [{ type: 'Reconciling', status: 'True', observedGeneration: 1 }],
        },
      };

      expect(helmReleaseReadinessEvaluator(legacyPhaseWhileReconciling)).toMatchObject({
        ready: false,
        reason: 'Reconciling',
      });
    });
  });

  describe('createHelmRevisionReadinessEvaluator', () => {
    it('should wait for specific revision', () => {
      const evaluator = createHelmRevisionReadinessEvaluator(3);

      const resource = {
        metadata: { name: 'test' },
        status: { phase: 'Ready', revision: 2 },
      };
      const result = evaluator(resource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('WrongRevision');
      expect(result.message).toContain('revision 2, expected 3');
    });

    it('should be ready when correct revision is reached', () => {
      const evaluator = createHelmRevisionReadinessEvaluator(3);

      const resource = {
        metadata: { name: 'test' },
        status: { phase: 'Ready', revision: 3 },
      };
      const result = evaluator(resource);

      expect(result.ready).toBe(true);
      expect(result.message).toContain('expected revision 3');
    });
  });

  describe('createHelmTestReadinessEvaluator', () => {
    it('should not require tests by default', () => {
      const evaluator = createHelmTestReadinessEvaluator(false);

      const resource = {
        metadata: { name: 'test' },
        status: { phase: 'Ready', revision: 1 },
      };
      const result = evaluator(resource);

      expect(result.ready).toBe(true);
    });

    it('should wait for test success when required', () => {
      const evaluator = createHelmTestReadinessEvaluator(true);

      const resource = {
        metadata: { name: 'test' },
        status: {
          phase: 'Ready',
          revision: 1,
          conditions: [],
        },
      };
      const result = evaluator(resource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('TestsPending');
    });

    it('should be ready when tests pass', () => {
      const evaluator = createHelmTestReadinessEvaluator(true);

      const resource = {
        metadata: { name: 'test' },
        status: {
          phase: 'Ready',
          revision: 1,
          conditions: [{ type: 'TestSuccess', status: 'True', message: 'All tests passed' }],
        },
      };
      const result = evaluator(resource);

      expect(result.ready).toBe(true);
      expect(result.message).toContain('tests passed');
    });
  });

  describe('createHelmTimeoutReadinessEvaluator', () => {
    it('should not timeout for recent deployments', () => {
      const evaluator = createHelmTimeoutReadinessEvaluator(10);

      const resource = {
        metadata: {
          name: 'test',
          creationTimestamp: new Date().toISOString(),
        },
        status: { phase: 'Installing' },
      };
      const result = evaluator(resource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('Installing');
    });

    it('should timeout for old deployments', () => {
      const evaluator = createHelmTimeoutReadinessEvaluator(1); // 1 minute timeout

      const oldTime = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes ago
      const resource = {
        metadata: {
          name: 'test',
          creationTimestamp: oldTime.toISOString(),
        },
        status: { phase: 'Installing' },
      };
      const result = evaluator(resource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('Timeout');
      expect(result.message).toContain('timed out');
    });
  });

  describe('createComprehensiveHelmReadinessEvaluator', () => {
    it('should combine all checks', () => {
      const evaluator = createComprehensiveHelmReadinessEvaluator({
        expectedRevision: 2,
        requireTests: true,
        timeoutMinutes: 10,
      });

      const resource = {
        metadata: {
          name: 'test',
          creationTimestamp: new Date().toISOString(),
        },
        status: {
          phase: 'Ready',
          revision: 2,
          conditions: [{ type: 'TestSuccess', status: 'True', message: 'All tests passed' }],
        },
      };
      const result = evaluator(resource);

      expect(result.ready).toBe(true);
      expect(result.message).toContain('fully ready');
      expect(result.message).toContain('tests passed');
    });

    it('should fail if any check fails', () => {
      const evaluator = createComprehensiveHelmReadinessEvaluator({
        expectedRevision: 3,
        requireTests: true,
      });

      const resource = {
        metadata: { name: 'test' },
        status: {
          phase: 'Ready',
          revision: 2, // Wrong revision
          conditions: [{ type: 'TestSuccess', status: 'True' }],
        },
      };
      const result = evaluator(resource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('WrongRevision');
    });
  });
});
