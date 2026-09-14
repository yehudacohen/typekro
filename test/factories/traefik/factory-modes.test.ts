/**
 * Traefik factory-mode coverage: BOTH factory surfaces exercised explicitly.
 *
 * - DIRECT: `factory('direct', ...).toYaml(spec)` with a fully CONCRETE spec,
 *   asserting the emitted manifests carry no unresolved schema references.
 * - KRO: `factory('kro', ...).toYaml(instance)` asserting the instance bundle
 *   includes the singleton owner instance plus the CR, and
 *   `factory('kro', ...).toYaml()` asserting the RGD preserves the status
 *   contract and the chart wiring.
 *
 * Runs under TYPEKRO_STRICT_CEL=1 with a hermetic kubeconfig: some
 * serialization paths resolve the active kubeconfig, and a dangling context on
 * the host would otherwise fail with "No active cluster".
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';

import {
  DEFAULT_TRAEFIK_CHART_VERSION,
  DEFAULT_TRAEFIK_REPOSITORY_NAME,
} from '../../../src/factories/traefik/constants.js';
import { traefikBootstrap } from '../../../src/factories/traefik/compositions/traefik-bootstrap.js';
import type { TraefikBootstrapConfig } from '../../../src/factories/traefik/types.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;
const ORIGINAL_KUBECONFIG = process.env.KUBECONFIG;
let kubeconfigDir: string | undefined;

const CONCRETE_SPEC: TraefikBootstrapConfig = {
  name: 'traefik',
  namespace: 'traefik',
  chartVersion: DEFAULT_TRAEFIK_CHART_VERSION,
  replicas: 3,
  ingressClass: 'traefik',
  service: {
    type: 'LoadBalancer',
    annotations: {
      'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
      'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'ip',
      'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
    },
  },
  entrypoints: {
    web: { exposedPort: 80 },
    websecure: { exposedPort: 443, readTimeout: '120s', writeTimeout: '120s' },
  },
  providers: { crd: true, gatewayApi: true, kubernetesIngress: false },
  accessLogs: true,
  logLevel: 'INFO',
  otlp: { endpoint: 'otel-collector.observability.svc.cluster.local:4317', insecure: true },
  dashboard: false,
};

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';

  kubeconfigDir = mkdtempSync(join(tmpdir(), 'typekro-traefik-factory-modes-'));
  const kubeconfigPath = join(kubeconfigDir, 'kubeconfig');
  writeFileSync(
    kubeconfigPath,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- cluster: { server: "https://127.0.0.1:1" }',
      '  name: hermetic',
      'contexts:',
      '- context: { cluster: hermetic, user: hermetic }',
      '  name: hermetic',
      'current-context: hermetic',
      'users:',
      '- name: hermetic',
      '  user: {}',
      '',
    ].join('\n')
  );
  process.env.KUBECONFIG = kubeconfigPath;
});

afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) delete process.env.TYPEKRO_STRICT_CEL;
  else process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
  if (ORIGINAL_KUBECONFIG === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = ORIGINAL_KUBECONFIG;
  if (kubeconfigDir) rmSync(kubeconfigDir, { recursive: true, force: true });
});

interface YamlDocument {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: Record<string, unknown>;
}

function documents(yaml: string): YamlDocument[] {
  return loadAll(yaml).filter(
    (document): document is YamlDocument =>
      document !== null && typeof document === 'object' && !Array.isArray(document)
  );
}

describe('traefikBootstrap — direct mode', () => {
  it('emits fully resolved manifests with no schema references', () => {
    const yaml = traefikBootstrap
      .factory('direct', { namespace: 'flux-system' })
      .toYaml(CONCRETE_SPEC);

    expect(yaml).not.toContain('${schema.spec');
    expect(yaml).not.toContain('[object Object]');
    expect(yaml).not.toContain('omit()');
  });

  it('resolves the concrete spec into chart values', () => {
    const yaml = traefikBootstrap
      .factory('direct', { namespace: 'flux-system' })
      .toYaml(CONCRETE_SPEC);
    const release = documents(yaml).find((document) => document.kind === 'HelmRelease');
    const values = (release?.spec as { values?: Record<string, unknown> }).values as {
      deployment?: { replicas?: number };
      service?: { enabled?: boolean };
      providers?: Record<string, { enabled?: boolean }>;
      accessLog?: { enabled?: boolean };
      tracing?: { otlp?: { enabled?: boolean; grpc?: { endpoint?: string } } };
      ports?: Record<string, { exposedPort?: number; transport?: Record<string, unknown> }>;
      fullnameOverride?: string;
      nameOverride?: string;
      instanceLabelOverride?: string;
    };

    expect(values.deployment?.replicas).toBe(3);
    // The entrypoint Service is a resource this factory owns, so the chart's
    // own Service is off and its type/annotations are not chart values.
    expect(values.service?.enabled).toBe(false);
    expect(values.nameOverride).toBe('traefik');
    expect(values.instanceLabelOverride).toBe('traefik');
    expect(values.providers?.kubernetesCRD?.enabled).toBe(true);
    expect(values.providers?.kubernetesGateway?.enabled).toBe(true);
    expect(values.providers?.kubernetesIngress?.enabled).toBe(false);
    expect(values.accessLog?.enabled).toBe(true);
    expect(values.tracing?.otlp?.enabled).toBe(true);
    expect(values.tracing?.otlp?.grpc?.endpoint).toBe(
      'otel-collector.observability.svc.cluster.local:4317'
    );
    expect(values.ports?.websecure?.exposedPort).toBe(443);
    expect(values.fullnameOverride).toBe('traefik');
  });

  it('owns the entrypoint Service with the concrete type and annotations', () => {
    const yaml = traefikBootstrap
      .factory('direct', { namespace: 'flux-system' })
      .toYaml(CONCRETE_SPEC);
    const owned = documents(yaml).find(
      (document) => document.kind === 'Service' && document.metadata?.name === 'traefik'
    );
    const spec = owned?.spec as
      | {
          type?: string;
          selector?: Record<string, string>;
          ports?: { name?: string; port?: number; targetPort?: string; protocol?: string }[];
        }
      | undefined;

    expect(owned?.metadata?.namespace).toBe('traefik');
    expect(
      (owned?.metadata as { annotations?: Record<string, string> } | undefined)?.annotations?.[
        'service.beta.kubernetes.io/aws-load-balancer-type'
      ]
    ).toBe('external');
    expect(spec?.type).toBe('LoadBalancer');
    // Exactly the chart's own pod selector, both halves of which the values
    // mapper pins (`nameOverride`, `instanceLabelOverride`).
    expect(spec?.selector).toEqual({
      'app.kubernetes.io/name': 'traefik',
      'app.kubernetes.io/instance': 'traefik',
    });
    expect(spec?.ports).toEqual([
      { name: 'web', port: 80, targetPort: 'web', protocol: 'TCP' },
      { name: 'websecure', port: 443, targetPort: 'websecure', protocol: 'TCP' },
    ]);
  });

  it('disables OTLP export when no endpoint is given', () => {
    const yaml = traefikBootstrap
      .factory('direct', { namespace: 'flux-system' })
      .toYaml({ name: 'traefik', namespace: 'traefik' });
    const release = documents(yaml).find((document) => document.kind === 'HelmRelease');
    const values = (release?.spec as { values?: Record<string, unknown> }).values as {
      tracing?: { otlp?: { enabled?: boolean } };
      metrics?: { otlp?: { enabled?: boolean } };
    };

    expect(values.tracing?.otlp?.enabled).toBe(false);
    expect(values.metrics?.otlp?.enabled).toBe(false);
  });

  it('owns the install namespace and references the shared repository by name', () => {
    const yaml = traefikBootstrap
      .factory('direct', { namespace: 'flux-system' })
      .toYaml(CONCRETE_SPEC);
    const namespaceDocument = documents(yaml).find((document) => document.kind === 'Namespace');
    const release = documents(yaml).find((document) => document.kind === 'HelmRelease');
    const chart = (release?.spec as { chart?: { spec?: { sourceRef?: { name?: string } } } }).chart;

    expect(namespaceDocument?.metadata?.name).toBe('traefik');
    expect(chart?.spec?.sourceRef?.name).toBe(DEFAULT_TRAEFIK_REPOSITORY_NAME);
    // Direct mode omits singleton-owned resources; the release refers to the
    // repository by sourceRef instead.
    expect(documents(yaml).some((document) => document.kind === 'HelmRepository')).toBe(false);
  });

  it('pins the Helm release name to `name` rather than letting Flux compose one', () => {
    const yaml = traefikBootstrap
      .factory('direct', { namespace: 'flux-system' })
      .toYaml(CONCRETE_SPEC);
    const release = documents(yaml).find((document) => document.kind === 'HelmRelease');
    const spec = release?.spec as {
      releaseName?: string;
      targetNamespace?: string;
      values?: { fullnameOverride?: string };
    };

    // Unset, Flux's GetReleaseName() would compose `<targetNamespace>-<name>`
    // — 'traefik-traefik' here — and the install namespace would eat into
    // Helm's 53-character release-name budget, which is what bounds `name`.
    expect(spec.targetNamespace).toBe('traefik');
    expect(spec.releaseName).toBe('traefik');
    // The release name and the chart's resource-name anchor are the same value.
    expect(spec.values?.fullnameOverride).toBe('traefik');
  });

  it('exposes a direct factory with the deployment surface', () => {
    const factory = traefikBootstrap.factory('direct', { namespace: 'flux-system' });

    expect(factory.mode).toBe('direct');
    expect(factory.deploy).toBeTypeOf('function');
    expect(factory.toYaml).toBeTypeOf('function');
  });
});

describe('traefikBootstrap — kro mode', () => {
  it('emits the singleton owner instance alongside the composition CR', () => {
    const yaml = traefikBootstrap.factory('kro', { namespace: 'traefik' }).toYaml(CONCRETE_SPEC);
    const parsed = documents(yaml);

    const owner = parsed.find((document) => document.kind === 'TraefikHelmRepository');
    const instance = parsed.find((document) => document.kind === 'TraefikBootstrap');

    expect(owner?.metadata?.namespace).toBe('typekro-singletons');
    expect(instance?.metadata?.name).toBe('traefik');
    expect(instance?.metadata?.namespace).toBe('traefik');
    expect(parsed.indexOf(owner!)).toBeLessThan(parsed.indexOf(instance!));
  });

  it('carries the concrete spec onto the custom resource', () => {
    const yaml = traefikBootstrap.factory('kro', { namespace: 'traefik' }).toYaml(CONCRETE_SPEC);
    const instance = documents(yaml).find((document) => document.kind === 'TraefikBootstrap');

    expect(instance?.spec).toMatchObject({
      name: 'traefik',
      namespace: 'traefik',
      replicas: 3,
      dashboard: false,
    });
  });

  it('emits an RGD whose status contract references the release and the Service', () => {
    const yaml = traefikBootstrap.factory('kro', { namespace: 'traefik' }).toYaml();
    const rgd = documents(yaml).find(
      (document) =>
        document.kind === 'ResourceGraphDefinition' &&
        (document.spec as { schema?: { kind?: string } }).schema?.kind === 'TraefikBootstrap'
    );
    const status = (rgd?.spec as { schema?: { status?: Record<string, string> } }).schema?.status;

    expect(status?.ready).toContain('traefikHelmRelease');
    expect(status?.failed).toContain('traefikHelmRelease');
    expect(status?.phase).toContain('Installing');
    expect(status?.serviceName).toContain('traefikService');
  });

  it('guards every OTLP reference so an omitted block cannot break CEL', () => {
    const yaml = traefikBootstrap.factory('kro', { namespace: 'traefik' }).toYaml();
    const otlpExpressions = yaml.match(/\$\{[^}]*schema\.spec\.otlp[^}]*\}/g) ?? [];

    expect(otlpExpressions.length).toBeGreaterThan(0);
    for (const expression of otlpExpressions) {
      expect(expression).toContain('has(schema.spec.otlp)');
    }
  });

  it('keeps the chart pin and the CRD-carrying single release in the RGD', () => {
    const yaml = traefikBootstrap.factory('kro', { namespace: 'traefik' }).toYaml();

    // The version is a guarded CEL default, so the pin appears as its fallback.
    expect(yaml).toContain(`: "${DEFAULT_TRAEFIK_CHART_VERSION}"`);
    expect(yaml).toContain('chart: traefik');
    expect(yaml).not.toContain('traefik-crds');
  });

  it('exposes a kro factory with the deployment surface', () => {
    const factory = traefikBootstrap.factory('kro', { namespace: 'traefik' });

    expect(factory.mode).toBe('kro');
    expect(factory.deploy).toBeTypeOf('function');
    expect(factory.toYaml).toBeTypeOf('function');
  });
});
