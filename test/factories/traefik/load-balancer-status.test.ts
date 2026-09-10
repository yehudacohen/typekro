/**
 * The bootstrap status contract's `loadBalancer` projection, evaluated the way
 * DIRECT mode evaluates it.
 *
 * This suite exists because a serialization test cannot catch the bug it
 * guards. The projection is one CEL string that has to run on two engines —
 * KRO's cel-go and the `cel-js` evaluator direct mode uses — and they disagree
 * about error handling:
 *
 * - `size()` on an absent `ingress` is an evaluation error. cel-go absorbs an
 *   error in one operand of `&&` when the other operand is false; cel-js
 *   evaluates both operands and propagates it.
 * - cel-js rejects a `has()` whose operand is an index expression
 *   (`has(x.ingress[0].hostname)`).
 *
 * With an `&&` chain and a `has()` on the indexed entry, a plain `ClusterIP`
 * Service therefore failed the whole status resolution — `ready`, `failed` and
 * `phase` fell back to their unresolved CEL objects too, not just
 * `loadBalancer`. So this suite drives the real evaluator over every Service
 * status a Traefik edge actually reports.
 */
import { describe, expect, it } from 'bun:test';
import { loadAll } from 'js-yaml';

import { CEL_EXPRESSION_BRAND } from '../../../src/core/constants/brands.js';
import { CelEvaluator } from '../../../src/core/references/cel-evaluator.js';
import { traefikBootstrap } from '../../../src/factories/traefik/compositions/traefik-bootstrap.js';

/** The `loadBalancer.hostname` / `.ip` CEL the composition actually emits. */
function loadBalancerExpressions(): { hostname: string; ip: string } {
  const documents = loadAll(traefikBootstrap.toYaml()).filter(
    (document): document is { kind?: string; spec?: Record<string, unknown> } =>
      document !== null && typeof document === 'object' && !Array.isArray(document)
  );
  for (const document of documents) {
    if (document.kind !== 'ResourceGraphDefinition') continue;
    const schema = (document.spec as { schema?: { kind?: string; status?: unknown } } | undefined)
      ?.schema;
    if (schema?.kind !== 'TraefikBootstrap') continue;
    const loadBalancer = (schema.status as { loadBalancer?: Record<string, string> }).loadBalancer;
    if (loadBalancer?.hostname && loadBalancer.ip) {
      // The RGD carries the CEL wrapped for KRO; strip the `${...}` wrapper to
      // get the expression direct mode evaluates.
      const unwrap = (value: string) => value.replace(/^\$\{/, '').replace(/\}$/, '');
      return { hostname: unwrap(loadBalancer.hostname), ip: unwrap(loadBalancer.ip) };
    }
  }
  throw new Error('No loadBalancer status expressions found in the emitted graph');
}

const EXPRESSIONS = loadBalancerExpressions();
const evaluator = new CelEvaluator();

/** Evaluate one projection against a live Service status. */
async function project(field: 'hostname' | 'ip', status: unknown): Promise<unknown> {
  return evaluator.evaluate(
    { [CEL_EXPRESSION_BRAND]: true, expression: EXPRESSIONS[field] } as never,
    {
      resources: new Map([
        [
          'traefikService',
          { apiVersion: 'v1', kind: 'Service', metadata: { name: 'traefik' }, spec: {}, status },
        ],
      ]),
    } as never
  );
}

describe('loadBalancer projection under the direct-mode CEL evaluator', () => {
  it('reports no address for a Service that has not been given one', async () => {
    // A ClusterIP Service: the API server always writes `status.loadBalancer`,
    // and always leaves it empty. This is the case that used to throw.
    for (const status of [{}, { loadBalancer: {} }, { loadBalancer: { ingress: [] } }]) {
      expect(await project('hostname', status)).toBe('');
      expect(await project('ip', status)).toBe('');
    }
  });

  it('projects a hostname-only address, as a cloud NLB reports it', async () => {
    const status = { loadBalancer: { ingress: [{ hostname: 'edge.example.test' }] } };

    expect(await project('hostname', status)).toBe('edge.example.test');
    // The absent sibling field reports '' rather than failing the projection.
    expect(await project('ip', status)).toBe('');
  });

  it('projects an ip-only address, as an L4 load balancer reports it', async () => {
    const status = { loadBalancer: { ingress: [{ ip: '203.0.113.7' }] } };

    expect(await project('ip', status)).toBe('203.0.113.7');
    expect(await project('hostname', status)).toBe('');
  });

  it('projects both fields when the entry carries both', async () => {
    const status = { loadBalancer: { ingress: [{ ip: '203.0.113.7', hostname: 'edge.example.test' }] } };

    expect(await project('hostname', status)).toBe('edge.example.test');
    expect(await project('ip', status)).toBe('203.0.113.7');
  });

  it('reads the first entry when a load balancer reports several', async () => {
    const status = {
      loadBalancer: {
        ingress: [{ hostname: 'edge-a.example.test' }, { hostname: 'edge-b.example.test' }],
      },
    };

    expect(await project('hostname', status)).toBe('edge-a.example.test');
  });
});
