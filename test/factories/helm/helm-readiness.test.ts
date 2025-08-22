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
      expect(result.reason).toBe('StatusMissing');
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
      expect(result.message).toContain('being installed');
    });

    it('should return not ready when Upgrading', () => {
      const resource = {
        metadata: { name: 'test' },
        status: { phase: 'Upgrading' },
      };
      const result = helmReleaseReadinessEvaluator(resource);

      expect(result.ready).toBe(false);
      expect(result.reason).toBe('Upgrading');
      expect(result.message).toContain('being upgraded');
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
