import { describe, expect, it } from 'bun:test';
import { getMetadataField } from '../../../src/core/metadata/index.js';
import {
  assertPodIdentityProvider,
  clusterSecretStore,
  DEFAULT_EXTERNAL_SECRETS_CHART_VERSION,
  DEFAULT_EXTERNAL_SECRETS_REPOSITORY_URL,
  externalSecret,
  externalSecretsHelmRelease,
  externalSecretsHelmRepository,
  mapExternalSecretsConfigToHelmValues,
  secretStore,
} from '../../../src/factories/external-secrets/index.js';
import { crd, specErrors } from './crd-schema.js';

const awsSpec = { provider: { aws: { service: 'SecretsManager' as const, region: 'us-east-1' } } };

function ready(
  resource: { readinessEvaluator?: (live: unknown) => { ready: boolean } },
  status: unknown
): boolean {
  if (!resource.readinessEvaluator) throw new Error('resource has no readiness evaluator');
  return resource.readinessEvaluator({ status }).ready;
}

describe('ClusterSecretStore and SecretStore', () => {
  it('create v1 stores whose specs match the published CRDs', () => {
    const cluster = clusterSecretStore({ name: 'aws', spec: awsSpec });
    expect(cluster.apiVersion).toBe('external-secrets.io/v1');
    expect(cluster.kind).toBe('ClusterSecretStore');
    expect(getMetadataField(cluster, 'scope')).toBe('cluster');
    expect(crd('clustersecretstores.external-secrets.io').scope).toBe('Cluster');
    expect(specErrors('clustersecretstores.external-secrets.io', cluster.spec)).toEqual([]);

    const namespaced = secretStore({ name: 'aws', namespace: 'app', spec: awsSpec });
    expect(namespaced.kind).toBe('SecretStore');
    expect(namespaced.metadata.namespace).toBe('app');
    expect(specErrors('secretstores.external-secrets.io', namespaced.spec)).toEqual([]);
  });

  it('authenticate through Pod Identity only: an auth section is refused', () => {
    const withKeys = {
      provider: {
        aws: {
          ...awsSpec.provider.aws,
          auth: { secretRef: { accessKeyIDSecretRef: { name: 'x' } } },
        },
      },
    };
    expect(() => assertPodIdentityProvider(withKeys)).toThrow('EKS Pod Identity');
    expect(() => clusterSecretStore({ name: 'aws', spec: withKeys as typeof awsSpec })).toThrow(
      'EKS Pod Identity'
    );
    expect(() => assertPodIdentityProvider(awsSpec)).not.toThrow();
  });

  it('are ready only when the Ready condition is True', () => {
    const store = clusterSecretStore({ name: 'aws', spec: awsSpec });
    expect(ready(store, { conditions: [{ type: 'Ready', status: 'True', reason: 'Valid' }] })).toBe(
      true
    );
    expect(
      ready(store, {
        conditions: [{ type: 'Ready', status: 'False', reason: 'InvalidProviderConfig' }],
      })
    ).toBe(false);
    expect(ready(store, undefined)).toBe(false);
  });

  it('the schema check catches a field the CRD does not have', () => {
    expect(
      specErrors('clustersecretstores.external-secrets.io', {
        provider: { aws: { ...awsSpec.provider.aws, regionName: 'x' } },
      })
    ).toContain('$.spec.provider.aws: unknown property regionName (the API server would prune it)');
  });
});

describe('ExternalSecret', () => {
  const spec = {
    secretStoreRef: { kind: 'ClusterSecretStore' as const, name: 'aws' },
    refreshInterval: '1h',
    target: { name: 'database', creationPolicy: 'Owner' as const },
    data: [{ secretKey: 'password', remoteRef: { key: 'app/database', property: 'password' } }],
  };

  it('creates a v1 ExternalSecret whose spec matches the published CRD', () => {
    const secret = externalSecret({ name: 'database', namespace: 'app', spec });
    expect(secret.kind).toBe('ExternalSecret');
    expect(secret.metadata.namespace).toBe('app');
    expect(specErrors('externalsecrets.external-secrets.io', secret.spec)).toEqual([]);
  });

  it('is ready once the Secret is synced', () => {
    const secret = externalSecret({ name: 'database', namespace: 'app', spec });
    expect(
      ready(secret, { conditions: [{ type: 'Ready', status: 'True', reason: 'SecretSynced' }] })
    ).toBe(true);
    expect(
      ready(secret, {
        conditions: [{ type: 'Ready', status: 'False', reason: 'SecretSyncedError' }],
      })
    ).toBe(false);
  });
});

describe('Helm', () => {
  it('uses the official chart repository and pins the chart', () => {
    expect(externalSecretsHelmRepository().spec.url).toBe(DEFAULT_EXTERNAL_SECRETS_REPOSITORY_URL);
    const release = externalSecretsHelmRelease({ name: 'external-secrets' });
    expect(release.spec.chart.spec.chart).toBe('external-secrets');
    expect(release.spec.chart.spec.version).toBe(DEFAULT_EXTERNAL_SECRETS_CHART_VERSION);
    expect(DEFAULT_EXTERNAL_SECRETS_CHART_VERSION).toBe('2.15.0');
  });

  it('names the service account for Pod Identity and keeps the CRDs on uninstall', () => {
    expect(mapExternalSecretsConfigToHelmValues({ serviceAccountName: 'eso' })).toEqual({
      installCRDs: true,
      crds: { annotations: { 'helm.sh/resource-policy': 'keep' } },
      serviceAccount: { create: true, name: 'eso' },
    });
  });
});
