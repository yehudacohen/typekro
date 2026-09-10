/**
 * `Cel.firstWhereHas` / `Cel.loadBalancerAddress` — the one guard form for an
 * optional nested list that both cel-js (direct mode) and cel-go (KRO) accept.
 *
 * The projection cases are driven through the real direct-mode evaluator over a
 * range of live Service statuses, including the ones that used to throw and
 * take the whole status object down with them.
 */

import { describe, expect, it } from 'bun:test';
import { Cel } from '../../src/core/references/cel.js';
import { CelEvaluator } from '../../src/core/references/cel-evaluator.js';
import type { CelExpression } from '../../src/core/types.js';

type ServiceStatus = {
  loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] };
};

async function project(field: 'ip' | 'hostname', status: ServiceStatus): Promise<unknown> {
  const expression = Cel.loadBalancerAddress('webService', field) as unknown as CelExpression;
  return new CelEvaluator().evaluate(expression, {
    resources: new Map([
      [
        'webService',
        { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web' }, spec: {}, status },
      ],
    ]),
  } as never);
}

describe('Cel.loadBalancerAddress', () => {
  it('reports no address for a Service that has not been given one', async () => {
    for (const status of [
      {},
      { loadBalancer: {} },
      { loadBalancer: { ingress: [] } },
    ] satisfies ServiceStatus[]) {
      expect(await project('hostname', status)).toBe('');
      expect(await project('ip', status)).toBe('');
    }
  });

  it('projects a hostname-only address, as a name-based load balancer reports it', async () => {
    const status = { loadBalancer: { ingress: [{ hostname: 'edge.example.test' }] } };
    expect(await project('hostname', status)).toBe('edge.example.test');
    expect(await project('ip', status)).toBe('');
  });

  it('projects an ip-only address, as an L4 load balancer reports it', async () => {
    const status = { loadBalancer: { ingress: [{ ip: '203.0.113.7' }] } };
    expect(await project('ip', status)).toBe('203.0.113.7');
    expect(await project('hostname', status)).toBe('');
  });

  it('projects both fields when the entry carries both', async () => {
    const status = {
      loadBalancer: { ingress: [{ ip: '203.0.113.7', hostname: 'edge.example.test' }] },
    };
    expect(await project('hostname', status)).toBe('edge.example.test');
    expect(await project('ip', status)).toBe('203.0.113.7');
  });

  it('reads the first matching entry when a load balancer reports several', async () => {
    const status = {
      loadBalancer: {
        ingress: [{ hostname: 'edge-a.example.test' }, { hostname: 'edge-b.example.test' }],
      },
    };
    expect(await project('hostname', status)).toBe('edge-a.example.test');
  });

  it('skips entries that do not carry the requested field', async () => {
    const status = {
      loadBalancer: { ingress: [{ ip: '203.0.113.7' }, { hostname: 'edge.example.test' }] },
    };
    expect(await project('hostname', status)).toBe('edge.example.test');
    expect(await project('ip', status)).toBe('203.0.113.7');
  });

  it('honors an explicit fallback', async () => {
    const expression = Cel.loadBalancerAddress(
      'webService',
      'ip',
      'pending'
    ) as unknown as CelExpression;
    const result = await new CelEvaluator().evaluate(expression, {
      resources: new Map([
        [
          'webService',
          { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web' }, spec: {}, status: {} },
        ],
      ]),
    } as never);
    expect(result).toBe('pending');
  });
});

describe('Cel.firstWhereHas', () => {
  it('emits a chained has() guard, a filter, and a lazy ternary', () => {
    const expression = (
      Cel.firstWhereHas('release.status.history', 'chartVersion') as unknown as CelExpression
    ).expression;

    expect(expression).toBe(
      'has(release.status) && has(release.status.history) ? ' +
        '(size(release.status.history.filter(entry, has(entry.chartVersion))) > 0 ? ' +
        'release.status.history.filter(entry, has(entry.chartVersion))[0].chartVersion : "") : ""'
    );
  });

  it('never emits has() on an index expression, nor `in` on a list entry', () => {
    const expression = (Cel.loadBalancerAddress('webService', 'ip') as unknown as CelExpression)
      .expression;

    expect(expression).not.toMatch(/has\([^)]*\[/);
    expect(expression).not.toMatch(/\bin\b/);
  });

  it('rejects a field that is not a simple CEL identifier', () => {
    expect(() => Cel.firstWhereHas('a.status.list', 'a.b')).toThrow(/simple CEL identifier/);
  });

  it('rejects a list argument that is neither a reference nor a CEL path', () => {
    expect(() => Cel.firstWhereHas(42 as never, 'ip')).toThrow(/CEL path string/);
  });
});
