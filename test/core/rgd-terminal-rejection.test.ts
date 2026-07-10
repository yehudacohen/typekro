/**
 * The RGD readiness evaluator must flag a Kro graph-acceptance rejection (`GraphAccepted=False` for the
 * current generation) as TERMINAL, so the readiness waiter fails fast with the reason instead of polling
 * to the deadline (which surfaced an opaque "Delay aborted" that read like a cluster-access outage).
 * Transient non-acceptance `False` conditions stay retryable.
 */
import { describe, expect, it } from 'bun:test';
import { resourceGraphDefinition } from '../../src/factories/kro/resource-graph-definition.js';
import { getReadinessEvaluator } from '../utils/mock-factories.js';

const evaluator = () => {
  const rgd = resourceGraphDefinition({ metadata: { name: 'cs' } });
  const ev = getReadinessEvaluator(rgd);
  if (!ev) throw new Error('no readiness evaluator');
  return ev as (live: unknown) => { ready: boolean; terminal?: boolean; message?: string };
};

const liveRGD = (conditions: unknown[]) => ({
  apiVersion: 'kro.run/v1alpha1',
  kind: 'ResourceGraphDefinition',
  metadata: { name: 'cs', generation: 2, uid: 'u' },
  status: { state: 'Inactive', conditions },
});

describe('RGD readiness terminal detection', () => {
  it('marks GraphAccepted=False as terminal with the Kro reason', () => {
    const r = evaluator()(
      liveRGD([
        { type: 'KindReady', status: 'True', observedGeneration: 2 },
        {
          type: 'GraphAccepted',
          status: 'False',
          reason: 'InvalidResourceGraph',
          message: 'expected string type for path spec...env[10].value, got object',
          observedGeneration: 2,
        },
      ])
    );
    expect(r.ready).toBe(false);
    expect(r.terminal).toBe(true);
    expect(r.message).toContain('got object');
  });

  it('does NOT mark a transient non-acceptance False condition terminal', () => {
    const r = evaluator()(
      liveRGD([{ type: 'SomethingSyncing', status: 'False', message: 'still syncing', observedGeneration: 2 }])
    );
    expect(r.ready).toBe(false);
    expect(r.terminal).toBeUndefined();
  });
});
