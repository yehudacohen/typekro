/**
 * Direct-mode status leaves must resolve independently.
 *
 * Regression coverage for the defect where a single failing CEL leaf
 * (`size(service.status.loadBalancer.ingress) > 0 ? ... : ...` on a Service
 * that has no address yet) took the whole status object to unresolved —
 * `ready`, `failed` and `phase` included.
 */

import { describe, expect, it } from 'bun:test';
import { CEL_EXPRESSION_BRAND } from '../../src/core/constants/brands.js';
import {
  getStatusLeafDiagnostics,
  resolveStatusLeavesIndependently,
} from '../../src/core/deployment/status-leaf-resolution.js';
import { CelEvaluator } from '../../src/core/references/cel-evaluator.js';
import type { CelExpression } from '../../src/core/types.js';

type StatusShape = Record<string, unknown>;

function celExpression(expression: string): CelExpression {
  return { [CEL_EXPRESSION_BRAND]: true, expression } as CelExpression;
}

/** Read a dotted/indexed path out of a resolved status object. */
function at(status: StatusShape, path: string): unknown {
  return path
    .split('.')
    .flatMap((segment) => segment.split(/[[\]]/).filter(Boolean))
    .reduce<unknown>((value, segment) => {
      if (value === null || typeof value !== 'object') return undefined;
      return (value as Record<string, unknown>)[segment];
    }, status);
}

/**
 * Resolve a leaf the way direct mode does: run CEL expressions through the real
 * cel-js evaluator against a live-status snapshot, and pass everything else
 * through untouched.
 */
function evaluatorFor(status: Record<string, unknown>) {
  const evaluator = new CelEvaluator();
  const context = {
    resources: new Map<string, unknown>([
      [
        'webService',
        { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web' }, spec: {}, status },
      ],
    ]),
  };
  return async (leaf: unknown): Promise<unknown> => {
    if (
      leaf !== null &&
      typeof leaf === 'object' &&
      (leaf as Record<symbol, unknown>)[CEL_EXPRESSION_BRAND] === true
    ) {
      return evaluator.evaluate(leaf as CelExpression, context as never);
    }
    return leaf;
  };
}

describe('resolveStatusLeavesIndependently', () => {
  it('resolves every other leaf when one leaf errors', async () => {
    const status: StatusShape = {
      ready: celExpression('true'),
      failed: celExpression('false'),
      phase: celExpression('"Ready"'),
      // Errors: `ingress` is absent on a Service that has not been given an address.
      address: celExpression(
        'size(webService.status.loadBalancer.ingress) > 0 ? webService.status.loadBalancer.ingress[0].ip : ""'
      ),
    };

    const result = await resolveStatusLeavesIndependently(
      status,
      evaluatorFor({ loadBalancer: {} })
    );

    expect(at(result.status, 'ready')).toBe(true);
    expect(at(result.status, 'failed')).toBe(false);
    expect(at(result.status, 'phase')).toBe('Ready');
    expect(at(result.status, 'address')).toBeUndefined();
  });

  it('reports the failing leaf path and error on the diagnostics channel', async () => {
    const status: StatusShape = {
      ready: celExpression('true'),
      address: celExpression('webService.status.loadBalancer.ingress[0].ip'),
    };

    const result = await resolveStatusLeavesIndependently(
      status,
      evaluatorFor({ loadBalancer: {} })
    );

    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.path).toBe('address');
    expect(diagnostic?.expression).toBe('webService.status.loadBalancer.ingress[0].ip');
    expect(diagnostic?.message).toContain("Status field 'address'");
    expect(diagnostic?.error).toBeInstanceOf(Error);
  });

  it('attaches diagnostics non-enumerably so they never reach emitted status', async () => {
    const status: StatusShape = {
      ready: celExpression('true'),
      address: celExpression('webService.status.loadBalancer.ingress[0].ip'),
    };

    const result = await resolveStatusLeavesIndependently(
      status,
      evaluatorFor({ loadBalancer: {} })
    );

    expect(Object.keys(result.status)).toEqual(['ready', 'address']);
    expect(JSON.parse(JSON.stringify(result.status))).toEqual({ ready: true });
    expect(getStatusLeafDiagnostics(result.status)).toHaveLength(1);
    expect(getStatusLeafDiagnostics(result.status)[0]?.path).toBe('address');
  });

  it('keeps the sibling subtree when a nested object has one bad leaf', async () => {
    const status: StatusShape = {
      ready: celExpression('true'),
      loadBalancer: {
        ip: celExpression('webService.status.loadBalancer.ingress[0].ip'),
        hostname: celExpression('"pending"'),
      },
      components: {
        gateway: { ready: celExpression('true'), phase: celExpression('"Ready"') },
      },
    };

    const result = await resolveStatusLeavesIndependently(
      status,
      evaluatorFor({ loadBalancer: {} })
    );

    expect(at(result.status, 'ready')).toBe(true);
    expect(at(result.status, 'loadBalancer.ip')).toBeUndefined();
    expect(at(result.status, 'loadBalancer.hostname')).toBe('pending');
    expect(at(result.status, 'components.gateway.ready')).toBe(true);
    expect(at(result.status, 'components.gateway.phase')).toBe('Ready');
    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual(['loadBalancer.ip']);
  });

  it('reports array element paths with their index', async () => {
    const status: StatusShape = {
      addresses: [
        celExpression('"10.0.0.1"'),
        celExpression('webService.status.loadBalancer.ingress[0].ip'),
      ],
    };

    const result = await resolveStatusLeavesIndependently(
      status,
      evaluatorFor({ loadBalancer: {} })
    );

    expect(at(result.status, 'addresses[0]')).toBe('10.0.0.1');
    expect(at(result.status, 'addresses[1]')).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual(['addresses[1]']);
  });

  it('records no diagnostics and preserves internal metadata when everything resolves', async () => {
    const status: StatusShape = { ready: celExpression('true') };
    Object.defineProperty(status, '__nestedStatusCel', {
      value: { '__nestedStatus:inner:ready': 'inner.status.ready' },
      enumerable: false,
    });

    const result = await resolveStatusLeavesIndependently(status, evaluatorFor({}));

    expect(result.diagnostics).toEqual([]);
    expect(at(result.status, 'ready')).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(result.status, '__nestedStatusCel')?.value
    ).toBeDefined();
  });

  it('does not resolve or report TypeKro-internal __ keys', async () => {
    const status: StatusShape = {
      ready: celExpression('true'),
      __internal: celExpression('webService.status.loadBalancer.ingress[0].ip'),
    };

    const result = await resolveStatusLeavesIndependently(
      status,
      evaluatorFor({ loadBalancer: {} })
    );

    expect(result.diagnostics).toEqual([]);
    expect(at(result.status, '__internal')).toBeDefined();
  });
});
