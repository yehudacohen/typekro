import { describe, expect, it } from 'bun:test';
import yaml from 'js-yaml';
import {
  externalSecretsAws,
  externalSecretsAwsClusterStore,
} from '../../../src/factories/external-secrets/index.js';
import { admissionErrors } from '../../utils/kro-admission.js';
import { specErrors } from './crd-schema.js';

interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
  spec: Record<string, unknown>;
}

const spec = {
  name: 'external-secrets',
  region: 'us-east-1',
  serviceAccountName: 'external-secrets',
  storeNamespace: 'payments',
};

const clusterSpec = {
  name: 'external-secrets',
  region: 'us-east-1',
  serviceAccountName: 'external-secrets',
  allowedNamespaces: ['payments', 'orders'],
};

async function manifests(input: Record<string, unknown> = spec): Promise<Manifest[]> {
  const factory = await externalSecretsAws.factory('direct', { namespace: 'external-secrets' });
  return (yaml.loadAll(factory.toYaml(input as typeof spec)) as Manifest[]).filter(Boolean);
}

async function clusterManifests(input: Record<string, unknown> = clusterSpec): Promise<Manifest[]> {
  const factory = await externalSecretsAwsClusterStore.factory('direct', {
    namespace: 'external-secrets',
  });
  return (yaml.loadAll(factory.toYaml(input as typeof clusterSpec)) as Manifest[]).filter(Boolean);
}

const byKind = (items: Manifest[], kind: string) => {
  const found = items.find((item) => item.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
};

describe('externalSecretsAws (direct mode)', () => {
  it('renders the repository, the controller release and one namespaced SecretStore', async () => {
    expect((await manifests()).map((item) => `${item.kind}/${item.metadata.name}`).sort()).toEqual([
      'HelmRelease/external-secrets',
      'HelmRepository/external-secrets-repo',
      'SecretStore/external-secrets',
    ]);
  });

  it('puts the store in storeNamespace with no auth section, and it matches the CRD', async () => {
    const store = byKind(await manifests(), 'SecretStore');
    expect(store.metadata.namespace).toBe('payments');
    expect(store.spec).toEqual({
      provider: { aws: { service: 'SecretsManager', region: 'us-east-1' } },
    });
    expect(specErrors('secretstores.external-secrets.io', store.spec)).toEqual([]);
  });

  it('names the controller service account for the Pod Identity association', async () => {
    const release = byKind(
      await manifests({ ...spec, serviceAccountName: 'eso-controller' }),
      'HelmRelease'
    );
    expect(release.spec.targetNamespace).toBe('external-secrets');
    expect((release.spec.values as { serviceAccount: unknown }).serviceAccount).toEqual({
      create: true,
      name: 'eso-controller',
    });
  });

  it('refuses raw chart values that move the controller off its service account', async () => {
    await expect(
      manifests({ ...spec, values: { serviceAccount: { name: 'other' } } })
    ).rejects.toThrow("can't override serviceAccount.name");
  });

  it('takes the store name when given', async () => {
    const store = byKind(
      await manifests({ ...spec, storeName: 'aws-secrets-manager' }),
      'SecretStore'
    );
    expect(store.metadata.name).toBe('aws-secrets-manager');
  });
});

describe('externalSecretsAwsClusterStore (direct mode)', () => {
  it('limits the ClusterSecretStore to the allowed namespaces', async () => {
    const store = byKind(await clusterManifests(), 'ClusterSecretStore');
    expect(store.spec).toEqual({
      provider: { aws: { service: 'SecretsManager', region: 'us-east-1' } },
      conditions: [{ namespaces: ['payments', 'orders'] }],
    });
    expect(specErrors('clustersecretstores.external-secrets.io', store.spec)).toEqual([]);
  });

  it('refuses a cluster store with no allowed namespaces', async () => {
    await expect(clusterManifests({ ...clusterSpec, allowedNamespaces: [] })).rejects.toThrow(
      'A ClusterSecretStore namespace list must name at least one namespace; got [].'
    );
  });
});

type Rgd = {
  kind: string;
  spec: {
    resources: Array<{
      id: string;
      template: {
        metadata: { annotations?: Record<string, string>; namespace?: string };
        spec?: Record<string, unknown>;
      };
    }>;
    schema: { spec: Record<string, string>; status: Record<string, string> };
  };
};

const rgdOf = (composition: { toYaml(): string }): Rgd => {
  const docs = yaml.loadAll(composition.toYaml()) as Rgd[];
  const last = docs[docs.length - 1];
  if (!last) throw new Error('no RGD');
  return last;
};

describe('externalSecretsAws (KRO mode)', () => {
  it('serializes to a ResourceGraphDefinition with a namespaced store', () => {
    const graph = rgdOf(externalSecretsAws);
    expect(graph.kind).toBe('ResourceGraphDefinition');
    expect(graph.spec.resources.map((resource) => resource.id).sort()).toEqual([
      'externalSecretsHelmRelease',
      'externalSecretsHelmRepository',
      'secretStore',
    ]);
    expect(graph.spec.schema.spec.region).toBe('string');
    expect(graph.spec.schema.spec.serviceAccountName).toBe('string');
    const store = graph.spec.resources.find((resource) => resource.id === 'secretStore');
    expect(store?.template.metadata.namespace).toBe('${schema.spec.storeNamespace}');
    expect(graph.spec.schema.status.storeReady).toContain(
      'secretStore.status.conditions.exists(c, c.type == "Ready" && c.status == "True")'
    );
  });

  it('orders the store after the controller release', () => {
    const store = rgdOf(externalSecretsAws).spec.resources.find(
      (resource) => resource.id === 'secretStore'
    );
    expect(Object.keys(store?.template.metadata.annotations ?? {})).toContain(
      'typekro.dev/depends-on-externalSecretsHelmRelease'
    );
  });

  it('refuses a store namespace that is not a namespace name at admission', () => {
    const yamlText = externalSecretsAws.toYaml();
    expect(admissionErrors(yamlText, 'ExternalSecretsAws', spec)).toEqual([]);
    expect(
      admissionErrors(yamlText, 'ExternalSecretsAws', { ...spec, storeNamespace: 'Payments' })
    ).toHaveLength(1);
  });
});

describe('externalSecretsAwsClusterStore (KRO mode)', () => {
  it('conditions the ClusterSecretStore on the allowed namespaces', () => {
    const store = rgdOf(externalSecretsAwsClusterStore).spec.resources.find(
      (resource) => resource.id === 'clusterSecretStore'
    );
    // A reference to a required field, not an `omit()` guard: admission refuses an instance
    // without the field rather than producing an unconditioned store.
    expect(store?.template.spec?.conditions).toEqual([
      { namespaces: '${schema.spec.allowedNamespaces}' },
    ]);
  });

  it('admits an instance that names the allowed namespaces', () => {
    const yamlText = externalSecretsAwsClusterStore.toYaml();
    expect(admissionErrors(yamlText, 'ExternalSecretsAwsClusterStore', clusterSpec)).toEqual([]);
  });

  it('refuses an unconditioned cluster store at admission, where the body check never runs', () => {
    const yamlText = externalSecretsAwsClusterStore.toYaml();
    expect(
      admissionErrors(yamlText, 'ExternalSecretsAwsClusterStore', {
        ...clusterSpec,
        allowedNamespaces: [],
      })
    ).toEqual(['spec.allowedNamespaces: fewer than 1 items']);
    const { allowedNamespaces: _omitted, ...withoutNamespaces } = clusterSpec;
    expect(admissionErrors(yamlText, 'ExternalSecretsAwsClusterStore', withoutNamespaces)).toEqual([
      'spec.allowedNamespaces: Required value',
    ]);
    expect(
      admissionErrors(yamlText, 'ExternalSecretsAwsClusterStore', {
        ...clusterSpec,
        allowedNamespaces: ['payments', '*'],
      })
    ).toHaveLength(1);
  });
});
