/**
 * `verticalPodAutoscaler`, `vpaRecommendOnly`, readiness, validation and the
 * HPA conflict check, plus KRO/direct parity inside a composition.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { type } from 'arktype';
import { loadAll } from 'js-yaml';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { getComponentLogger } from '../../../src/core/logging/index.js';
import { horizontalPodAutoscaler } from '../../../src/factories/kubernetes/autoscaling/horizontal-pod-autoscaler.js';
import { createResource } from '../../../src/factories/shared.js';
import { Deployment } from '../../../src/factories/simple/workloads/deployment.js';
import {
  evaluateVpaRecommendation,
  vpaAcceptedReadinessEvaluator,
  vpaRecommendationProvided,
} from '../../../src/factories/vpa/resources/readiness.js';
import {
  verticalPodAutoscaler,
  vpaRecommendOnly,
} from '../../../src/factories/vpa/resources/vertical-pod-autoscaler.js';
import type { VerticalPodAutoscalerSpec } from '../../../src/factories/vpa/types.js';
import {
  findVpaAutoscalerConflicts,
  validateVerticalPodAutoscalerSpec,
} from '../../../src/factories/vpa/utils/validation.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;
beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
});
afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) delete process.env.TYPEKRO_STRICT_CEL;
  else process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
});

const target = { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api' };

describe('verticalPodAutoscaler', () => {
  it('renders an autoscaling.k8s.io/v1 VerticalPodAutoscaler', () => {
    const vpa = verticalPodAutoscaler({
      name: 'api',
      namespace: 'shop',
      labels: { team: 'checkout' },
      spec: {
        targetRef: target,
        updatePolicy: { updateMode: 'InPlaceOrRecreate', minReplicas: 2 },
        resourcePolicy: {
          containerPolicies: [
            {
              containerName: '*',
              minAllowed: { cpu: '50m', memory: '64Mi' },
              maxAllowed: { cpu: '2', memory: '4Gi' },
              controlledResources: ['cpu', 'memory'],
              controlledValues: 'RequestsOnly',
            },
            { containerName: 'istio-proxy', mode: 'Off' },
          ],
        },
        recommenders: [{ name: 'default' }],
      },
    });
    expect(vpa.apiVersion).toBe('autoscaling.k8s.io/v1');
    expect(vpa.kind).toBe('VerticalPodAutoscaler');
    expect(vpa.metadata.namespace).toBe('shop');
    expect(vpa.metadata.labels).toEqual({ team: 'checkout' });
    expect(vpa.spec.updatePolicy?.updateMode).toBe('InPlaceOrRecreate');
    expect(vpa.spec.resourcePolicy?.containerPolicies?.[1]).toEqual({
      containerName: 'istio-proxy',
      mode: 'Off',
    });
  });

  it('throws on specs the VPA rejects', () => {
    expect(() =>
      verticalPodAutoscaler({
        name: 'api',
        spec: { targetRef: target, recommenders: [{ name: 'a' }, { name: 'b' }] },
      })
    ).toThrow('at most one recommender');
    expect(() =>
      verticalPodAutoscaler({ name: 'api', spec: { targetRef: { kind: 'Deployment', name: '' } } })
    ).toThrow('targetRef needs a kind and a name');
  });

  it('waits for a recommendation unless readiness is "accepted"', () => {
    const waiting = verticalPodAutoscaler({ name: 'api', spec: { targetRef: target } });
    expect(waiting.readinessEvaluator?.({ status: {} })).toMatchObject({ ready: false });
    const accepted = verticalPodAutoscaler({
      name: 'api',
      spec: { targetRef: target },
      readiness: 'accepted',
    });
    expect(accepted.readinessEvaluator).toBe(vpaAcceptedReadinessEvaluator);
    expect(accepted.readinessEvaluator?.({ metadata: { resourceVersion: '1' } })).toMatchObject({
      ready: true,
    });
  });
});

describe('VPA readiness', () => {
  const live = (conditions: unknown[]) => ({ status: { conditions } });

  it('is ready on RecommendationProvided=True', () => {
    expect(
      evaluateVpaRecommendation(live([{ type: 'RecommendationProvided', status: 'True' }]))
    ).toMatchObject({ ready: true, reason: 'RecommendationProvided' });
  });

  it('reports why there is no recommendation yet', () => {
    expect(evaluateVpaRecommendation({})).toMatchObject({ ready: false, reason: 'StatusMissing' });
    expect(
      evaluateVpaRecommendation(
        live([
          { type: 'RecommendationProvided', status: 'False' },
          { type: 'NoPodsMatched', status: 'True', message: 'No pods match this VPA object' },
        ])
      )
    ).toMatchObject({
      ready: false,
      reason: 'NoPodsMatched',
      message: 'No pods match this VPA object',
    });
    expect(
      evaluateVpaRecommendation(
        live([
          { type: 'RecommendationProvided', status: 'True' },
          { type: 'ConfigUnsupported', status: 'True', message: 'Unknown update mode' },
        ])
      )
    ).toMatchObject({ ready: false, reason: 'ConfigUnsupported' });
  });
});

describe('vpaRecommendOnly', () => {
  it('builds an Off-mode VPA from a targetRef', () => {
    const vpa = vpaRecommendOnly(target, { namespace: 'shop', id: 'apiVpa' });
    expect(vpa.metadata.name).toBe('api');
    expect(JSON.parse(JSON.stringify(vpa.spec))).toEqual({
      targetRef: target,
      updatePolicy: { updateMode: 'Off' },
    });
  });

  it('takes the workload resource itself', () => {
    const deployment = Deployment({ name: 'web', image: 'nginx', id: 'web' });
    const vpa = vpaRecommendOnly(deployment, {
      name: 'web-vpa',
      containerPolicies: [{ containerName: '*', controlledResources: ['memory'] }],
    });
    expect(vpa.metadata.name).toBe('web-vpa');
    expect(vpa.spec.targetRef).toEqual({ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' });
    expect(vpa.spec.resourcePolicy?.containerPolicies).toEqual([
      { containerName: '*', controlledResources: ['memory'] },
    ]);
  });
});

describe('validateVerticalPodAutoscalerSpec', () => {
  it('flags the deprecated Auto mode, duplicate policies and an empty resource list', () => {
    const spec: VerticalPodAutoscalerSpec = {
      targetRef: target,
      updatePolicy: { updateMode: 'Auto' },
      resourcePolicy: {
        containerPolicies: [
          { containerName: 'app', controlledResources: [] },
          { containerName: 'app' },
        ],
      },
    };
    expect(
      validateVerticalPodAutoscalerSpec(spec).map((issue) => [issue.severity, issue.path])
    ).toEqual([
      ['warning', 'updatePolicy.updateMode'],
      ['warning', 'resourcePolicy.containerPolicies[0].controlledResources'],
      ['error', 'resourcePolicy.containerPolicies[1].containerName'],
    ]);
  });

  it('warns that InPlace needs its feature gate', () => {
    const issues = validateVerticalPodAutoscalerSpec({
      targetRef: target,
      updatePolicy: { updateMode: 'InPlace' },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('--feature-gates=InPlace=true');
  });

  it('accepts a minimal spec', () => {
    expect(validateVerticalPodAutoscalerSpec({ targetRef: target })).toEqual([]);
  });
});

describe('HPA / ScaledObject conflicts', () => {
  const schema = {
    spec: type({ replicas: 'number' }),
    status: type({ ok: 'boolean' }),
  };

  function cpuHpa(name = 'api') {
    return horizontalPodAutoscaler({
      metadata: { name: `${name}-hpa` },
      spec: {
        scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name },
        minReplicas: 2,
        maxReplicas: 10,
        metrics: [
          {
            type: 'Resource',
            resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } },
          },
        ],
      },
      id: `${name}Hpa`,
    });
  }

  function conflictsIn(build: () => VerticalPodAutoscalerSpec): string[] {
    const messages: string[] = [];
    const composition = kubernetesComposition(
      { name: 'conflicts', kind: 'Conflicts', ...schema },
      () => {
        messages.push(
          ...findVpaAutoscalerConflicts(build(), undefined).map((issue) => issue.message)
        );
        return { ok: true };
      }
    );
    composition.factory('direct', { namespace: 'default' }).toYaml({ replicas: 1 });
    return [...new Set(messages)];
  }

  it('warns when an HPA scales the same target on CPU', () => {
    const messages = conflictsIn(() => {
      cpuHpa();
      return { targetRef: target, updatePolicy: { updateMode: 'Recreate' } };
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(
      'HorizontalPodAutoscaler "api-hpa" also scales Deployment/api on cpu'
    );
  });

  it('warns about a KEDA ScaledObject with a memory trigger', () => {
    const messages = conflictsIn(() => {
      createResource({
        apiVersion: 'keda.sh/v1alpha1',
        kind: 'ScaledObject',
        metadata: { name: 'api-scaler' },
        spec: {
          scaleTargetRef: { name: 'api' },
          triggers: [{ type: 'memory', metricType: 'Utilization', metadata: { value: '80' } }],
        },
        id: 'apiScaler',
      });
      return { targetRef: target };
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('ScaledObject "api-scaler"');
    expect(messages[0]).toContain('on memory');
  });

  it('stays quiet for Off mode, other targets and disjoint resources', () => {
    expect(
      conflictsIn(() => {
        cpuHpa();
        return { targetRef: target, updatePolicy: { updateMode: 'Off' } };
      })
    ).toEqual([]);
    expect(
      conflictsIn(() => {
        cpuHpa('worker');
        return { targetRef: target };
      })
    ).toEqual([]);
    expect(
      conflictsIn(() => {
        cpuHpa();
        return {
          targetRef: target,
          resourcePolicy: {
            containerPolicies: [{ containerName: '*', controlledResources: ['memory'] }],
          },
        };
      })
    ).toEqual([]);
  });

  it('still warns when only named containers are narrowed', () => {
    // The usual sidecar exclusion leaves the main container on cpu and memory.
    expect(
      conflictsIn(() => {
        cpuHpa();
        return {
          targetRef: target,
          resourcePolicy: { containerPolicies: [{ containerName: 'istio-proxy', mode: 'Off' }] },
        };
      })
    ).toHaveLength(1);
    expect(
      conflictsIn(() => {
        cpuHpa();
        return {
          targetRef: target,
          resourcePolicy: {
            containerPolicies: [{ containerName: 'app', controlledResources: ['memory'] }],
          },
        };
      })
    ).toHaveLength(1);
    // A named policy can add cpu back under a memory-only '*'.
    expect(
      conflictsIn(() => {
        cpuHpa();
        return {
          targetRef: target,
          resourcePolicy: {
            containerPolicies: [
              { containerName: '*', controlledResources: ['memory'] },
              { containerName: 'app', controlledResources: ['cpu'] },
            ],
          },
        };
      })
    ).toHaveLength(1);
    expect(
      conflictsIn(() => {
        cpuHpa();
        return {
          targetRef: target,
          resourcePolicy: { containerPolicies: [{ containerName: '*', mode: 'Off' }] },
        };
      })
    ).toEqual([]);
  });

  it('is logged by the factory', () => {
    const logger = getComponentLogger('vpa-validation');
    const warn = spyOn(Object.getPrototypeOf(logger), 'warn');
    try {
      const composition = kubernetesComposition(
        { name: 'conflicts-log', kind: 'ConflictsLog', ...schema },
        () => {
          cpuHpa();
          verticalPodAutoscaler({ name: 'api', spec: { targetRef: target }, id: 'apiVpa' });
          return { ok: true };
        }
      );
      composition.factory('direct', { namespace: 'default' }).toYaml({ replicas: 1 });
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes('also scales Deployment/api'))
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('returns nothing outside a composition', () => {
    expect(findVpaAutoscalerConflicts({ targetRef: target }, undefined)).toEqual([]);
  });
});

describe('VerticalPodAutoscaler — KRO/direct parity', () => {
  const rightsizing = kubernetesComposition(
    {
      name: 'rightsizing',
      kind: 'Rightsizing',
      spec: type({ app: 'string', maxMemory: 'string' }),
      status: type({ recommended: 'boolean' }),
    },
    (spec) => {
      const vpa = verticalPodAutoscaler({
        name: spec.app,
        spec: {
          targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: spec.app },
          updatePolicy: { updateMode: 'Initial' },
          resourcePolicy: {
            containerPolicies: [{ containerName: '*', maxAllowed: { memory: spec.maxMemory } }],
          },
        },
        id: 'appVpa',
      });
      const sidecar = vpaRecommendOnly(
        { apiVersion: 'apps/v1', kind: 'Deployment', name: 'sidecar-injector' },
        { id: 'sidecarVpa' }
      );
      return { recommended: vpaRecommendationProvided(vpa, sidecar) };
    }
  );

  const SPEC = { app: 'checkout', maxMemory: '2Gi' };

  interface Doc {
    kind?: string;
    metadata?: { name?: string };
    spec?: {
      resources?: { id: string; template: Doc }[];
      schema?: { status?: Record<string, string> };
    };
  }

  function substitute(value: unknown): unknown {
    if (typeof value === 'string') {
      const match = /^\$\{schema\.spec\.(\w+)\}$/.exec(value);
      return match ? SPEC[match[1] as keyof typeof SPEC] : value;
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, substitute(child)])
      );
    }
    return value;
  }

  it('renders the same manifests in both modes', () => {
    const direct = loadAll(
      rightsizing.factory('direct', { namespace: 'shop' }).toYaml(SPEC)
    ) as Doc[];
    const rgd = (loadAll(rightsizing.toYaml()) as Doc[]).find(
      (doc) => doc.kind === 'ResourceGraphDefinition'
    );
    const templates = (rgd?.spec?.resources ?? []).map((resource) => substitute(resource.template));
    // Direct mode stamps the factory namespace; KRO uses the instance's.
    const withoutNamespace = (doc: Doc) => {
      const { namespace: _namespace, ...metadata } = (doc.metadata ?? {}) as Record<
        string,
        unknown
      >;
      return { ...doc, metadata };
    };
    const byName = (docs: unknown[]) =>
      Object.fromEntries(
        (docs as Doc[]).map((doc) => [`${doc.kind}/${doc.metadata?.name}`, withoutNamespace(doc)])
      );
    expect(
      direct.every((doc) => (doc.metadata as { namespace?: string }).namespace === 'shop')
    ).toBe(true);
    expect(byName(templates)).toEqual(byName(direct));
  });

  it('emits the recommendation status from both VPAs', () => {
    const rgd = (loadAll(rightsizing.toYaml()) as Doc[]).find(
      (doc) => doc.kind === 'ResourceGraphDefinition'
    );
    const status = rgd?.spec?.schema?.status ?? {};
    expect(status.recommended).toContain('appVpa.status.conditions');
    expect(status.recommended).toContain('sidecarVpa.status.conditions');
    expect(status.recommended).toContain('"RecommendationProvided"');
  });
});
