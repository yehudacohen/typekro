/**
 * Opt-in live proof that production ArkType contracts survive the complete
 * ArkType -> KRO SimpleSchema -> generated CRD admission path.
 *
 * RUN_PRODUCTION_SCHEMA_ADMISSION=true bun test \
 *   test/integration/production-schema-admission.test.ts
 *
 * The test installs only uniquely named RGDs through a TypeKro direct factory.
 * Candidate instances use Kubernetes server-side dry-run, so no Harbor or Ceph
 * data-plane resources are created. Teardown removes the RGDs through the same
 * TypeKro factory rather than bypassing lifecycle tracking with kubectl delete.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type } from 'arktype';
import * as yaml from 'js-yaml';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { getKubeConfig } from '../../src/core/kubernetes/client-provider.js';
import {
  harborProductionInstallation,
  type HarborProductionInstallationConfig,
} from '../../src/factories/harbor/index.js';
import { resourceGraphDefinition } from '../../src/factories/kro/resource-graph-definition.js';
import {
  rookCephProductionPlatform,
  type RookCephProductionPlatformConfig,
} from '../../src/factories/rook/index.js';
import {
  createCustomObjectsApiClient,
  createKubernetesObjectApiClient,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  isClusterAvailable,
} from './shared-kubeconfig.js';

type Manifest = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; [key: string]: unknown };
  spec?: Record<string, unknown>;
  [key: string]: unknown;
};

const requested = process.env.RUN_PRODUCTION_SCHEMA_ADMISSION === 'true';
const describeOrSkip = requested && (await isClusterAvailable()) ? describe : describe.skip;
const runToken = `${Date.now().toString(36)}${process.pid.toString(36)}`.slice(-10);
const group = `admission-${runToken}.typekro.dev`;
const harborKind = `HarborProductionAdmission${runToken}`;
const rookKind = `RookProductionAdmission${runToken}`;
const harborRgdName = `harbor-production-admission-${runToken}`;
const rookRgdName = `rook-production-admission-${runToken}`;

setDefaultTimeout(240_000);

function manifests(serialized: string): Manifest[] {
  return yaml
    .loadAll(serialized, undefined, { schema: yaml.JSON_SCHEMA })
    .filter((value): value is Manifest => Boolean(value && typeof value === 'object'));
}

function renderedRgd(serialized: string, name: string, kind: string): Manifest {
  const rgd = structuredClone(
    manifests(serialized).find((manifest) => manifest.kind === 'ResourceGraphDefinition')
  );
  if (!rgd?.spec) throw new Error(`Generated YAML did not contain RGD ${name}.`);
  rgd.metadata = { ...(rgd.metadata ?? {}), name };
  const schema = rgd.spec.schema as Record<string, unknown> | undefined;
  if (!schema) throw new Error(`Generated RGD ${name} did not contain a schema.`);
  schema.kind = kind;
  schema.group = group;
  return rgd;
}

function renderedInstance(serialized: string, originalKind: string, kind: string): Manifest {
  const instance = structuredClone(
    manifests(serialized).find((manifest) => manifest.kind === originalKind)
  );
  if (!instance?.spec) throw new Error(`Generated YAML did not contain ${originalKind}.`);
  instance.apiVersion = `${group}/v1alpha1`;
  instance.kind = kind;
  instance.metadata = {
    ...(instance.metadata ?? {}),
    name: `admission-${runToken}`,
    namespace: 'default',
  };
  return instance;
}

async function serverDryRun(manifest: Manifest): Promise<{ exitCode: number; output: string }> {
  const [group, version] = (manifest.apiVersion ?? '').split('/');
  const namespace = manifest.metadata?.namespace;
  if (!group || !version || !manifest.kind || !namespace) {
    throw new Error(`Invalid namespaced custom resource manifest: ${JSON.stringify(manifest)}`);
  }

  const kubeConfig = getKubeConfig({ skipTLSVerify: true });
  const objectApi = createKubernetesObjectApiClient(kubeConfig);
  const crds = (await objectApi.list(
    'apiextensions.k8s.io/v1',
    'CustomResourceDefinition'
  )) as unknown as {
    items?: Array<{
      spec?: { group?: string; names?: { kind?: string; plural?: string } };
    }>;
  };
  const plural = crds.items?.find(
    (crd) => crd.spec?.group === group && crd.spec?.names?.kind === manifest.kind
  )?.spec?.names?.plural;
  if (!plural) {
    throw new Error(`Could not discover generated CRD for ${group}/${manifest.kind}`);
  }

  try {
    await createCustomObjectsApiClient(kubeConfig).createNamespacedCustomObject({
      group,
      version,
      namespace,
      plural,
      body: manifest,
      dryRun: 'All',
      fieldManager: 'typekro-schema-admission-test',
      fieldValidation: 'Strict',
    });
    return { exitCode: 0, output: `${manifest.kind}/${manifest.metadata?.name ?? ''}` };
  } catch (error: unknown) {
    const candidate = error as { body?: unknown; message?: string };
    return {
      exitCode: 1,
      output:
        typeof candidate.body === 'string'
          ? candidate.body
          : JSON.stringify(candidate.body ?? candidate.message ?? error),
    };
  }
}

function harborConfig(): HarborProductionInstallationConfig {
  const resource = {
    requests: { cpu: '250m', memory: '512Mi' },
    limits: { cpu: '1', memory: '1Gi' },
  };
  return {
    name: 'harbor-admission',
    profile: 'production',
    exposure: {
      type: 'ingress',
      externalUrl: 'https://harbor.example.test',
      tls: { enabled: true, source: 'secret', secretName: 'harbor-tls' },
      ingress: { host: 'harbor.example.test' },
    },
    certificate: {
      secretName: 'harbor-tls',
      issuerRef: { name: 'production-issuer', kind: 'ClusterIssuer' },
    },
    storage: {
      bucket: 'harbor',
      region: 'us-east-1',
      regionEndpoint: 'https://object.example.test',
      existingSecret: 'harbor-s3',
      secure: true,
      skipVerify: false,
    },
    adminPasswordSecret: { name: 'harbor-admin' },
    componentSecrets: {
      encryptionKey: 'harbor-encryption',
      core: 'harbor-core-external',
      jobservice: 'harbor-jobservice-external',
      registry: 'harbor-registry-external',
      registryCredentials: 'harbor-registry-credentials-external',
    },
    database: {
      host: 'postgres.example.test',
      username: 'harbor',
      database: 'harbor',
      existingSecret: 'harbor-postgres',
    },
    cache: {
      address: 'valkey.example.test:6379',
      existingSecret: 'harbor-valkey',
    },
    networkPolicy: {
      enabled: true,
      ingressNamespaceLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
      egressNamespaceLabels: [{ 'kubernetes.io/metadata.name': 'platform-data' }],
    },
    replicas: { core: 2, portal: 2, registry: 2, jobservice: 2, exporter: 2 },
    resources: {
      core: resource,
      portal: resource,
      registry: resource,
      jobservice: resource,
      exporter: resource,
    },
  };
}

function rookConfig(): RookCephProductionPlatformConfig {
  const resource = {
    requests: { cpu: '500m', memory: '1Gi' },
    limits: { memory: '2Gi' },
  };
  return {
    name: 'rook-admission',
    profile: 'production',
    storageClassName: 'production-block',
    storageSize: '100Gi',
    osdCount: 3,
    monCount: 3,
    mgrCount: 2,
    poolReplicas: 3,
    failureDomain: 'host',
    portableVolumes: true,
    resources: {
      mon: resource,
      mgr: resource,
      osd: resource,
      prepareosd: resource,
      rgw: resource,
    },
    monitoring: { enabled: true, createPrometheusRules: true },
    disruptionManagement: { managePodBudgets: true },
    backup: {
      strategy: 'documented-manual',
      recoveryPointObjective: '24h',
      recoveryTimeObjective: '8h',
    },
  };
}

describeOrSkip('production KRO schema admission', () => {
  let cleanup: (() => Promise<unknown>) | undefined;
  let harborInstance: Manifest;
  let rookInstance: Manifest;

  beforeAll(async () => {
    const harborFactory = harborProductionInstallation.factory('kro', { namespace: 'default' });
    const rookFactory = rookCephProductionPlatform.factory('kro', { namespace: 'default' });
    const harborRgd = renderedRgd(harborFactory.toYaml(), harborRgdName, harborKind);
    const rookRgd = renderedRgd(rookFactory.toYaml(), rookRgdName, rookKind);
    harborInstance = renderedInstance(
      harborFactory.toYaml(harborConfig()),
      'HarborProductionInstallation',
      harborKind
    );
    rookInstance = renderedInstance(
      rookFactory.toYaml(rookConfig()),
      'RookCephProductionPlatform',
      rookKind
    );

    const installer = kubernetesComposition(
      {
        name: `production-admission-installer-${runToken}`,
        kind: `ProductionAdmissionInstaller${runToken}`,
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      () => {
        resourceGraphDefinition(harborRgd);
        resourceGraphDefinition(rookRgd);
        return { ready: true };
      }
    );
    const kubeConfig = getKubeConfig({ skipTLSVerify: true });
    const installerFactory = installer.factory('direct', {
      namespace: 'default',
      kubeConfig,
      waitForReady: true,
      timeout: 180_000,
    });
    await installerFactory.deploy({ name: `admission-${runToken}` });
    cleanup = () =>
      deleteTestFactoryInstanceAndRecoverNamespaces(
        installerFactory,
        `admission-${runToken}`,
        [],
        kubeConfig,
        60_000,
        {
          scopes: ['cluster'],
          includeUnscopedResources: true,
        }
      );
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('accepts valid Harbor and Rook production instances', async () => {
    expect(await serverDryRun(harborInstance)).toMatchObject({ exitCode: 0 });
    expect(await serverDryRun(rookInstance)).toMatchObject({ exitCode: 0 });
  });

  it('rejects type-invalid and unsafe Harbor production instances', async () => {
    const stringBoolean = structuredClone(harborInstance);
    const stringPolicy = stringBoolean.spec?.networkPolicy as Record<string, unknown>;
    stringPolicy.enabled = 'true';
    expect((await serverDryRun(stringBoolean)).exitCode).not.toBe(0);

    const disabledPolicy = structuredClone(harborInstance);
    const disabled = disabledPolicy.spec?.networkPolicy as Record<string, unknown>;
    disabled.enabled = false;
    expect((await serverDryRun(disabledPolicy)).exitCode).not.toBe(0);

    const insecureStorage = structuredClone(harborInstance);
    const storage = insecureStorage.spec?.storage as Record<string, unknown>;
    storage.skipVerify = true;
    expect((await serverDryRun(insecureStorage)).exitCode).not.toBe(0);

    const missingIngress = structuredClone(harborInstance);
    const exposure = missingIngress.spec?.exposure as Record<string, unknown>;
    delete exposure.ingress;
    expect((await serverDryRun(missingIngress)).exitCode).not.toBe(0);

    const emptyTlsSecret = structuredClone(harborInstance);
    const emptyTlsExposure = emptyTlsSecret.spec?.exposure as {
      tls: Record<string, unknown>;
    };
    emptyTlsExposure.tls.secretName = '';
    expect((await serverDryRun(emptyTlsSecret)).exitCode).not.toBe(0);

    const emptyCertManagerSecret = structuredClone(harborInstance);
    const certManagerExposure = emptyCertManagerSecret.spec?.exposure as {
      tls: Record<string, unknown>;
    };
    certManagerExposure.tls.source = 'cert-manager';
    delete certManagerExposure.tls.secretName;
    const certificate = emptyCertManagerSecret.spec?.certificate as Record<string, unknown>;
    certificate.secretName = '';
    expect((await serverDryRun(emptyCertManagerSecret)).exitCode).not.toBe(0);
  });

  it('rejects string and false Rook production singleton booleans', async () => {
    const stringBoolean = structuredClone(rookInstance);
    const monitoring = stringBoolean.spec?.monitoring as Record<string, unknown>;
    monitoring.enabled = 'true';
    expect((await serverDryRun(stringBoolean)).exitCode).not.toBe(0);

    const falseBoolean = structuredClone(rookInstance);
    const disruption = falseBoolean.spec?.disruptionManagement as Record<string, unknown>;
    disruption.managePodBudgets = false;
    expect((await serverDryRun(falseBoolean)).exitCode).not.toBe(0);
  });
});
