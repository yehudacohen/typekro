/**
 * ClickHouse server container probes.
 *
 * REGRESSION SUITE for #230. With the pod template silent, the container
 * inherited the Altinity operator's defaults: a liveness probe that SIGKILLs
 * at ~90s and NO startup probe. ClickHouse's boot time is a function of how
 * much data it has, so a long-lived server eventually loads for longer than
 * that and is killed mid-boot forever — a crash loop triggered by TIME, not by
 * load or by any configuration change.
 *
 * These assertions are structural, over the rendered pod template's container.
 */

import { describe, expect, it } from 'bun:test';
import { load } from 'js-yaml';
import { makeClickHouseCluster } from '../../../src/factories/clickhouse/compositions/clickhouse-cluster.js';
import { clickHouseInstallation } from '../../../src/factories/clickhouse/resources/installation.js';
import {
  CLICKHOUSE_PROBE_PATH,
  CLICKHOUSE_PROBE_PORT_NAME,
  DEFAULT_CLICKHOUSE_LIVENESS_PROBE,
  DEFAULT_CLICKHOUSE_READINESS_PROBE,
  DEFAULT_CLICKHOUSE_STARTUP_PROBE,
  resolveClickHouseProbes,
} from '../../../src/factories/clickhouse/utils/probes.js';
import { KUBERNETES_REF_BRAND } from '../../../src/shared/brands.js';

type InstallationConfig = Parameters<typeof clickHouseInstallation>[0];

interface ProbeShape {
  httpGet?: { path?: string; port?: string };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
  successThreshold?: number;
}

interface ContainerShape {
  name?: string;
  startupProbe?: ProbeShape;
  livenessProbe?: ProbeShape;
  readinessProbe?: ProbeShape;
}

/** A KubernetesRef the way a `schema.spec.*` proxy hands one over. */
function schemaRef(fieldPath: string): number {
  return {
    [KUBERNETES_REF_BRAND]: true,
    resourceId: '__schema__',
    fieldPath,
  } as unknown as number;
}

function chiWith(overrides: Partial<InstallationConfig> = {}) {
  return clickHouseInstallation({
    name: 'test-ch',
    namespace: 'observability',
    version: '25.7.8.71',
    storage: { size: '10Gi' },
    ...overrides,
  } as InstallationConfig);
}

function containersOf(
  chi: ReturnType<typeof clickHouseInstallation>,
  templateIndex = 0
): ContainerShape[] {
  const spec = chi.spec.templates?.podTemplates?.[templateIndex]?.spec as
    | { containers?: ContainerShape[] }
    | undefined;
  return spec?.containers ?? [];
}

describe('ClickHouse container probes (#230)', () => {
  describe('defaults', () => {
    const container = containersOf(chiWith())[0];

    it('sets a startupProbe against /ping, which the operator never does', () => {
      expect(container?.startupProbe).toBeDefined();
      expect(container?.startupProbe?.httpGet).toEqual({
        path: CLICKHOUSE_PROBE_PATH,
        port: CLICKHOUSE_PROBE_PORT_NAME,
      });
    });

    it('gives the startup probe a boot budget far past the operator ~90s deadline', () => {
      const startup = container?.startupProbe;
      expect(startup?.periodSeconds).toBe(10);
      expect(startup?.failureThreshold).toBe(90);
      // The budget is what the fix is FOR: the incident server took 2m48s to
      // load and was killed at ~90s. Assert the product, not just the factors.
      const budgetSeconds =
        (startup?.initialDelaySeconds ?? 0) +
        (startup?.periodSeconds ?? 0) * (startup?.failureThreshold ?? 0);
      expect(budgetSeconds).toBeGreaterThanOrEqual(600);
    });

    it('keeps liveness MEANINGFUL once started, with no redundant initial delay', () => {
      const liveness = container?.livenessProbe;
      expect(liveness?.httpGet).toEqual({
        path: CLICKHOUSE_PROBE_PATH,
        port: CLICKHOUSE_PROBE_PORT_NAME,
      });
      // Kubernetes suspends liveness until the startup probe first succeeds,
      // so an initialDelaySeconds here would only add dead time after the
      // server is known to be up.
      expect(liveness?.initialDelaySeconds).toBeUndefined();
      // A minute of unresponsive /ping still restarts the container.
      expect((liveness?.periodSeconds ?? 0) * (liveness?.failureThreshold ?? 0)).toBe(60);
    });

    it('raises every probe timeout off Kubernetes 1s default', () => {
      for (const probe of [
        container?.startupProbe,
        container?.livenessProbe,
        container?.readinessProbe,
      ]) {
        expect(probe?.timeoutSeconds).toBe(5);
      }
    });

    it('sets a readiness probe that removes the host without restarting it', () => {
      expect(container?.readinessProbe?.failureThreshold).toBe(
        DEFAULT_CLICKHOUSE_READINESS_PROBE.failureThreshold
      );
    });

    it('exports the defaults the rendered probes are built from', () => {
      expect(DEFAULT_CLICKHOUSE_STARTUP_PROBE.failureThreshold).toBe(90);
      expect(DEFAULT_CLICKHOUSE_LIVENESS_PROBE.failureThreshold).toBe(6);
    });
  });

  describe('every pod template carries them', () => {
    it('applies to each zone-pinned template, not only the first', () => {
      const chi = chiWith({ zones: ['us-east-2a', 'us-east-2b'], replicas: 2 });
      const templates = chi.spec.templates?.podTemplates ?? [];
      expect(templates.length).toBe(2);
      for (let index = 0; index < templates.length; index += 1) {
        expect(containersOf(chi, index)[0]?.startupProbe).toBeDefined();
      }
    });
  });

  describe('overrides', () => {
    it('merges a partial override over the default', () => {
      const container = containersOf(chiWith({ probes: { startup: { failureThreshold: 120 } } }))[0];
      expect(container?.startupProbe?.failureThreshold).toBe(120);
      // Unmentioned fields keep the default rather than becoming undefined.
      expect(container?.startupProbe?.periodSeconds).toBe(10);
      expect(container?.startupProbe?.timeoutSeconds).toBe(5);
    });

    it('omits a probe set to false, handing it back to the operator default', () => {
      const container = containersOf(chiWith({ probes: { readiness: false } }))[0];
      expect(container?.readinessProbe).toBeUndefined();
      expect(container?.startupProbe).toBeDefined();
      expect(container?.livenessProbe).toBeDefined();
    });

    it('can disable all three', () => {
      const container = containersOf(
        chiWith({ probes: { startup: false, liveness: false, readiness: false } })
      )[0];
      expect(container?.startupProbe).toBeUndefined();
      expect(container?.livenessProbe).toBeUndefined();
      expect(container?.readinessProbe).toBeUndefined();
    });

    it('rejects a nonsensical probe value loudly', () => {
      expect(() => chiWith({ probes: { liveness: { periodSeconds: 0 } } })).toThrow(
        /probes\.liveness\.periodSeconds must be an integer >= 1/
      );
    });
  });

  /**
   * `probes` is advertised as a KUBERNETES probe seam, so the validator has to
   * agree with Kubernetes field-by-field: it must not reject what the API
   * server accepts, and must not accept what the API server rejects.
   *
   * Bounds verified against kubernetes/kubernetes v1.34.0 —
   * `staging/src/k8s.io/api/core/v1/types.go` (`type Probe struct`, the
   * documented "Minimum value is 1" / "Must be 1 for liveness and startup"),
   * `pkg/apis/core/validation/validation.go` (`validateProbe`,
   * `validateLivenessProbe`, `validateStartupProbe`) and
   * `pkg/apis/core/v1/defaults.go` (`SetDefaults_Probe`, which overwrites a
   * literal 0 in the four threshold/second fields with their defaults, so a 0
   * there can never mean zero).
   */
  describe('validation mirrors the Kubernetes probe API', () => {
    describe('successThreshold must be 1 for liveness and startup', () => {
      for (const probeName of ['startup', 'liveness'] as const) {
        it(`rejects ${probeName}.successThreshold: 2`, () => {
          expect(() =>
            chiWith({
              probes: { [probeName]: { successThreshold: 2 } },
            } as Partial<InstallationConfig>)
          ).toThrow(
            new RegExp(`probes\\.${probeName}\\.successThreshold must be exactly 1 \\(got 2\\)`)
          );
        });

        it(`names the Kubernetes rule in the ${probeName} error`, () => {
          expect(() =>
            chiWith({
              probes: { [probeName]: { successThreshold: 3 } },
            } as Partial<InstallationConfig>)
          ).toThrow(/Kubernetes requires successThreshold to be 1 for liveness and startup probes/);
        });

        it(`still accepts ${probeName}.successThreshold: 1`, () => {
          expect(() =>
            chiWith({
              probes: { [probeName]: { successThreshold: 1 } },
            } as Partial<InstallationConfig>)
          ).not.toThrow();
        });
      }

      // The whole point of the field: only readiness may ask for several
      // consecutive successes, and Kubernetes' own validateReadinessProbe
      // carries no `!= 1` check.
      it('accepts readiness.successThreshold: 2 and renders it', () => {
        const container = containersOf(
          chiWith({ probes: { readiness: { successThreshold: 2 } } })
        )[0];
        expect(container?.readinessProbe?.successThreshold).toBe(2);
      });
    });

    describe('initialDelaySeconds may be 0', () => {
      for (const probeName of ['startup', 'liveness', 'readiness'] as const) {
        it(`accepts ${probeName}.initialDelaySeconds: 0`, () => {
          expect(() =>
            chiWith({
              probes: { [probeName]: { initialDelaySeconds: 0 } },
            } as Partial<InstallationConfig>)
          ).not.toThrow();
        });
      }

      it('renders the explicit 0 rather than dropping it', () => {
        const container = containersOf(
          chiWith({ probes: { startup: { initialDelaySeconds: 0 } } })
        )[0];
        expect(container?.startupProbe?.initialDelaySeconds).toBe(0);
      });

      it('still rejects a negative initialDelaySeconds', () => {
        expect(() => chiWith({ probes: { startup: { initialDelaySeconds: -1 } } })).toThrow(
          /probes\.startup\.initialDelaySeconds must be an integer >= 0/
        );
      });
    });

    describe('the other four fields still reject 0', () => {
      for (const field of [
        'periodSeconds',
        'timeoutSeconds',
        'failureThreshold',
        'successThreshold',
      ] as const) {
        it(`rejects readiness.${field}: 0`, () => {
          expect(() =>
            chiWith({ probes: { readiness: { [field]: 0 } } } as Partial<InstallationConfig>)
          ).toThrow(
            new RegExp(`probes\\.readiness\\.${field} must be an integer >= 1 \\(got 0\\)`)
          );
        });
      }

      it('rejects a non-integer', () => {
        expect(() => chiWith({ probes: { startup: { periodSeconds: 2.5 } } })).toThrow(
          /probes\.startup\.periodSeconds must be an integer >= 1 \(got 2\.5\)/
        );
      });
    });
  });

  /**
   * The build-time contract has TWO public doors. `makeClickHouseCluster`
   * already walked these options recursively; `clickHouseInstallation` only
   * tested whether the WHOLE object was a reference, so a nested one — the
   * realistic mistake — went straight through. The docs state the contract
   * without qualifying which entry point, so it has to hold at both.
   */
  describe('nested schema references through clickHouseInstallation', () => {
    it('rejects a reference nested inside a probe, naming the exact field', () => {
      expect(() =>
        chiWith({
          probes: { startup: { failureThreshold: schemaRef('spec.failureThreshold') } },
        } as unknown as Partial<InstallationConfig>)
      ).toThrow(
        /'probes\.startup\.failureThreshold' is a BUILD-TIME topology field and received a schema reference or CEL expression/
      );
    });

    it('explains why, and points at the construction-time fix', () => {
      let message = '';
      try {
        chiWith({
          probes: { liveness: { periodSeconds: schemaRef('spec.period') } },
        } as unknown as Partial<InstallationConfig>);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('probes.liveness.periodSeconds');
      expect(message).toContain('__KUBERNETES_REF__');
      expect(message).toContain('makeClickHouseCluster({ probes })');
      // The OLD failure mode: the nested ref fell through to the integer check
      // and was reported as a bad number, which named neither cause nor fix.
      expect(message).not.toMatch(/must be an integer/);
    });

    it('still rejects a reference as the whole probes object', () => {
      expect(() =>
        chiWith({ probes: schemaRef('spec.probes') } as unknown as Partial<InstallationConfig>)
      ).toThrow(/'probes' is a BUILD-TIME topology field/);
    });
  });

  describe('resolveClickHouseProbes', () => {
    it('renders all three probes by default', () => {
      const resolved = resolveClickHouseProbes('t', undefined);
      expect(Object.keys(resolved).sort()).toEqual([
        'livenessProbe',
        'readinessProbe',
        'startupProbe',
      ]);
    });
  });

  describe('makeClickHouseCluster', () => {
    it('renders the startup probe into the RGD by default', () => {
      const yaml = makeClickHouseCluster().toYaml();
      const rgd = load(yaml) as {
        spec: { resources: { template: { kind?: string; spec?: unknown } }[] };
      };
      const chi = rgd.spec.resources.find(
        (resource) => resource.template?.kind === 'ClickHouseInstallation'
      );
      const templates = (
        chi?.template.spec as {
          templates?: { podTemplates?: { spec?: { containers?: ContainerShape[] } }[] };
        }
      )?.templates?.podTemplates;
      const container = templates?.[0]?.spec?.containers?.[0];

      expect(container?.startupProbe?.httpGet).toEqual({ path: '/ping', port: 'http' });
      expect(container?.startupProbe?.failureThreshold).toBe(90);
      expect(container?.livenessProbe?.failureThreshold).toBe(6);
    });

    it('passes a topology override through to the installation', () => {
      const yaml = makeClickHouseCluster({
        probes: { startup: { failureThreshold: 30, periodSeconds: 20 } },
      }).toYaml();
      expect(yaml).toContain('failureThreshold: 30');
      expect(yaml).toContain('periodSeconds: 20');
    });

    it('rejects a schema reference in the build-time option', () => {
      expect(() =>
        makeClickHouseCluster({
          probes: {
            startup: {
              failureThreshold: {
                [KUBERNETES_REF_BRAND]: true,
                resourceId: '__schema__',
                fieldPath: 'spec.failureThreshold',
              } as unknown as number,
            },
          },
        })
      ).toThrow(/build-time option `probes` contains a schema\/resource reference/);
    });
  });
});
