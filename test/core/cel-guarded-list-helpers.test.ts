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
  type CelFallbackArgs,
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

/**
 * The fallback is the `else` branch of the emitted ternary, so it has to carry
 * the type being projected twice over: the projection is *typed* as the field it
 * projects, and cel-go rejects a ternary whose branches disagree at the point
 * KRO admits the ResourceGraphDefinition — while cel-js evaluates it happily, so
 * a mismatch survives every direct-mode test and surfaces only on a cluster.
 *
 * These are compile-time assertions in the convention the repo already uses: if
 * this file typechecks the tests pass, and a `@ts-expect-error` that stops being
 * an error is reported by tsc as an unused directive.
 */
describe('fallback is constrained to the projected type', () => {
  /** Index of `token` in `text` outside any parenthesized group, or -1. */
  function topLevelIndex(text: string, token: string): number {
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      else if (depth === 0 && text.startsWith(token, index)) return index;
    }
    return -1;
  }

  /**
   * The two fallback branches of an emitted projection, as text.
   *
   * The shape is `<guard> ? (<size check> ? <projection> : <fallback>) : <fallback>`.
   * A fallback that is itself a projection contains its own ternary, so the
   * split has to be paren-aware rather than a `lastIndexOf`.
   */
  function fallbackBranches(expression: string): [string, string] {
    const colon = topLevelIndex(expression, ' : ');
    const question = topLevelIndex(expression, ' ? ');
    expect(question).toBeGreaterThan(0);
    expect(colon).toBeGreaterThan(question);

    const outer = expression.slice(colon + 3);
    const body = expression.slice(question + 3, colon).replace(/^\(|\)$/g, '');
    const inner = body.slice(topLevelIndex(body, ' : ') + 3);
    return [inner, outer];
  }

  type Endpoint = { host: string; port: number; ready?: boolean };
  const endpoints = Cel.unsafeListPath<Endpoint>('gateway.status.endpoints');
  const ports = Cel.unsafeListPath<number>('gateway.status.ports');

  it('accepts a fallback of the projected type and rejects every other shape', () => {
    // A string field may be left to the '' default.
    const host = Cel.firstWhereHas(endpoints, 'host');
    // ...or given an explicit string.
    const explicitHost = Cel.firstWhereHas(endpoints, 'host', 'pending');

    // @ts-expect-error — a numeric fallback on a string field emits a ternary
    // whose branches disagree, which cel-go rejects at RGD admission.
    const mistypedHost = Cel.firstWhereHas(endpoints, 'host', 8080);

    // @ts-expect-error — a numeric field has no '' default to fall back to, so
    // the fallback is required rather than silently ''.
    const barePort = Cel.firstWhereHas(endpoints, 'port');

    // A numeric field with a numeric fallback is the supported form.
    const port = Cel.firstWhereHas(endpoints, 'port', 8080);

    // @ts-expect-error — and a string fallback on a numeric field is rejected
    // in the same way as the reverse.
    const mistypedPort = Cel.firstWhereHas(endpoints, 'port', 'none');

    // A boolean field likewise has no string default.
    // @ts-expect-error — boolean field, no fallback.
    const bareReady = Cel.firstWhereHas(endpoints, 'ready');
    const ready = Cel.firstWhereHas(endpoints, 'ready', false);

    // The same rules apply to the scalar-list helper.
    const secure = Cel.firstOf(Cel.unsafeListPath<string>('store.status.endpoints.secure'));
    // @ts-expect-error — a list of numbers has no '' default.
    const barePort0 = Cel.firstOf(ports);
    const port0 = Cel.firstOf(ports, 0);

    void [
      host,
      explicitHost,
      mistypedHost,
      barePort,
      port,
      mistypedPort,
      bareReady,
      ready,
      secure,
      barePort0,
      port0,
    ];
    expect(true).toBe(true);
  });

  it('accepts a KubernetesRef or CEL expression of the matching type as the fallback', () => {
    const hostRef = ref<string>('fallbackService', 'status.host');
    const portRef = ref<number>('fallbackService', 'status.port');

    const host = Cel.firstWhereHas(endpoints, 'host', hostRef);
    const port = Cel.firstWhereHas(endpoints, 'port', portRef);
    // A projection is itself a CelExpression of the projected type, so it
    // composes as the fallback of another projection — which is how the Rook
    // composition prefers a secure endpoint over an insecure one.
    const chained = Cel.firstOf(
      Cel.unsafeListPath<string>('store.status.endpoints.secure'),
      Cel.firstOf(Cel.unsafeListPath<string>('store.status.endpoints.insecure'))
    );

    // @ts-expect-error — a ref of the wrong type is rejected like a literal of
    // the wrong type.
    const mistyped = Cel.firstWhereHas(endpoints, 'host', portRef);

    void [host, port, chained, mistyped];
    expect(true).toBe(true);
  });

  it('renders every accepted fallback shape, and renders it identically in both branches', () => {
    const cases = [
      Cel.firstWhereHas(endpoints, 'host', 'pending'),
      Cel.firstWhereHas(endpoints, 'port', 8080),
      Cel.firstWhereHas(endpoints, 'ready', false),
      Cel.firstWhereHas(endpoints, 'host', ref<string>('fallbackService', 'status.host')),
      Cel.firstOf(ports, 0),
      Cel.firstOf(
        Cel.unsafeListPath<string>('store.status.endpoints.secure'),
        Cel.firstOf(Cel.unsafeListPath<string>('store.status.endpoints.insecure'))
      ),
    ] as unknown as CelExpression[];

    for (const { expression } of cases) {
      const [inner, outer] = fallbackBranches(expression);

      // Both branches have to render the fallback identically: a ternary whose
      // branches differ is what cel-go rejects at RGD admission.
      expect(outer.length).toBeGreaterThan(0);
      expect(inner).toBe(outer);
    }
  });

  it('renders each fallback type as the CEL literal of that type', () => {
    const rendered = (value: unknown) => fallbackBranches((value as CelExpression).expression)[1];

    expect(rendered(Cel.firstWhereHas(endpoints, 'host', 'pending'))).toBe('"pending"');
    expect(rendered(Cel.firstWhereHas(endpoints, 'port', 8080))).toBe('8080');
    expect(rendered(Cel.firstWhereHas(endpoints, 'ready', false))).toBe('false');
    expect(rendered(Cel.firstOf(ports, 0))).toBe('0');
    expect(
      rendered(Cel.firstWhereHas(endpoints, 'host', ref<string>('fallbackService', 'status.host')))
    ).toBe('fallbackService.status.host');
    expect(rendered(Cel.firstWhereHas(endpoints, 'host'))).toBe('""');
  });
});

/**
 * Whether the fallback argument may be omitted is a question about the *default
 * value*, not about the projected type in general. The default is `''`, so the
 * test is `'' extends T`. The narrower `string extends T` — does `T` admit any
 * string at all — gets the literal-union case wrong: `'' | 'Ready' | 'Failed'`
 * admits `''` perfectly well.
 */
describe('the default fallback is offered exactly where the projected type admits it', () => {
  type Assert<T extends true> = T;
  /** True when {@link CelFallbackArgs} lets the argument be left out. */
  type FallbackOptional<T> = [] extends CelFallbackArgs<T> ? true : false;

  type Phased = {
    /** A literal union the `''` default is a member of. */
    phase: '' | 'Ready' | 'Failed';
    /** A literal union it is not. */
    outcome: 'Ready' | 'Failed';
    /** A template-literal type no empty string inhabits. */
    width: `${number}px`;
  };
  const phases = Cel.unsafeListPath<Phased>('gateway.status.phases');

  it('decides optionality by whether the empty string is assignable', () => {
    // Asserted as values so the aliases are used rather than dangling, which is
    // the same trick the `void [...]` blocks above play for the value-level
    // compile-time assertions.
    const optionality: [
      // `''` is a member, so the default stands and the argument is optional.
      Assert<FallbackOptional<'' | 'Ready' | 'Failed'>>,
      // `string` admits `''` too, which is the case both tests agreed on.
      Assert<FallbackOptional<string>>,
      // `''` is not a member: required.
      Assert<FallbackOptional<'Ready' | 'Failed'> extends false ? true : false>,
      // Nothing string-shaped at all: required.
      Assert<FallbackOptional<number> extends false ? true : false>,
      Assert<FallbackOptional<boolean> extends false ? true : false>,
      // A template-literal type that no empty string inhabits: required, which
      // is where `string extends T` happened to give the same answer.
      Assert<FallbackOptional<`${number}px`> extends false ? true : false>,
    ] = [true, true, true, true, true, true];

    expect(optionality).toHaveLength(6);
  });

  it('accepts the default on a literal union containing the empty string', () => {
    // Used to be a compile error: `string extends '' | 'Ready' | 'Failed'` is
    // false, so the author had to restate the default the helper would have
    // used anyway.
    const bare = Cel.firstWhereHas(phases, 'phase');
    const explicit = Cel.firstWhereHas(phases, 'phase', 'Ready');

    // @ts-expect-error — still a member check: a string outside the union is
    // rejected exactly as a number would be.
    const outsideUnion = Cel.firstWhereHas(phases, 'phase', 'Pending');

    void [bare, explicit, outsideUnion];
    expect(true).toBe(true);
  });

  it('still requires a fallback where the empty string is not assignable', () => {
    // @ts-expect-error — `''` is not one of 'Ready' | 'Failed'.
    const bareOutcome = Cel.firstWhereHas(phases, 'outcome');
    const outcome = Cel.firstWhereHas(phases, 'outcome', 'Failed');

    // @ts-expect-error — no empty string inhabits `${number}px`.
    const bareWidth = Cel.firstWhereHas(phases, 'width');
    const width = Cel.firstWhereHas(phases, 'width', '120px');

    void [bareOutcome, outcome, bareWidth, width];
    expect(true).toBe(true);
  });

  it('renders the default the type level just admitted', () => {
    // The runtime half has to agree with the type level: `defaultedFallback()`
    // supplies `''` for the omitted argument, and `''` is what the union
    // declares, so the emitted ternary is well typed on both engines.
    const { expression } = Cel.firstWhereHas(phases, 'phase') as unknown as CelExpression;

    expect(expression.endsWith(' : ""')).toBe(true);
    expect(expression).toContain('size(gateway.status.phases.filter(entry, has(entry.phase))) > 0');
  });
});
