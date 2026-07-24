import { describe, expect, it } from 'bun:test';
import { CelEvaluator } from '../../../src/core/references/cel-evaluator.js';
import type { CelExpression } from '../../../src/core/types.js';
import { helmReleaseConditionSummary } from '../../../src/factories/helm/status.js';
import { createResource } from '../../../src/index.js';

const expression = (value: unknown) => (value as CelExpression<unknown>).expression;

function release(id: string) {
  return createResource({
    id,
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: { name: id },
  });
}

describe('helmReleaseConditionSummary', () => {
  it('repeats a single condition reference safely in a three-state phase', () => {
    const conditions = release('databaseRelease').status.conditions;
    const status = helmReleaseConditionSummary(conditions);

    expect(expression(status.ready)).toBe(
      'databaseRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")'
    );
    expect(expression(status.failed)).toBe(
      'databaseRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "False")'
    );
    expect(expression(status.phase)).toBe(
      '(databaseRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "False")) ? "Failed" : ((databaseRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")) ? "Ready" : "Installing")'
    );
  });

  it('aggregates multiple releases without losing any receiver path', () => {
    const server = release('serverRelease').status.conditions;
    const controller = release('controllerRelease').status.conditions;
    const status = helmReleaseConditionSummary(server, controller);

    expect(expression(status.ready)).toContain(
      'serverRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && controllerRelease.status.conditions.exists'
    );
    expect(expression(status.failed)).toContain(
      'serverRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "False") || controllerRelease.status.conditions.exists'
    );
    expect(expression(status.phase)).toContain('? "Failed" :');
    expect(expression(status.phase)).toContain('? "Ready" : "Installing"');
  });

  it('evaluates Ready, Failed, and Installing without diverging fields', async () => {
    const conditions = release('runtimeRelease').status.conditions;
    const status = helmReleaseConditionSummary(conditions);
    const evaluator = new CelEvaluator();

    for (const [readyStatus, expected] of [
      ['True', { ready: true, failed: false, phase: 'Ready' }],
      ['False', { ready: false, failed: true, phase: 'Failed' }],
      ['Unknown', { ready: false, failed: false, phase: 'Installing' }],
    ] as const) {
      const context = {
        resources: new Map([
          ['runtimeRelease', { status: { conditions: [{ type: 'Ready', status: readyStatus }] } }],
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
});
