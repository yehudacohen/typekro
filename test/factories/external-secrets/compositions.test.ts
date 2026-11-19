import { describe, expect, it } from 'bun:test';
import yaml from 'js-yaml';
import { externalSecretsAws } from '../../../src/factories/external-secrets/index.js';
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
};

async function manifests(input: Record<string, unknown> = spec): Promise<Manifest[]> {
  const factory = await externalSecretsAws.factory('direct', { namespace: 'external-secrets' });
  return (yaml.loadAll(factory.toYaml(input as typeof spec)) as Manifest[]).filter(Boolean);
}

const byKind = (items: Manifest[], kind: string) => {
  const found = items.find((item) => item.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
};

describe('externalSecretsAws (direct mode)', () => {
  it('renders the repository, the controller release and one ClusterSecretStore', async () => {
    expect((await manifests()).map((item) => `${item.kind}/${item.metadata.name}`).sort()).toEqual([
      'ClusterSecretStore/external-secrets',
      'HelmRelease/external-secrets',
      'HelmRepository/external-secrets-repo',
    ]);
  });

  it('points the store at the region with no auth section, and it matches the CRD', async () => {
    const store = byKind(await manifests(), 'ClusterSecretStore');
    expect(store.spec).toEqual({
      provider: { aws: { service: 'SecretsManager', region: 'us-east-1' } },
    });
    expect(specErrors('clustersecretstores.external-secrets.io', store.spec)).toEqual([]);
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

  it('takes the store name when given', async () => {
    const store = byKind(
      await manifests({ ...spec, storeName: 'aws-secrets-manager' }),
      'ClusterSecretStore'
    );
    expect(store.metadata.name).toBe('aws-secrets-manager');
  });
});

describe('externalSecretsAws (KRO mode)', () => {
  type Rgd = {
    kind: string;
    spec: {
      resources: Array<{
        id: string;
        template: { metadata: { annotations?: Record<string, string> } };
      }>;
      schema: { spec: Record<string, string>; status: Record<string, string> };
    };
  };
  const rgd = (): Rgd => {
    const docs = yaml.loadAll(externalSecretsAws.toYaml()) as Rgd[];
    const last = docs[docs.length - 1];
    if (!last) throw new Error('no RGD');
    return last;
  };

  it('serializes to a ResourceGraphDefinition with region and service account as inputs', () => {
    const graph = rgd();
    expect(graph.kind).toBe('ResourceGraphDefinition');
    expect(graph.spec.resources.map((resource) => resource.id).sort()).toEqual([
      'clusterSecretStore',
      'externalSecretsHelmRelease',
      'externalSecretsHelmRepository',
    ]);
    expect(graph.spec.schema.spec.region).toBe('string');
    expect(graph.spec.schema.spec.serviceAccountName).toBe('string');
    expect(graph.spec.schema.status.storeReady).toContain(
      'clusterSecretStore.status.conditions.exists(c, c.type == "Ready" && c.status == "True")'
    );
  });

  it('orders the store after the controller release', () => {
    const store = rgd().spec.resources.find((resource) => resource.id === 'clusterSecretStore');
    expect(Object.keys(store?.template.metadata.annotations ?? {})).toContain(
      'typekro.dev/depends-on-externalSecretsHelmRelease'
    );
  });
});
