import { describe, expect, it } from 'bun:test';
import { CelEvaluator } from '../../../src/core/references/cel-evaluator.js';
import type { CelExpression } from '../../../src/core/types.js';
import { helmReleaseConditionSummary } from '../../../src/factories/helm/status.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../../src/factories/helm/types.js';
import { createResource } from '../../../src/index.js';

const expression = (value: unknown) => (value as CelExpression<unknown>).expression;

function release(id: string) {
  return createResource<HelmReleaseSpec, HelmReleaseStatus>({
    id,
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: { name: id },
    spec: {
      interval: '5m',
      chart: {
        spec: {
          chart: 'example',
          sourceRef: { kind: 'HelmRepository', name: 'example' },
        },
      },
    },
  });
}

describe('helmReleaseConditionSummary', () => {
  it('repeats a single generation-aware release check safely in a three-state phase', () => {
    const status = helmReleaseConditionSummary(release('databaseRelease'));

    expect(expression(status.ready)).toContain('has(databaseRelease.status.observedGeneration)');
    expect(expression(status.ready)).toContain(
      'databaseRelease.status.observedGeneration >= databaseRelease.metadata.generation'
    );
    expect(expression(status.ready)).toContain('has(databaseRelease.status.conditions)');
    expect(expression(status.ready)).toContain(
      'c.status == "True" && (has(c.observedGeneration) ? c.observedGeneration >= databaseRelease.metadata.generation : true)'
    );
    expect(expression(status.failed)).toContain(
      'c.status == "False" && (has(c.observedGeneration) ? c.observedGeneration >= databaseRelease.metadata.generation : true)'
    );
    expect(expression(status.phase)).toContain('? "Failed" :');
    expect(expression(status.phase)).toContain('? "Ready" : "Installing"');
  });

  it('aggregates multiple releases without losing any receiver path', () => {
    const server = release('serverRelease');
    const controller = release('controllerRelease');
    const status = helmReleaseConditionSummary(server, controller);

    expect(expression(status.ready)).toContain(
      'serverRelease.status.observedGeneration >= serverRelease.metadata.generation'
    );
    expect(expression(status.ready)).toContain(
      'controllerRelease.status.observedGeneration >= controllerRelease.metadata.generation'
    );
    expect(expression(status.failed)).toContain('serverRelease.status.conditions.exists');
    expect(expression(status.failed)).toContain('controllerRelease.status.conditions.exists');
    expect(expression(status.phase)).toContain('? "Failed" :');
    expect(expression(status.phase)).toContain('? "Ready" : "Installing"');
  });

  it('evaluates current Ready, Failed, and Installing without diverging fields', async () => {
    const status = helmReleaseConditionSummary(release('runtimeRelease'));
    const evaluator = new CelEvaluator();

    for (const [readyStatus, expected] of [
      ['True', { ready: true, failed: false, phase: 'Ready' }],
      ['False', { ready: false, failed: true, phase: 'Failed' }],
      ['Unknown', { ready: false, failed: false, phase: 'Installing' }],
    ] as const) {
      const context = {
        resources: new Map([
          [
            'runtimeRelease',
            {
              metadata: { generation: 2 },
              status: {
                observedGeneration: 2,
                conditions: [{ type: 'Ready', status: readyStatus, observedGeneration: 2 }],
              },
            },
          ],
        ]),
        variables: {},
        functions: {},
      };
      expect({
        ready: await evaluator.evaluate(status.ready as unknown as CelExpression<boolean>, context),
        failed: await evaluator.evaluate(
          status.failed as unknown as CelExpression<boolean>,
          context
        ),
        phase: await evaluator.evaluate(status.phase as unknown as CelExpression<string>, context),
      }).toEqual(expected);
    }
  });

  it('treats stale Ready=True and Ready=False as Installing', async () => {
    const status = helmReleaseConditionSummary(release('runtimeRelease'));
    const evaluator = new CelEvaluator();

    for (const readyStatus of ['True', 'False'] as const) {
      const context = {
        resources: new Map([
          [
            'runtimeRelease',
            {
              metadata: { generation: 2 },
              status: {
                observedGeneration: 1,
                conditions: [{ type: 'Ready', status: readyStatus, observedGeneration: 1 }],
              },
            },
          ],
        ]),
        variables: {},
        functions: {},
      };
      expect({
        ready: await evaluator.evaluate(status.ready as unknown as CelExpression<boolean>, context),
        failed: await evaluator.evaluate(
          status.failed as unknown as CelExpression<boolean>,
          context
        ),
        phase: await evaluator.evaluate(status.phase as unknown as CelExpression<string>, context),
      }).toEqual({ ready: false, failed: false, phase: 'Installing' });
    }
  });

  it('ignores a stale condition even when top-level status is current', async () => {
    const status = helmReleaseConditionSummary(release('runtimeRelease'));
    const evaluator = new CelEvaluator();
    const context = {
      resources: new Map([
        [
          'runtimeRelease',
          {
            metadata: { generation: 2 },
            status: {
              observedGeneration: 2,
              conditions: [{ type: 'Ready', status: 'True', observedGeneration: 1 }],
            },
          },
        ],
      ]),
      variables: {},
      functions: {},
    };

    expect({
      ready: await evaluator.evaluate(status.ready as unknown as CelExpression<boolean>, context),
      failed: await evaluator.evaluate(status.failed as unknown as CelExpression<boolean>, context),
      phase: await evaluator.evaluate(status.phase as unknown as CelExpression<string>, context),
    }).toEqual({ ready: false, failed: false, phase: 'Installing' });
  });

  it('treats a release without a status object as Installing', async () => {
    const status = helmReleaseConditionSummary(release('runtimeRelease'));
    const evaluator = new CelEvaluator();
    const context = {
      resources: new Map([
        [
          'runtimeRelease',
          {
            metadata: { generation: 2 },
          },
        ],
      ]),
      variables: {},
      functions: {},
    };

    expect({
      ready: await evaluator.evaluate(status.ready as unknown as CelExpression<boolean>, context),
      failed: await evaluator.evaluate(status.failed as unknown as CelExpression<boolean>, context),
      phase: await evaluator.evaluate(status.phase as unknown as CelExpression<string>, context),
    }).toEqual({ ready: false, failed: false, phase: 'Installing' });
  });

  it('accepts a current Ready condition when Flux omits condition observedGeneration', async () => {
    const status = helmReleaseConditionSummary(release('runtimeRelease'));
    const evaluator = new CelEvaluator();
    const context = {
      resources: new Map([
        [
          'runtimeRelease',
          {
            metadata: { generation: 2 },
            status: {
              observedGeneration: 2,
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      ]),
      variables: {},
      functions: {},
    };

    expect({
      ready: await evaluator.evaluate(status.ready as unknown as CelExpression<boolean>, context),
      failed: await evaluator.evaluate(status.failed as unknown as CelExpression<boolean>, context),
      phase: await evaluator.evaluate(status.phase as unknown as CelExpression<string>, context),
    }).toEqual({ ready: true, failed: false, phase: 'Ready' });
  });

  it('rejects concrete condition arrays at compile time and runtime', () => {
    const invalidCall = () => {
      // @ts-expect-error The public helper accepts HelmRelease resources, not condition arrays.
      helmReleaseConditionSummary([{ type: 'Ready', status: 'True' }]);
    };
    expect(invalidCall).toBeFunction();

    expect(() =>
      Reflect.apply(helmReleaseConditionSummary, undefined, [[{ type: 'Ready', status: 'True' }]])
    ).toThrow('must be a HelmRelease resource created by TypeKro');
  });

  it('rejects plain HelmRelease lookalikes without TypeKro resource metadata', () => {
    const plainRelease = {
      apiVersion: 'helm.toolkit.fluxcd.io/v2',
      kind: 'HelmRelease',
      metadata: { name: 'plain-release' },
      spec: {},
    };

    expect(() => Reflect.apply(helmReleaseConditionSummary, undefined, [plainRelease])).toThrow(
      'must be a HelmRelease resource created by TypeKro'
    );

    expect(() =>
      Reflect.apply(helmReleaseConditionSummary, undefined, [
        { ...plainRelease, __resourceId: 'forged-release' },
      ])
    ).toThrow('must be a HelmRelease resource created by TypeKro');
  });
});
