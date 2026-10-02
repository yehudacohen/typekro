/**
 * Flux lifecycle options (install / upgrade / remediation / CRD policy / drift
 * detection) on every TypeKro HelmRelease factory.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { toResourceGraph } from '../../../src/core/serialization/index.js';
import { apisixHelmRelease } from '../../../src/factories/apisix/index.js';
import { certManagerHelmRelease } from '../../../src/factories/cert-manager/index.js';
import { ciliumHelmRelease } from '../../../src/factories/cilium/index.js';
import { clickhouseOperatorHelmRelease } from '../../../src/factories/clickhouse/index.js';
import {
  clickstackHelmRelease,
  otelCollectorHelmRelease,
} from '../../../src/factories/clickstack/index.js';
import { cnpgHelmRelease } from '../../../src/factories/cnpg/index.js';
import { dagsterHelmRelease } from '../../../src/factories/dagster/index.js';
import {
  envoyAIGatewayControllerHelmRelease,
  envoyAIGatewayCrdsHelmRelease,
  envoyGatewayHelmRelease,
} from '../../../src/factories/envoy-ai-gateway/index.js';
import { externalDnsHelmRelease } from '../../../src/factories/external-dns/index.js';
import { harborHelmRelease } from '../../../src/factories/harbor/index.js';
import { hatchetHelmRelease } from '../../../src/factories/hatchet/index.js';
import {
  type HelmReleaseLifecycleOptions,
  type HelmReleaseSpec,
  helmRelease,
  helmReleaseLifecycle,
} from '../../../src/factories/helm/index.js';
import { inngestHelmRelease } from '../../../src/factories/inngest/index.js';
import { natsHelmRelease } from '../../../src/factories/nats/index.js';
import { openSearchOperatorHelmRelease } from '../../../src/factories/opensearch/index.js';
import {
  hydraHelmRelease,
  ketoHelmRelease,
  kratosHelmRelease,
  oathkeeperHelmRelease,
} from '../../../src/factories/ory/index.js';
import { pebbleHelmRelease } from '../../../src/factories/pebble/index.js';
import {
  rookCephClusterHelmRelease,
  rookCephOperatorHelmRelease,
} from '../../../src/factories/rook/index.js';
import { traefikHelmRelease } from '../../../src/factories/traefik/index.js';
import { valkeyHelmRelease } from '../../../src/factories/valkey/index.js';

interface RenderedRelease {
  spec: Pick<HelmReleaseSpec, 'install' | 'upgrade' | 'driftDetection' | 'timeout'>;
}

const LIFECYCLE: HelmReleaseLifecycleOptions = {
  install: {
    timeout: '30m',
    crds: 'CreateReplace',
    remediation: { retries: 7, remediateLastFailure: true },
  },
  upgrade: {
    timeout: '25m',
    crds: 'CreateReplace',
    remediation: { retries: 5, remediateLastFailure: true, strategy: 'uninstall' },
  },
  driftDetection: { mode: 'warn' },
};

const envoy = {
  name: 'envoy',
  namespace: 'envoy-gateway-system',
  version: 'v1.0.0',
  repositoryName: 'envoy',
  repositoryNamespace: 'flux-system',
  values: {},
};

/** One factory per HelmRelease the integrations ship, each with minimal config. */
const FACTORIES: Record<string, (options: HelmReleaseLifecycleOptions) => RenderedRelease> = {
  helmRelease: (o) =>
    helmRelease({
      name: 'app',
      chart: { repository: 'https://charts.example.com', name: 'app' },
      ...o,
    }),
  apisix: (o) => apisixHelmRelease({ name: 'apisix', ...o }),
  certManager: (o) => certManagerHelmRelease({ name: 'cert-manager', ...o }),
  cilium: (o) =>
    ciliumHelmRelease({
      name: 'cilium',
      repositoryName: 'cilium',
      repositoryNamespace: 'flux-system',
      ...o,
    }),
  clickhouse: (o) => clickhouseOperatorHelmRelease({ name: 'clickhouse-operator', ...o }),
  clickstack: (o) => clickstackHelmRelease({ name: 'clickstack', ...o }),
  otelCollector: (o) => otelCollectorHelmRelease({ name: 'otel', ...o }),
  cnpg: (o) => cnpgHelmRelease({ name: 'cnpg', ...o }),
  dagster: (o) => dagsterHelmRelease({ name: 'dagster', ...o }),
  envoyGateway: (o) => envoyGatewayHelmRelease({ ...envoy, ...o }),
  envoyAIGatewayCrds: (o) => envoyAIGatewayCrdsHelmRelease({ ...envoy, ...o }),
  envoyAIGatewayController: (o) => envoyAIGatewayControllerHelmRelease({ ...envoy, ...o }),
  externalDns: (o) =>
    externalDnsHelmRelease({ name: 'external-dns', repositoryName: 'edns', ...o }),
  harbor: (o) => harborHelmRelease({ name: 'harbor', ...o }),
  hatchet: (o) => hatchetHelmRelease({ name: 'hatchet', ...o }),
  inngest: (o) => inngestHelmRelease({ name: 'inngest', ...o }),
  nats: (o) =>
    natsHelmRelease({
      name: 'nats',
      namespace: 'nats',
      chart: 'nats',
      version: '1.0.0',
      values: {},
      ...o,
    }),
  openSearch: (o) =>
    openSearchOperatorHelmRelease({
      name: 'opensearch-operator',
      namespace: 'opensearch',
      version: '2.0.0',
      repositoryName: 'opensearch',
      repositoryNamespace: 'flux-system',
      ...o,
    }),
  hydra: (o) => hydraHelmRelease({ name: 'hydra', ...o }),
  kratos: (o) => kratosHelmRelease({ name: 'kratos', ...o }),
  keto: (o) => ketoHelmRelease({ name: 'keto', ...o }),
  oathkeeper: (o) => oathkeeperHelmRelease({ name: 'oathkeeper', ...o }),
  pebble: (o) => pebbleHelmRelease({ name: 'pebble', ...o }),
  rookOperator: (o) => rookCephOperatorHelmRelease({ name: 'rook-ceph', ...o }),
  rookCluster: (o) => rookCephClusterHelmRelease({ name: 'rook-ceph-cluster', ...o }),
  traefik: (o) => traefikHelmRelease({ name: 'traefik', ...o }),
  valkey: (o) => valkeyHelmRelease({ name: 'valkey-operator', ...o }),
};

describe('helmReleaseLifecycle', () => {
  it('defaults to the generic 10m / 3-retry policy', () => {
    expect(helmReleaseLifecycle(undefined)).toEqual({
      install: { timeout: '10m', remediation: { retries: 3 } },
      upgrade: { timeout: '10m', remediation: { retries: 3 } },
    });
  });

  it('merges caller fields over the defaults, remediation field by field', () => {
    expect(
      helmReleaseLifecycle({
        install: { crds: 'CreateReplace', remediation: { remediateLastFailure: true } },
        upgrade: { timeout: '20m', remediation: { retries: 0 } },
      })
    ).toEqual({
      install: {
        timeout: '10m',
        remediation: { retries: 3, remediateLastFailure: true },
        crds: 'CreateReplace',
      },
      upgrade: { timeout: '20m', remediation: { retries: 0 } },
    });
  });

  it('replaces drift detection as a whole and honours factory defaults', () => {
    expect(
      helmReleaseLifecycle(
        { driftDetection: { mode: 'disabled' } },
        { driftDetection: { mode: 'enabled', ignore: [{ paths: ['/spec/replicas'] }] } }
      )
    ).toEqual({ driftDetection: { mode: 'disabled' } });
  });

  it('renders nothing when a factory has no defaults and the caller sets nothing', () => {
    expect(helmReleaseLifecycle({}, {})).toEqual({});
  });
});

describe('every integration HelmRelease factory accepts the lifecycle options', () => {
  for (const [name, factory] of Object.entries(FACTORIES)) {
    it(`${name} renders install, upgrade, CRD policy and drift detection`, () => {
      const { spec } = factory(LIFECYCLE);
      expect(spec.install).toMatchObject(LIFECYCLE.install ?? {});
      expect(spec.upgrade).toMatchObject(LIFECYCLE.upgrade ?? {});
      expect(spec.driftDetection).toEqual({ mode: 'warn' });
    });

    it(`${name} always renders a bounded install and upgrade policy`, () => {
      const { spec } = factory({});
      expect(spec.install?.remediation?.retries).toBeNumber();
      expect(spec.upgrade?.remediation?.retries).toBeNumber();
      // An action without its own timeout falls back to spec.timeout; one of
      // the two must be set, or Flux would use its 5m default.
      expect(spec.install?.timeout ?? spec.timeout).toBeString();
      expect(spec.upgrade?.timeout ?? spec.timeout).toBeString();
    });
  }
});

describe('factory-specific lifecycle defaults', () => {
  it('generic helmRelease passes install.crds and upgrade.crds through (previously dropped)', () => {
    const { spec } = FACTORIES.helmRelease?.({
      install: { crds: 'Create' },
      upgrade: { crds: 'CreateReplace' },
    }) as RenderedRelease;
    expect(spec.install).toEqual({ timeout: '10m', remediation: { retries: 3 }, crds: 'Create' });
    expect(spec.upgrade).toEqual({
      timeout: '10m',
      remediation: { retries: 3 },
      crds: 'CreateReplace',
    });
  });

  it.each([['certManager'], ['externalDns'], ['pebble']])(
    '%s adopts the generic 10m / 3-retry defaults',
    (name) => {
      const { spec } = FACTORIES[name]?.({}) as RenderedRelease;
      expect(spec.install).toEqual({ timeout: '10m', remediation: { retries: 3 } });
      expect(spec.upgrade).toEqual({ timeout: '10m', remediation: { retries: 3 } });
      expect(Object.keys(spec)).not.toContain('driftDetection');
    }
  );

  it('cert-manager can opt into CreateReplace CRDs without an aspect', () => {
    const release = certManagerHelmRelease({
      name: 'cert-manager',
      install: { crds: 'CreateReplace' },
      upgrade: { crds: 'CreateReplace' },
    });
    expect(release.spec.install?.crds).toBe('CreateReplace');
    expect(release.spec.upgrade?.crds).toBe('CreateReplace');
  });

  it('cilium renders its legacy timeout fields instead of ignoring them', () => {
    const flat = ciliumHelmRelease({
      name: 'cilium',
      repositoryName: 'cilium',
      repositoryNamespace: 'flux-system',
      timeout: '15m',
      upgradeTimeout: '20m',
      createNamespace: true,
    });
    expect(flat.spec.timeout).toBe('15m');
    // spec.timeout bounds install; no 10m action default may shadow it.
    expect(flat.spec.install).toEqual({ remediation: { retries: 3 }, createNamespace: true });
    expect(flat.spec.upgrade).toEqual({ timeout: '20m', remediation: { retries: 3 } });
  });

  it('apisix keeps namespace creation and leaves timeouts to spec.timeout', () => {
    const { spec } = apisixHelmRelease({ name: 'apisix', timeout: '20m' });
    expect(spec.timeout).toBe('20m');
    expect(spec.install).toEqual({ remediation: { retries: 3 }, createNamespace: true });
    expect(spec.upgrade).toEqual({ remediation: { retries: 3 } });
  });

  it('traefik keeps its shared CRD policy and lets install/upgrade split it', () => {
    const shared = traefikHelmRelease({ name: 'traefik' });
    expect(shared.spec.install?.crds).toBe('CreateReplace');
    expect(shared.spec.upgrade).toEqual({
      remediation: { retries: 3, remediateLastFailure: true, strategy: 'rollback' },
      crds: 'CreateReplace',
    });
    const split = traefikHelmRelease({
      name: 'traefik',
      crds: 'Create',
      upgrade: { crds: 'Skip' },
    });
    expect(split.spec.install?.crds).toBe('Create');
    expect(split.spec.upgrade?.crds).toBe('Skip');
  });

  it('hatchet and harbor keep no-rollback upgrades unless the caller overrides them', () => {
    for (const release of [
      hatchetHelmRelease({ name: 'hatchet', install: { timeout: '40m' } }),
      harborHelmRelease({ name: 'harbor', install: { timeout: '40m' } }),
    ]) {
      expect(release.spec.install?.timeout).toBe('40m');
      expect(release.spec.upgrade).toEqual({
        timeout: '20m',
        remediation: { retries: 0, remediateLastFailure: false },
      });
      expect(release.spec.driftDetection).toEqual({ mode: 'enabled' });
    }
    const opted = hatchetHelmRelease({ name: 'hatchet', upgrade: { remediation: { retries: 2 } } });
    expect(opted.spec.upgrade?.remediation).toEqual({ retries: 2, remediateLastFailure: false });
  });

  it('operators that enable drift detection still let the caller change it', () => {
    expect(cnpgHelmRelease({ name: 'cnpg' }).spec.driftDetection).toEqual({ mode: 'enabled' });
    expect(
      cnpgHelmRelease({ name: 'cnpg', driftDetection: { mode: 'disabled' } }).spec.driftDetection
    ).toEqual({ mode: 'disabled' });
  });
});

describe('lifecycle options in KRO mode', () => {
  it('serializes schema references in lifecycle fields as CEL', () => {
    const graph = toResourceGraph(
      {
        name: 'lifecycle-refs',
        apiVersion: 'example.com/v1alpha1',
        kind: 'LifecycleRefs',
        spec: type({ installTimeout: 'string', retries: 'number' }),
        status: type({ ready: 'boolean' }),
      },
      (schema) => ({
        certManager: certManagerHelmRelease({
          name: 'cert-manager',
          install: {
            timeout: schema.spec.installTimeout,
            crds: 'CreateReplace',
            remediation: { retries: schema.spec.retries },
          },
          id: 'certManager',
        }),
      }),
      () => ({ ready: true })
    );
    const yaml = graph.toYaml();
    expect(yaml).toContain('timeout: ${schema.spec.installTimeout}');
    expect(yaml).toContain('retries: ${schema.spec.retries}');
    expect(yaml).toContain('crds: CreateReplace');
  });
});
