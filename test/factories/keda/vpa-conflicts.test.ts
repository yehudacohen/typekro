/**
 * The VPA and KEDA factories warn about each other in both directions.
 *
 * Each factory only sees the resources declared before it, so a VPA declared
 * before a ScaledObject is caught by `scaledObject`, and one declared after it
 * by `verticalPodAutoscaler`. Either order must produce exactly one warning
 * when the VPA sets a resource the ScaledObject scales on, and none otherwise.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { getComponentLogger } from '../../../src/core/logging/index.js';
import { scaledObject } from '../../../src/factories/keda/resources/scaled-object.js';
import type { KedaTrigger } from '../../../src/factories/keda/types.js';
import { verticalPodAutoscaler } from '../../../src/factories/vpa/resources/vertical-pod-autoscaler.js';
import type { VerticalPodAutoscalerSpec } from '../../../src/factories/vpa/types.js';

type Mode = NonNullable<NonNullable<VerticalPodAutoscalerSpec['updatePolicy']>['updateMode']>;
type Resource = 'cpu' | 'memory';

const schema = { spec: type({ replicas: 'number' }), status: type({ ok: 'boolean' }) };
const target = { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api' };

const trigger = (resource: Resource): KedaTrigger => ({
  type: resource,
  metricType: 'Utilization',
  metadata: { value: '70' },
});

function declareVpa(mode: Mode, controlledResources?: Resource[]) {
  verticalPodAutoscaler({
    name: 'api-vpa',
    spec: {
      targetRef: target,
      updatePolicy: { updateMode: mode },
      ...(controlledResources
        ? { resourcePolicy: { containerPolicies: [{ containerName: '*', controlledResources }] } }
        : {}),
    },
    id: 'apiVpa',
  });
}

function declareScaledObject(resource: Resource) {
  scaledObject({
    name: 'api-scaler',
    spec: { scaleTargetRef: { name: 'api' }, minReplicaCount: 1, triggers: [trigger(resource)] },
    id: 'apiScaler',
  });
}

/** Conflict warnings the two factories log while the composition renders. */
function conflictWarnings(body: () => void): string[] {
  const logger = getComponentLogger('vpa-validation');
  const warn = spyOn(Object.getPrototypeOf(logger), 'warn');
  try {
    const composition = kubernetesComposition(
      { name: 'vpa-keda-conflicts', kind: 'VpaKedaConflicts', ...schema },
      () => {
        body();
        return { ok: true };
      }
    );
    composition.factory('direct', { namespace: 'default' }).toYaml({ replicas: 1 });
    const messages = warn.mock.calls
      .map((call) => String(call[0]))
      .filter(
        (message) =>
          message.includes('ScaledObject "api-scaler" also scales') ||
          message.includes('VerticalPodAutoscaler "api-vpa" also sets')
      );
    return [...new Set(messages)];
  } finally {
    warn.mockRestore();
  }
}

describe('VPA / KEDA conflicts, both directions', () => {
  for (const mode of ['Auto', 'Recreate'] as const) {
    for (const resource of ['cpu', 'memory'] as const) {
      it(`${mode} VPA then a ${resource} ScaledObject: scaledObject warns`, () => {
        const messages = conflictWarnings(() => {
          declareVpa(mode);
          declareScaledObject(resource);
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain(
          `VerticalPodAutoscaler "api-vpa" also sets ${resource} requests on Deployment/api`
        );
      });

      it(`a ${resource} ScaledObject then an ${mode} VPA: verticalPodAutoscaler warns`, () => {
        const messages = conflictWarnings(() => {
          declareScaledObject(resource);
          declareVpa(mode);
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain(
          `ScaledObject "api-scaler" also scales Deployment/api on ${resource}`
        );
      });
    }
  }

  it('stays quiet in both orders for an Off VPA', () => {
    expect(
      conflictWarnings(() => {
        declareVpa('Off');
        declareScaledObject('cpu');
      })
    ).toEqual([]);
    expect(
      conflictWarnings(() => {
        declareScaledObject('cpu');
        declareVpa('Off');
      })
    ).toEqual([]);
  });

  it('stays quiet in both orders when the VPA controls only the other resource', () => {
    expect(
      conflictWarnings(() => {
        declareVpa('Recreate', ['memory']);
        declareScaledObject('cpu');
      })
    ).toEqual([]);
    expect(
      conflictWarnings(() => {
        declareScaledObject('cpu');
        declareVpa('Recreate', ['memory']);
      })
    ).toEqual([]);
  });
});
