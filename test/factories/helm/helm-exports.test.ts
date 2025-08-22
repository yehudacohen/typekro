import { describe, expect, it } from 'bun:test';

describe('Helm Factory Exports', () => {
  it('should export helm functions from main index', async () => {
    const { helmRelease, simpleHelmChart } = await import('../../../src/factories/index.js');

    expect(helmRelease).toBeDefined();
    expect(typeof helmRelease).toBe('function');
    expect(simpleHelmChart).toBeDefined();
    expect(typeof simpleHelmChart).toBe('function');
  });

  it('should export helm types', async () => {
    // TypeScript interfaces are not runtime values, so we just verify the module loads
    const module = await import('../../../src/factories/helm/types.js');
    expect(module).toBeDefined();
  });

  it('should export readiness evaluators', async () => {
    const {
      helmReleaseReadinessEvaluator,
      createHelmRevisionReadinessEvaluator,
      createHelmTestReadinessEvaluator,
      createHelmTimeoutReadinessEvaluator,
      createComprehensiveHelmReadinessEvaluator,
    } = await import('../../../src/factories/helm/readiness-evaluators.js');

    expect(helmReleaseReadinessEvaluator).toBeDefined();
    expect(typeof helmReleaseReadinessEvaluator).toBe('function');
    expect(createHelmRevisionReadinessEvaluator).toBeDefined();
    expect(typeof createHelmRevisionReadinessEvaluator).toBe('function');
    expect(createHelmTestReadinessEvaluator).toBeDefined();
    expect(typeof createHelmTestReadinessEvaluator).toBe('function');
    expect(createHelmTimeoutReadinessEvaluator).toBeDefined();
    expect(typeof createHelmTimeoutReadinessEvaluator).toBe('function');
    expect(createComprehensiveHelmReadinessEvaluator).toBeDefined();
    expect(typeof createComprehensiveHelmReadinessEvaluator).toBe('function');
  });
});
