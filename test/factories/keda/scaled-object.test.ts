/**
 * `scaledObject`, `scaledJob`, the trigger authentications, readiness,
 * validation and the HPA/VPA conflict check, plus KRO/direct parity.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { type } from 'arktype';
import { loadAll } from 'js-yaml';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { getComponentLogger } from '../../../src/core/logging/index.js';
import {
  evaluateKedaReadiness,
  kedaActive,
  kedaReady,
  scaledObjectReadinessEvaluator,
  triggerAuthenticationReadinessEvaluator,
} from '../../../src/factories/keda/resources/readiness.js';
import { scaledJob } from '../../../src/factories/keda/resources/scaled-job.js';
import { scaledObject } from '../../../src/factories/keda/resources/scaled-object.js';
import {
  clusterTriggerAuthentication,
  triggerAuthentication,
} from '../../../src/factories/keda/resources/trigger-authentication.js';
import { kedaTrigger } from '../../../src/factories/keda/resources/triggers.js';
import type { KedaTrigger, ScaledObjectSpec } from '../../../src/factories/keda/types.js';
import {
  findKedaAutoscalerConflicts,
  validateScaledJobSpec,
  validateScaledObjectSpec,
} from '../../../src/factories/keda/utils/validation.js';
import { REQUIRED_FIELD_SENTINEL } from '../../../src/core/serialization/schema.js';
import { horizontalPodAutoscaler } from '../../../src/factories/kubernetes/autoscaling/horizontal-pod-autoscaler.js';
import { deployment } from '../../../src/factories/kubernetes/workloads/deployment.js';
import { createResource } from '../../../src/factories/shared.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;
beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
});
afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) delete process.env.TYPEKRO_STRICT_CEL;
  else process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
});

const PROMETHEUS = 'http://prometheus.monitoring.svc:9090';

const inflightMetadata = {
  serverAddress: PROMETHEUS,
  query: 'sum(http_server_active_requests{service="api"})',
  threshold: '20',
};
const inflight: KedaTrigger = { type: 'prometheus', name: 'inflight', metadata: inflightMetadata };
const cpu: KedaTrigger = { type: 'cpu', metricType: 'Utilization', metadata: { value: '70' } };

describe('triggers', () => {
  it('covers the common scalers with typed metadata', () => {
    const triggers: KedaTrigger[] = [
      inflight,
      cpu,
      {
        type: 'memory',
        metricType: 'AverageValue',
        metadata: { value: '512Mi', containerName: 'app' },
      },
      {
        type: 'aws-sqs-queue',
        metadata: { queueURL: 'https://sqs.example/q', queueLength: '10', awsRegion: 'us-east-1' },
        authenticationRef: { name: 'aws', kind: 'ClusterTriggerAuthentication' },
      },
      {
        type: 'aws-cloudwatch',
        metadata: {
          awsRegion: 'us-east-1',
          namespace: 'AWS/SQS',
          metricName: 'ApproximateNumberOfMessagesVisible',
          dimensionName: 'QueueName',
          dimensionValue: 'jobs',
          targetMetricValue: '10',
          minMetricValue: '0',
        },
      },
      {
        type: 'cron',
        metadata: {
          timezone: 'Europe/London',
          start: '0 8 * * 1-5',
          end: '0 18 * * 1-5',
          desiredReplicas: '5',
        },
      },
      {
        type: 'metrics-api',
        metricType: 'Value',
        metadata: { url: 'http://stats.svc/queue', valueLocation: 'depth', targetValue: '100' },
      },
      {
        type: 'postgresql',
        metadata: {
          query: 'SELECT count(*) FROM jobs',
          targetQueryValue: '5',
          connectionFromEnv: 'PG_URL',
        },
      },
      { type: 'redis', metadata: { address: 'redis.svc:6379', listName: 'jobs', listLength: '5' } },
      kedaTrigger('kafka', { bootstrapServers: 'kafka:9092', topic: 'orders', lagThreshold: '50' }),
    ];
    expect(triggers.map((trigger) => trigger.type)).toHaveLength(10);
  });

  it('keeps typed scalers out of the untyped escape hatch', () => {
    // @ts-expect-error prometheus has a typed shape
    kedaTrigger('prometheus', { query: 'up' });
    const typo: KedaTrigger = {
      type: 'prometheus',
      // @ts-expect-error unknown prometheus metadata key
      metadata: { ...inflightMetadata, treshold: '20' },
    };
    expect(typo.type).toBe('prometheus');
  });

  it('builds an untyped trigger as a plain object', () => {
    const trigger = kedaTrigger(
      'rabbitmq',
      { queueName: 'q', value: '10' },
      { authenticationRef: { name: 'rmq' } }
    );
    expect({ ...trigger } as Record<string, unknown>).toEqual({
      type: 'rabbitmq',
      metadata: { queueName: 'q', value: '10' },
      authenticationRef: { name: 'rmq' },
    });
  });
});

describe('scaledObject', () => {
  it('renders a keda.sh/v1alpha1 ScaledObject', () => {
    const so = scaledObject({
      name: 'api',
      namespace: 'shop',
      spec: {
        scaleTargetRef: { name: 'api' },
        minReplicaCount: 2,
        maxReplicaCount: 30,
        pollingInterval: 15,
        cooldownPeriod: 120,
        fallback: { failureThreshold: 3, replicas: 6 },
        advanced: {
          restoreToOriginalReplicaCount: true,
          horizontalPodAutoscalerConfig: {
            behavior: {
              scaleDown: {
                stabilizationWindowSeconds: 300,
                policies: [{ type: 'Percent', value: 50, periodSeconds: 60 }],
              },
            },
          },
        },
        triggers: [inflight],
      },
    });
    expect(so.apiVersion).toBe('keda.sh/v1alpha1');
    expect(so.kind).toBe('ScaledObject');
    expect(so.metadata.namespace).toBe('shop');
    expect(so.spec.triggers).toHaveLength(1);
    expect(so.readinessEvaluator).toBe(scaledObjectReadinessEvaluator);
  });

  it('throws on specs KEDA rejects', () => {
    const base = { scaleTargetRef: { name: 'api' }, triggers: [inflight] };
    expect(() =>
      scaledObject({ name: 'a', spec: { ...base, minReplicaCount: 5, maxReplicaCount: 2 } })
    ).toThrow('minReplicaCount must not exceed maxReplicaCount');
    // With minReplicaCount unset, KEDA's webhook compares idle against 0.
    expect(() => scaledObject({ name: 'a', spec: { ...base, idleReplicaCount: 0 } })).toThrow(
      'idleReplicaCount must be lower than minReplicaCount'
    );
    expect(() =>
      scaledObject({ name: 'a', spec: { scaleTargetRef: { name: 'api' }, triggers: [cpu] } })
    ).toThrow('scaling to zero needs at least one trigger other than cpu or memory');
    expect(() =>
      scaledObject({ name: 'a', spec: { ...base, triggers: [inflight, { ...inflight }] } })
    ).toThrow('trigger name "inflight" is used twice');
    expect(() => scaledObject({ name: 'a', spec: { ...base, triggers: [] } })).toThrow(
      'at least one trigger is required'
    );
  });

  it('rejects any idleReplicaCount other than 0', () => {
    const base = { scaleTargetRef: { name: 'api' }, triggers: [inflight] };
    const paths = (spec: Partial<ScaledObjectSpec>) =>
      validateScaledObjectSpec({ ...base, ...spec }).map((issue) => issue.path);

    expect(paths({ idleReplicaCount: 0, minReplicaCount: 1 })).toEqual([]);
    // An explicit minReplicaCount: 0 is read as the HPA minimum of 1, as the webhook does.
    expect(paths({ idleReplicaCount: 0, minReplicaCount: 0 })).toEqual([]);
    expect(paths({ idleReplicaCount: 0 })).toEqual(['idleReplicaCount']);
    expect(paths({ idleReplicaCount: 1, minReplicaCount: 3 })).toEqual(['idleReplicaCount']);
    expect(paths({ idleReplicaCount: 2, minReplicaCount: 10 })).toEqual(['idleReplicaCount']);
    expect(() =>
      scaledObject({ name: 'a', spec: { ...base, idleReplicaCount: 1, minReplicaCount: 3 } })
    ).toThrow('idleReplicaCount 1 is not supported; KEDA only supports 0');
  });

  it("enforces KEDA's ScaledObject and HPA name limits", () => {
    const base = { scaleTargetRef: { name: 'api' }, triggers: [inflight] };
    const withHpaName = (name: string) => ({
      ...base,
      advanced: { horizontalPodAutoscalerConfig: { name } },
    });
    const paths = (name: string, spec: ScaledObjectSpec = base) =>
      validateScaledObjectSpec(spec, name).map((issue) => issue.path);
    const n = (length: number) => 'a'.repeat(length);

    // No explicit HPA name: KEDA's keda-hpa-<name> caps the name at 54.
    expect(paths(n(54))).toEqual([]);
    expect(paths(n(55))).toEqual(['name']);
    expect(() => scaledObject({ name: n(55), spec: base })).toThrow(
      `KEDA names its HPA "keda-hpa-${n(55)}"`
    );
    // An empty HPA name is treated as unset.
    expect(paths(n(55), withHpaName(''))).toEqual(['name']);
    // An explicit HPA name lifts the cap to the webhook's 63.
    expect(paths(n(63), withHpaName('api-hpa'))).toEqual([]);
    expect(paths(n(64), withHpaName('api-hpa'))).toEqual(['name']);
    expect(paths(n(64))).toEqual(['name']);
    // The explicit HPA name itself: at most 63 characters, a DNS-1123 subdomain.
    const hpaPath = 'advanced.horizontalPodAutoscalerConfig.name';
    expect(paths('api', withHpaName(n(63)))).toEqual([]);
    expect(paths('api', withHpaName(n(64)))).toEqual([hpaPath]);
    expect(paths('api', withHpaName('api.hpa-1'))).toEqual([]);
    for (const bad of ['API', 'api_hpa', '-api', 'api-', 'api..hpa']) {
      expect(paths('api', withHpaName(bad))).toEqual([hpaPath]);
    }
    // No name: nothing to check.
    expect(validateScaledObjectSpec(base)).toEqual([]);
  });

  it('rejects values below the CRD minimums', () => {
    const base = { scaleTargetRef: { name: 'api' }, triggers: [inflight] };
    const paths = (spec: Partial<ScaledObjectSpec>) =>
      validateScaledObjectSpec({ ...base, ...spec }).map((issue) => issue.path);
    expect(paths({ maxReplicaCount: 0 })).toEqual(['maxReplicaCount']);
    expect(paths({ pollingInterval: 0 })).toEqual(['pollingInterval']);
    expect(paths({ cooldownPeriod: -1, initialCooldownPeriod: -1 })).toEqual([
      'cooldownPeriod',
      'initialCooldownPeriod',
    ]);
    expect(paths({ fallback: { failureThreshold: -1, replicas: 2 } })).toEqual([
      'fallback.failureThreshold',
    ]);
    expect(paths({ fallback: { failureThreshold: 3, replicas: -1 } })).toEqual([
      'fallback.replicas',
    ]);
    expect(
      paths({
        maxReplicaCount: 1,
        pollingInterval: 1,
        fallback: { failureThreshold: 0, replicas: 0 },
      })
    ).toEqual([]);
  });

  it('rejects useCachedMetrics on cpu, memory and cron triggers', () => {
    const cron: KedaTrigger = {
      type: 'cron',
      metadata: { timezone: 'UTC', start: '0 8 * * *', end: '0 18 * * *', desiredReplicas: '2' },
    };
    const paths = (trigger: KedaTrigger) =>
      validateScaledObjectSpec({
        scaleTargetRef: { name: 'api' },
        minReplicaCount: 1,
        triggers: [{ ...trigger, useCachedMetrics: true } as KedaTrigger],
      }).map((issue) => issue.path);
    expect(paths(cpu)).toEqual(['triggers[0].useCachedMetrics']);
    expect(paths({ ...cpu, type: 'memory' } as KedaTrigger)).toEqual([
      'triggers[0].useCachedMetrics',
    ]);
    expect(paths(cron)).toEqual(['triggers[0].useCachedMetrics']);
    expect(paths(inflight)).toEqual([]);
    // @ts-expect-error resource triggers have no useCachedMetrics
    const typedCpu: KedaTrigger = { ...cpu, useCachedMetrics: true };
    // @ts-expect-error cron triggers have no useCachedMetrics
    const typedCron: KedaTrigger = { ...cron, useCachedMetrics: true };
    expect([typedCpu, typedCron]).toHaveLength(2);
  });

  it('requires a formula and a positive numeric target for scalingModifiers', () => {
    const base = { scaleTargetRef: { name: 'api' }, triggers: [inflight] };
    const paths = (scalingModifiers: Record<string, string>) =>
      validateScaledObjectSpec({
        ...base,
        advanced: { scalingModifiers: scalingModifiers as never },
      }).map((issue) => issue.path);
    expect(paths({ target: '10' })).toEqual(['advanced.scalingModifiers.formula']);
    expect(paths({ formula: '', target: '10' })).toEqual(['advanced.scalingModifiers.formula']);
    expect(paths({})).toEqual([]);
    for (const target of ['0', '-1', 'ten', '1e', ' 5']) {
      expect(paths({ formula: 'inflight', target })).toEqual(['advanced.scalingModifiers.target']);
    }
    for (const target of ['10', '0.5', '.5', '1e3']) {
      expect(paths({ formula: 'inflight', target })).toEqual([]);
    }
  });

  describe('accepts valid specs whose values are references', () => {
    // Built inside each test, so a regression fails the test instead of the file.
    const build = () =>
      kubernetesComposition(
        {
          name: 'keda-ref-values',
          kind: 'KedaRefValues',
          spec: type({ min: 'number', target: 'string', formula: 'string' }),
          status: type({ ok: 'boolean' }),
        },
        (spec) => {
          const target = { name: 'api' };
          const fallback = { failureThreshold: 3, replicas: 2 };
          // 1. cpu-only triggers with a reference minReplicaCount.
          scaledObject({
            name: 'cpu-ref-min',
            spec: { scaleTargetRef: target, minReplicaCount: spec.min, triggers: [cpu] },
            id: 'cpuRefMin',
          });
          // 2. idleReplicaCount 0 with a reference minReplicaCount.
          scaledObject({
            name: 'idle-ref-min',
            spec: {
              scaleTargetRef: target,
              idleReplicaCount: 0,
              minReplicaCount: spec.min,
              triggers: [inflight],
            },
            id: 'idleRefMin',
          });
          // 3. A concrete formula with a reference target.
          scaledObject({
            name: 'formula-ref-target',
            spec: {
              scaleTargetRef: target,
              triggers: [inflight],
              advanced: { scalingModifiers: { formula: 'inflight', target: spec.target } },
            },
            id: 'formulaRefTarget',
          });
          // 4. scalingModifiers fallback behavior with a reference formula.
          scaledObject({
            name: 'fallback-ref-formula',
            spec: {
              scaleTargetRef: target,
              triggers: [inflight],
              fallback: { ...fallback, behavior: 'scalingModifiers' },
              advanced: { scalingModifiers: { formula: spec.formula, target: '10' } },
            },
            id: 'fallbackRefFormula',
          });
          // 5. cpu-only triggers with fallback and a reference formula.
          scaledObject({
            name: 'cpu-fallback-ref-formula',
            spec: {
              scaleTargetRef: target,
              minReplicaCount: 1,
              triggers: [cpu],
              fallback,
              advanced: { scalingModifiers: { formula: spec.formula, target: '10' } },
            },
            id: 'cpuFallbackRefFormula',
          });
          return { ok: true };
        }
      );

    it('in KRO mode', () => {
      expect(() => build().toYaml()).not.toThrow();
    });

    it('in direct mode', () => {
      const yaml = build()
        .factory('direct', { namespace: 'default' })
        .toYaml({ min: 1, target: '10', formula: 'inflight' });
      expect(
        (loadAll(yaml) as Array<{ kind?: string }>).filter((d) => d.kind === 'ScaledObject')
      ).toHaveLength(5);
    });

    it('still rejects the same specs when the values are concrete and wrong', () => {
      const base = { scaleTargetRef: { name: 'api' } };
      const paths = (spec: Partial<ScaledObjectSpec>) =>
        validateScaledObjectSpec({ ...base, triggers: [inflight], ...spec }).map((i) => i.path);
      expect(paths({ minReplicaCount: 0, triggers: [cpu] })).toContain('minReplicaCount');
      expect(paths({ idleReplicaCount: 0 })).toEqual(['idleReplicaCount']);
      expect(
        paths({ advanced: { scalingModifiers: { formula: 'inflight', target: '' } } })
      ).toContain('advanced.scalingModifiers.target');
      expect(
        paths({
          fallback: { failureThreshold: 3, replicas: 2, behavior: 'scalingModifiers' },
        })
      ).toContain('fallback.behavior');
    });
  });

  it('skips the 54-character rule when advanced is a whole reference', () => {
    const composition = kubernetesComposition(
      {
        name: 'keda-ref-advanced',
        kind: 'KedaRefAdvanced',
        spec: type({ advanced: { horizontalPodAutoscalerConfig: { name: 'string' } } }),
        status: type({ ok: 'boolean' }),
      },
      (spec) => {
        scaledObject({
          name: 'a'.repeat(60),
          spec: {
            scaleTargetRef: { name: 'api' },
            triggers: [inflight],
            advanced: spec.advanced,
          },
          id: 'scaler',
        });
        scaledObject({
          name: 'b'.repeat(60),
          spec: {
            scaleTargetRef: { name: 'api' },
            triggers: [inflight],
            advanced: {
              horizontalPodAutoscalerConfig: spec.advanced.horizontalPodAutoscalerConfig,
            },
          },
          id: 'scaler2',
        });
        return { ok: true };
      }
    );
    expect(() => composition.toYaml()).not.toThrow();
  });

  it('skips names carrying the defaults-pass placeholder', () => {
    const placeholder = `${REQUIRED_FIELD_SENTINEL}-${'a'.repeat(60)}`;
    expect(
      validateScaledObjectSpec(
        { scaleTargetRef: { name: 'api' }, triggers: [inflight] },
        placeholder
      )
    ).toEqual([]);
    expect(
      validateScaledJobSpec(
        { jobTargetRef: { template: { spec: { containers: [] } } }, triggers: [inflight] },
        placeholder
      )
    ).toEqual([]);
  });

  it('skips the name limits for names only known at reconcile time', () => {
    const composition = kubernetesComposition(
      {
        name: 'keda-ref-name',
        kind: 'KedaRefName',
        spec: type({ name: 'string' }),
        status: type({ ok: 'boolean' }),
      },
      (spec) => {
        scaledObject({
          name: `${spec.name}-${'a'.repeat(60)}`,
          spec: {
            scaleTargetRef: { name: 'api' },
            triggers: [inflight],
            advanced: { horizontalPodAutoscalerConfig: { name: spec.name } },
          },
          id: 'scaler',
        });
        scaledJob({
          name: spec.name,
          spec: { jobTargetRef: { template: { spec: { containers: [] } } }, triggers: [inflight] },
          id: 'jobs',
        });
        return { ok: true };
      }
    );
    expect(() => composition.toYaml()).not.toThrow();
  });

  it('treats an unset maxReplicaCount as 100', () => {
    expect(() =>
      scaledObject({
        name: 'a',
        spec: { scaleTargetRef: { name: 'api' }, minReplicaCount: 150, triggers: [inflight] },
      })
    ).toThrow('minReplicaCount must not exceed maxReplicaCount');
    expect(
      validateScaledObjectSpec({
        scaleTargetRef: { name: 'api' },
        minReplicaCount: 100,
        triggers: [inflight],
      })
    ).toEqual([]);
  });

  it('throws on fallback with only cpu and memory triggers', () => {
    expect(() =>
      scaledObject({
        name: 'a',
        spec: {
          scaleTargetRef: { name: 'api' },
          minReplicaCount: 1,
          fallback: { failureThreshold: 3, replicas: 4 },
          triggers: [cpu],
        },
      })
    ).toThrow('fallback needs at least one trigger that is not cpu or memory');
  });

  it('takes the workload resource as scaleTargetRef and orders after it', () => {
    const composition = kubernetesComposition(
      {
        name: 'keda-target',
        kind: 'KedaTarget',
        spec: type({ name: 'string' }),
        status: type({ ok: 'boolean' }),
      },
      (spec) => {
        const api = deployment({
          metadata: { name: spec.name, labels: { app: 'api' } },
          spec: {
            selector: { matchLabels: { app: 'api' } },
            template: {
              metadata: { labels: { app: 'api' } },
              spec: { containers: [{ name: 'api', image: 'nginx' }] },
            },
          },
          id: 'api',
        });
        scaledObject({
          name: 'api',
          spec: { scaleTargetRef: api, triggers: [inflight] },
          id: 'apiScaler',
        });
        return { ok: true };
      }
    );
    // The name is a reference to the Deployment's own name, resolved when it is
    // applied; direct-mode toYaml leaves such references out.
    const direct = loadAll(
      composition.factory('direct', { namespace: 'shop' }).toYaml({ name: 'web' })
    ) as Array<{ kind: string; spec: { scaleTargetRef?: unknown } }>;
    expect(direct.find((doc) => doc.kind === 'ScaledObject')?.spec.scaleTargetRef).toMatchObject({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
    });
    const kro = composition.toYaml();
    expect(kro).toContain('typekro.dev/depends-on-api: ${api.metadata.name}');
    expect(kro).toMatch(
      /scaleTargetRef:\n\s+apiVersion: apps\/v1\n\s+kind: Deployment\n\s+name: \$\{api\.metadata\.name\}/
    );
  });

  it('accepts CPU-only scaling with a floor of one replica', () => {
    expect(
      validateScaledObjectSpec({
        scaleTargetRef: { name: 'api' },
        minReplicaCount: 1,
        triggers: [cpu],
      })
    ).toEqual([]);
  });

  it('warns about unnamed triggers under a formula and fallback on resource triggers', () => {
    const spec: ScaledObjectSpec = {
      scaleTargetRef: { name: 'api' },
      minReplicaCount: 1,
      fallback: { failureThreshold: 3, replicas: 4 },
      advanced: { scalingModifiers: { formula: 'inflight', target: '20' } },
      triggers: [
        inflight,
        { type: 'prometheus', metricType: 'Value', metadata: inflightMetadata },
        cpu,
      ],
    };
    expect(validateScaledObjectSpec(spec).map((issue) => [issue.severity, issue.path])).toEqual([
      ['warning', 'triggers[1].name'],
      ['warning', 'triggers[2].name'],
      ['warning', 'triggers[2]'],
    ]);
  });

  it('requires a formula for per-trigger fallback', () => {
    expect(() =>
      scaledObject({
        name: 'a',
        spec: {
          scaleTargetRef: { name: 'api' },
          fallback: { failureThreshold: 3, replicas: 4, behavior: 'scalingModifiers' },
          triggers: [inflight],
        },
      })
    ).toThrow('"scalingModifiers" needs advanced.scalingModifiers.formula');
  });
});

describe('scaledJob', () => {
  it('renders a ScaledJob', () => {
    const job = scaledJob({
      name: 'transcode',
      spec: {
        jobTargetRef: {
          template: {
            spec: {
              restartPolicy: 'Never',
              containers: [{ name: 'transcode', image: 'transcoder:1.4' }],
            },
          },
        },
        maxReplicaCount: 10,
        scalingStrategy: { strategy: 'accurate' },
        triggers: [{ type: 'redis', metadata: { address: 'redis:6379', listName: 'jobs' } }],
      },
    });
    expect(job.kind).toBe('ScaledJob');
    expect(job.spec.scalingStrategy?.strategy).toBe('accurate');
  });

  it('rejects cpu, memory and metricType on ScaledJob triggers', () => {
    const issues = validateScaledJobSpec({
      jobTargetRef: { template: { spec: { containers: [] } } },
      triggers: [
        { type: 'cpu', metadata: { value: '50' } } as never,
        { ...inflight, metricType: 'Value' } as never,
      ],
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      'triggers[0].type',
      'triggers[1].metricType',
    ]);
  });

  it('rejects ScaledJob values below the CRD minimums', () => {
    expect(
      validateScaledJobSpec({
        jobTargetRef: { template: { spec: { containers: [] } } },
        triggers: [inflight],
        pollingInterval: 0,
        maxReplicaCount: 0,
        successfulJobsHistoryLimit: -1,
        failedJobsHistoryLimit: -1,
      }).map((issue) => issue.path)
    ).toEqual([
      'pollingInterval',
      'successfulJobsHistoryLimit',
      'failedJobsHistoryLimit',
      'maxReplicaCount',
    ]);
  });

  it('caps the ScaledJob name at 63, the label value KEDA puts on every Job', () => {
    const spec = {
      jobTargetRef: { template: { spec: { containers: [] } } },
      triggers: [inflight],
    };
    expect(validateScaledJobSpec(spec, 'a'.repeat(63))).toEqual([]);
    expect(validateScaledJobSpec(spec, 'a'.repeat(64)).map((issue) => issue.path)).toEqual([
      'name',
    ]);
    expect(() => scaledJob({ name: 'a'.repeat(64), spec })).toThrow('ScaledJob name is 64');
  });

  it('validates triggers and replica bounds', () => {
    expect(
      validateScaledJobSpec({
        jobTargetRef: { template: { spec: { containers: [] } } },
        minReplicaCount: 3,
        maxReplicaCount: 1,
        triggers: [],
      }).map((issue) => issue.path)
    ).toEqual(['triggers', 'minReplicaCount']);
  });
});

describe('trigger authentications', () => {
  it('renders a namespaced TriggerAuthentication', () => {
    const auth = triggerAuthentication({
      name: 'prometheus-auth',
      namespace: 'shop',
      spec: {
        secretTargetRef: [{ parameter: 'bearerToken', name: 'prometheus-reader', key: 'token' }],
        env: [{ parameter: 'username', name: 'PROM_USER' }],
      },
    });
    expect(auth.kind).toBe('TriggerAuthentication');
    expect(auth.metadata.namespace).toBe('shop');
    expect(auth.readinessEvaluator?.({ metadata: { resourceVersion: '1' } })).toMatchObject({
      ready: true,
    });
  });

  it('renders a cluster-scoped ClusterTriggerAuthentication without a namespace', () => {
    const auth = clusterTriggerAuthentication({
      name: 'aws',
      namespace: 'ignored',
      spec: {
        podIdentity: { provider: 'aws', roleArn: 'arn:aws:iam::111122223333:role/sqs-reader' },
      },
    });
    expect(auth.kind).toBe('ClusterTriggerAuthentication');
    expect(JSON.parse(JSON.stringify(auth)).metadata).toEqual({ name: 'aws' });
    expect(auth.readinessEvaluator).toBe(triggerAuthenticationReadinessEvaluator);
  });
});

describe('KEDA readiness', () => {
  const live = (conditions: unknown[]) => ({ status: { conditions } });

  it('is ready on Ready=True and reports activity', () => {
    expect(
      evaluateKedaReadiness(
        'ScaledObject',
        live([
          { type: 'Ready', status: 'True' },
          { type: 'Active', status: 'False' },
        ])
      )
    ).toEqual({ ready: true, reason: 'Ready', message: 'ScaledObject is ready (idle)' });
    expect(
      evaluateKedaReadiness(
        'ScaledObject',
        live([
          { type: 'Ready', status: 'True' },
          { type: 'Active', status: 'True' },
          { type: 'Fallback', status: 'True' },
        ])
      ).message
    ).toBe('ScaledObject is ready (active, in fallback)');
  });

  it('is not ready before KEDA reconciles or when a scaler fails', () => {
    expect(evaluateKedaReadiness('ScaledObject', {})).toMatchObject({
      ready: false,
      reason: 'StatusMissing',
    });
    expect(
      evaluateKedaReadiness(
        'ScaledJob',
        live([
          {
            type: 'Ready',
            status: 'False',
            reason: 'ScaledJobCheckFailed',
            message: 'bad trigger',
          },
        ])
      )
    ).toEqual({ ready: false, reason: 'ScaledJobCheckFailed', message: 'bad trigger' });
  });
});

describe('HPA / VPA conflicts', () => {
  const schema = { spec: type({ replicas: 'number' }), status: type({ ok: 'boolean' }) };

  function conflictsIn(build: () => ScaledObjectSpec): string[] {
    const messages: string[] = [];
    const composition = kubernetesComposition(
      { name: 'keda-conflicts', kind: 'KedaConflicts', ...schema },
      () => {
        messages.push(
          ...findKedaAutoscalerConflicts(build(), undefined).map((issue) => issue.message)
        );
        return { ok: true };
      }
    );
    composition.factory('direct', { namespace: 'default' }).toYaml({ replicas: 1 });
    return [...new Set(messages)];
  }

  const vpa = (
    mode: string,
    controlledResources?: string[],
    policies?: Record<string, unknown>[]
  ) =>
    createResource({
      apiVersion: 'autoscaling.k8s.io/v1',
      kind: 'VerticalPodAutoscaler',
      metadata: { name: 'api' },
      spec: {
        targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api' },
        updatePolicy: { updateMode: mode },
        ...(controlledResources
          ? { resourcePolicy: { containerPolicies: [{ containerName: '*', controlledResources }] } }
          : {}),
        ...(policies ? { resourcePolicy: { containerPolicies: policies } } : {}),
      },
      id: 'apiVpa',
    });

  it('warns about an HPA on the same target', () => {
    const messages = conflictsIn(() => {
      horizontalPodAutoscaler({
        metadata: { name: 'api' },
        spec: {
          scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api' },
          maxReplicas: 10,
        },
        id: 'apiHpa',
      });
      return { scaleTargetRef: { name: 'api' }, triggers: [inflight] };
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('HorizontalPodAutoscaler "api" already scales Deployment/api');
  });

  it('warns about a VPA setting the resource a trigger scales on', () => {
    const messages = conflictsIn(() => {
      vpa('InPlaceOrRecreate');
      return { scaleTargetRef: { name: 'api' }, minReplicaCount: 1, triggers: [cpu] };
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('VerticalPodAutoscaler "api" also sets cpu requests');
  });

  it('still warns when only named containers are narrowed', () => {
    // The usual sidecar exclusion leaves the main container on cpu and memory.
    const sidecarOnly = conflictsIn(() => {
      vpa('Recreate', undefined, [{ containerName: 'istio-proxy', mode: 'Off' }]);
      return { scaleTargetRef: { name: 'api' }, minReplicaCount: 1, triggers: [cpu] };
    });
    expect(sidecarOnly).toHaveLength(1);
    const namedMemoryOnly = conflictsIn(() => {
      vpa('Recreate', undefined, [{ containerName: 'app', controlledResources: ['memory'] }]);
      return { scaleTargetRef: { name: 'api' }, minReplicaCount: 1, triggers: [cpu] };
    });
    expect(namedMemoryOnly).toHaveLength(1);
    const starOff = conflictsIn(() => {
      vpa('Recreate', undefined, [{ containerName: '*', mode: 'Off' }]);
      return { scaleTargetRef: { name: 'api' }, minReplicaCount: 1, triggers: [cpu] };
    });
    expect(starOff).toEqual([]);
  });

  it('stays quiet for an Off VPA, a memory-only VPA, and non-resource triggers', () => {
    const so = (triggers: KedaTrigger[]): ScaledObjectSpec => ({
      scaleTargetRef: { name: 'api' },
      minReplicaCount: 1,
      triggers,
    });
    expect(
      conflictsIn(() => {
        vpa('Off');
        return so([cpu]);
      })
    ).toEqual([]);
    expect(
      conflictsIn(() => {
        vpa('Recreate', ['memory']);
        return so([cpu]);
      })
    ).toEqual([]);
    expect(
      conflictsIn(() => {
        vpa('Recreate');
        return so([inflight]);
      })
    ).toEqual([]);
  });

  it('is logged by the factory', () => {
    const warn = spyOn(Object.getPrototypeOf(getComponentLogger('keda-validation')), 'warn');
    try {
      const composition = kubernetesComposition(
        { name: 'keda-conflicts-log', kind: 'KedaConflictsLog', ...schema },
        () => {
          vpa('Recreate');
          scaledObject({
            name: 'api',
            spec: { scaleTargetRef: { name: 'api' }, minReplicaCount: 1, triggers: [cpu] },
            id: 'apiScaler',
          });
          return { ok: true };
        }
      );
      composition.factory('direct', { namespace: 'default' }).toYaml({ replicas: 1 });
      expect(warn.mock.calls.some((call) => String(call[0]).includes('also sets cpu'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('ScaledObject — KRO/direct parity', () => {
  const scaling = kubernetesComposition(
    {
      name: 'api-scaling',
      kind: 'ApiScaling',
      spec: type({ app: 'string', maxReplicas: 'number.integer', inflightTarget: 'string' }),
      status: type({ ready: 'boolean', active: 'boolean', hpa: 'string' }),
    },
    (spec) => {
      triggerAuthentication({
        name: 'prometheus-auth',
        spec: { secretTargetRef: [{ parameter: 'bearerToken', name: 'prom', key: 'token' }] },
        id: 'promAuth',
      });
      const scaler = scaledObject({
        name: spec.app,
        spec: {
          scaleTargetRef: { name: spec.app },
          minReplicaCount: 2,
          maxReplicaCount: spec.maxReplicas,
          triggers: [
            {
              type: 'prometheus',
              name: 'inflight',
              metadata: {
                serverAddress: PROMETHEUS,
                query: 'sum(http_server_active_requests{service="api"})',
                threshold: spec.inflightTarget,
                authModes: 'bearer',
              },
              authenticationRef: { name: 'prometheus-auth' },
            },
          ],
        },
        id: 'apiScaler',
      });
      return { ready: kedaReady(scaler), active: kedaActive(scaler), hpa: scaler.status.hpaName };
    }
  );

  const SPEC = { app: 'api', maxReplicas: 30, inflightTarget: '20' };

  interface Doc {
    kind?: string;
    metadata?: { name?: string; namespace?: string };
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
    const direct = loadAll(scaling.factory('direct', { namespace: 'shop' }).toYaml(SPEC)) as Doc[];
    const rgd = (loadAll(scaling.toYaml()) as Doc[]).find(
      (doc) => doc.kind === 'ResourceGraphDefinition'
    );
    const templates = (rgd?.spec?.resources ?? []).map((resource) => substitute(resource.template));
    // Direct mode stamps the factory namespace; KRO uses the instance's.
    const withoutNamespace = (doc: Doc) => {
      const { namespace: _namespace, ...metadata } = doc.metadata ?? {};
      return { ...doc, metadata };
    };
    const byName = (docs: unknown[]) =>
      Object.fromEntries(
        (docs as Doc[]).map((doc) => [`${doc.kind}/${doc.metadata?.name}`, withoutNamespace(doc)])
      );
    expect(direct.every((doc) => doc.metadata?.namespace === 'shop')).toBe(true);
    expect(byName(templates)).toEqual(byName(direct));
  });

  it('emits readiness, activity and the HPA name from the ScaledObject', () => {
    const rgd = (loadAll(scaling.toYaml()) as Doc[]).find(
      (doc) => doc.kind === 'ResourceGraphDefinition'
    );
    const status = rgd?.spec?.schema?.status ?? {};
    expect(status.ready).toContain('"Ready"');
    expect(status.active).toContain('"Active"');
    expect(status.hpa).toBe('${apiScaler.status.hpaName}');
  });
});
