/**
 * `Cel.firstWhereHas` / `Cel.loadBalancerAddress` — the one guard form for an
 * optional nested list that both cel-js (direct mode) and cel-go (KRO) accept.
 *
 * The projection cases are driven through the real direct-mode evaluator over a
 * range of live Service statuses, including the ones that used to throw and
 * take the whole status object down with them.
 */

import { describe, expect, it } from 'bun:test';
import { KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import {
  Cel,
  type CelListSelector,
  type LoadBalancerServiceRef,
} from '../../src/core/references/cel.js';
import { CelEvaluator } from '../../src/core/references/cel-evaluator.js';
import type { CelExpression, KubernetesRef } from '../../src/core/types.js';

type ServiceStatus = {
  loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] };
};

/**
 * A stand-in for the resource proxy a composition would pass.
 *
 * The helpers take a *selected* list field, not a path string, so the tests
 * build the same thing the proxy hands them: a `KubernetesRef` whose field path
 * names the list, typed as the field it stands for.
 */
function ref<T>(resourceId: string, fieldPath: string): KubernetesRef<T> {
  return { [KUBERNETES_REF_BRAND]: true, resourceId, fieldPath } as KubernetesRef<T>;
}

/** The `webService` Service, as the graph would hand it to a status builder. */
function webService(): LoadBalancerServiceRef {
  return {
    status: {
      loadBalancer: {
        ingress: ref<readonly { ip?: string; hostname?: string }[]>(
          'webService',
          'status.loadBalancer.ingress'
        ) as unknown as readonly { ip?: string; hostname?: string }[],
      },
    },
  };
}

async function project(field: 'ip' | 'hostname', status: ServiceStatus): Promise<unknown> {
  const expression = Cel.loadBalancerAddress(webService(), field) as unknown as CelExpression;
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
      webService(),
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
      Cel.firstWhereHas(
        Cel.unsafeListPath<{ chartVersion: string }>('release.status.history'),
        'chartVersion'
      ) as unknown as CelExpression
    ).expression;

    expect(expression).toBe(
      'has(release.status) && has(release.status.history) ? ' +
        '(size(release.status.history.filter(entry, has(entry.chartVersion))) > 0 ? ' +
        'release.status.history.filter(entry, has(entry.chartVersion))[0].chartVersion : "") : ""'
    );
  });

  it('never emits has() on an index expression, nor `in` on a list entry', () => {
    const expression = (Cel.loadBalancerAddress(webService(), 'ip') as unknown as CelExpression)
      .expression;

    expect(expression).not.toMatch(/has\([^)]*\[/);
    expect(expression).not.toMatch(/\bin\b/);
  });

  it('rejects a field that is not a simple CEL identifier', () => {
    expect(() =>
      Cel.firstWhereHas(Cel.unsafeListPath<Record<string, string>>('a.status.list'), 'a.b')
    ).toThrow(/simple CEL identifier/);
  });

  it('rejects a list that was neither selected nor named with unsafeListPath', () => {
    // The type system rejects these at the call site; the runtime check is what
    // stops them reaching the emitted CEL from untyped callers.
    for (const list of ['a.status.list', 42, null, {}]) {
      expect(() =>
        Cel.firstWhereHas(list as unknown as CelListSelector<{ ip: string }>, 'ip')
      ).toThrow(/Cel\.unsafeListPath/);
    }
  });
});

/**
 * The helpers take a list that was *selected* — off a resource or schema proxy,
 * or named deliberately with `unsafeListPath` — so that `field` can be checked
 * against the element type instead of being taken on trust.
 */
describe('selectable list arguments', () => {
  it('projects a list selected off a proxy path', () => {
    const expression = (
      Cel.firstWhereHas(
        webService().status.loadBalancer.ingress as CelListSelector<{ hostname?: string }>,
        'hostname'
      ) as unknown as CelExpression
    ).expression;

    expect(expression).toContain(
      'webService.status.loadBalancer.ingress.filter(entry, has(entry.hostname))'
    );
  });

  it('projects a scalar list named with unsafeListPath', () => {
    const expression = (
      Cel.firstOf(
        Cel.unsafeListPath<string>('objectStore.status.endpoints.secure')
      ) as unknown as CelExpression
    ).expression;

    expect(expression).toBe(
      'has(objectStore.status) && has(objectStore.status.endpoints) && ' +
        'has(objectStore.status.endpoints.secure) ? ' +
        '(size(objectStore.status.endpoints.secure) > 0 ? ' +
        'objectStore.status.endpoints.secure[0] : "") : ""'
    );
  });

  it('rejects an empty unsafeListPath', () => {
    expect(() => Cel.unsafeListPath('   ')).toThrow(/non-empty CEL path/);
  });

  it('emits the same CEL whichever way the list was named', () => {
    const selected = (
      Cel.firstWhereHas(
        webService().status.loadBalancer.ingress as CelListSelector<{ ip?: string }>,
        'ip'
      ) as unknown as CelExpression
    ).expression;
    const named = (
      Cel.firstWhereHas(
        Cel.unsafeListPath<{ ip: string }>('webService.status.loadBalancer.ingress'),
        'ip'
      ) as unknown as CelExpression
    ).expression;

    expect(selected).toBe(named);
  });
});
