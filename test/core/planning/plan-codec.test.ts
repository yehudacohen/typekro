import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { identifyRuntimeReadinessEvaluator } from '../../../src/core/readiness/portable-strategies.js';
import {
  decodeDesiredStatePlan,
  encodeDesiredStatePlan,
} from '../../../src/experimental-planning.js';
import { createResource, kubernetesComposition, simple } from '../../../src/index.js';

const fixture = kubernetesComposition(
  {
    name: 'semantic-plan-codec-fixture',
    apiVersion: 'testing.typekro.dev/v1alpha1',
    kind: 'SemanticPlanCodecFixture',
    revision: '1',
    spec: type({ name: 'string', namespace: 'string' }),
    status: type({ name: 'string' }),
  },
  (spec) => {
    const config = simple.ConfigMap({
      id: 'config',
      name: spec.name,
      namespace: spec.namespace,
      data: { mode: 'test' },
    });
    return { name: config.metadata.name! };
  }
);

const runtimeReadinessFixture = kubernetesComposition(
  {
    name: 'runtime-readiness-plan-codec-fixture',
    apiVersion: 'testing.typekro.dev/v1alpha1',
    kind: 'RuntimeReadinessPlanCodecFixture',
    revision: '1',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const resource = createResource({
      id: 'clockBound',
      apiVersion: 'testing.typekro.dev/v1',
      kind: 'ClockBoundResource',
      metadata: { name: spec.name },
      spec: {},
      status: { ready: false },
    }).withReadinessEvaluator(
      identifyRuntimeReadinessEvaluator(
        (live: unknown) => ({
          ready: Boolean((live as { status?: { ready?: boolean } }).status?.ready),
        }),
        {
          reason: 'ambient-clock',
          description: 'The production evaluator also compares a status timestamp to the clock.',
        }
      )
    );
    return { ready: resource.status.ready };
  }
);

const unclassifiedReadinessFixture = kubernetesComposition(
  {
    name: 'unclassified-readiness-fixture',
    apiVersion: 'testing.typekro.dev/v1alpha1',
    kind: 'UnclassifiedReadinessFixture',
    revision: '1',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const resource = createResource({
      id: 'unclassified',
      apiVersion: 'testing.typekro.dev/v1',
      kind: 'UnclassifiedResource',
      metadata: { name: spec.name },
      spec: {},
      status: { ready: false },
    }).withReadinessEvaluator((live: unknown) => ({
      ready: Boolean((live as { status?: { ready?: boolean } }).status?.ready),
    }));
    return { ready: resource.status.ready };
  }
);

describe('DesiredStatePlan codec', () => {
  it('canonically round-trips and validates every digest layer', () => {
    const plan = fixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const encoded = encodeDesiredStatePlan(plan);
    const decoded = decodeDesiredStatePlan(encoded);

    expect(decoded).toEqual(plan);
    expect(encodeDesiredStatePlan(decoded)).toBe(encoded);
  });

  it('persists explicit runtime readiness classification through the canonical codec', () => {
    const plan = runtimeReadinessFixture.plan!({ name: 'clock-bound' }, { strict: true });
    const decoded = decodeDesiredStatePlan(encodeDesiredStatePlan(plan));

    expect(decoded.nodes.find((node) => node.id === 'clockBound')?.readinessStrategy).toEqual({
      kind: 'runtime-binding',
      binding: 'readiness:clockBound',
      version: 1,
      classification: {
        reason: 'ambient-clock',
        description: 'The production evaluator also compares a status timestamp to the clock.',
      },
    });
  });

  it('rejects unclassified readiness evaluators in strict semantic planning', () => {
    expect(() => unclassifiedReadinessFixture.plan!({ name: 'unknown' }, { strict: true })).toThrow(
      'Strict semantic planning rejected the composition'
    );

    const plan = unclassifiedReadinessFixture.plan!({ name: 'unknown' });
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PLAN_READINESS_EVALUATOR_UNCLASSIFIED',
        severity: 'error',
        path: '$.nodes.unclassified.readinessStrategy',
      })
    );
  });

  it('rejects semantic-content tampering even when the JSON shape remains valid', () => {
    const plan = fixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const corrupted = structuredClone(plan) as unknown as {
      spec: { entries: Array<{ key: string; value: unknown }> };
    };
    const name = corrupted.spec.entries.find((entry) => entry.key === 'name');
    name!.value = { kind: 'literal', value: 'changed' };

    expect(() => decodeDesiredStatePlan(JSON.stringify(corrupted))).toThrow(
      'Semantic content digest mismatch'
    );
  });

  it('rejects graph edges whose endpoint is absent', () => {
    const plan = fixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const corrupted = structuredClone(plan) as unknown as {
      edges: Record<string, unknown>[];
    };
    corrupted.edges.push({
      kind: 'existence',
      prerequisite: 'missing',
      dependent: 'config',
    });

    expect(() => decodeDesiredStatePlan(JSON.stringify(corrupted))).toThrow(
      'references unknown node missing'
    );
  });

  it('rejects persisted status that is not a faithful hydrated-schema subset', () => {
    const plan = fixture.plan!({ name: 'demo', namespace: 'apps' }, { strict: true });
    const corrupted = structuredClone(plan) as unknown as {
      status: {
        persistedSchema: {
          root: { properties: Array<{ name: string; required: boolean }> };
        };
      };
    };
    corrupted.status.persistedSchema.root.properties[0]!.required = false;

    expect(() => decodeDesiredStatePlan(JSON.stringify(corrupted))).toThrow(
      'Schema digest mismatch'
    );
  });
});
