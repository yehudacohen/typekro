import { describe, expect, it } from 'bun:test';
import {
  isValuesMergeExpression,
  type ValuesMergeExpression,
} from '../../../src/core/aspects/values-merge.js';
import { TypeKroError } from '../../../src/core/errors.js';
import { getMetadataField } from '../../../src/core/metadata/index.js';
import { Cel } from '../../../src/core/references/cel.js';
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
const clusterSpec = { ...awsSpec, conditions: [{ namespaces: ['app'] }] };

function ready(
  resource: { readinessEvaluator?: (live: unknown) => { ready: boolean } },
  status: unknown
): boolean {
  if (!resource.readinessEvaluator) throw new Error('resource has no readiness evaluator');
  return resource.readinessEvaluator({ status }).ready;
}

describe('ClusterSecretStore and SecretStore', () => {
  it('create v1 stores whose specs match the published CRDs', () => {
    const cluster = clusterSecretStore({ name: 'aws', spec: clusterSpec });
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
    expect(() =>
      clusterSecretStore({ name: 'aws', spec: { ...withKeys, conditions: clusterSpec.conditions } })
    ).toThrow('EKS Pod Identity');
    expect(() => assertPodIdentityProvider(awsSpec)).not.toThrow();
  });

  it('are ready only when the Ready condition is True', () => {
    const store = clusterSecretStore({ name: 'aws', spec: clusterSpec });
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

  it('refuses a ClusterSecretStore that any namespace could use', () => {
    const unconditioned = [
      undefined,
      [],
      [{}],
      [{ namespaces: [] }],
      // An empty selector selects every namespace, even beside a name list.
      [{ namespaceSelector: {} }],
      [{ namespaces: ['app'], namespaceSelector: { matchLabels: {} } }],
    ];
    for (const conditions of unconditioned) {
      const spec = conditions === undefined ? awsSpec : { ...awsSpec, conditions };
      let refusal: unknown;
      try {
        clusterSecretStore({ name: 'aws', spec });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(TypeKroError);
      expect((refusal as TypeKroError).code).toBe('EXTERNAL_SECRETS_CLUSTER_STORE_UNCONDITIONED');
    }
  });

  it('accepts conditions that name namespaces, select them by label or match their names', () => {
    for (const conditions of [
      [{ namespaces: ['app'] }],
      [{ namespaceSelector: { matchLabels: { 'secrets.example.com/aws': 'allowed' } } }],
      [{ namespaceSelector: { matchExpressions: [{ key: 'team', operator: 'Exists' }] } }],
      [{ namespaceRegexes: ['^team-a-'] }],
    ]) {
      const store = clusterSecretStore({ name: 'aws', spec: { ...awsSpec, conditions } });
      expect(specErrors('clustersecretstores.external-secrets.io', store.spec)).toEqual([]);
    }
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

  it('layers caller values without losing the required ones', () => {
    expect(
      mapExternalSecretsConfigToHelmValues({
        serviceAccountName: 'eso',
        values: {
          replicaCount: 2,
          installCRDs: true,
          serviceAccount: { name: 'eso', annotations: { team: 'platform' } },
        },
      })
    ).toEqual({
      crds: { annotations: { 'helm.sh/resource-policy': 'keep' } },
      replicaCount: 2,
      installCRDs: true,
      serviceAccount: { create: true, name: 'eso', annotations: { team: 'platform' } },
    });
  });

  it('refuses raw values that override the CRDs or the Pod Identity service account', () => {
    for (const [values, conflicts] of [
      [{ installCRDs: false }, ['installCRDs']],
      [{ serviceAccount: { create: false } }, ['serviceAccount.create']],
      [{ serviceAccount: { name: 'other' } }, ['serviceAccount.name']],
      [{ serviceAccount: 'other' }, ['serviceAccount']],
      [
        { installCRDs: false, serviceAccount: { create: false, name: 'other' } },
        ['installCRDs', 'serviceAccount.create', 'serviceAccount.name'],
      ],
    ] as const) {
      let refusal: unknown;
      try {
        mapExternalSecretsConfigToHelmValues({ serviceAccountName: 'eso', values });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(TypeKroError);
      expect((refusal as TypeKroError).code).toBe('EXTERNAL_SECRETS_RESERVED_CHART_VALUE');
      expect((refusal as TypeKroError).context).toEqual({ conflicts });
    }
  });

  it('applies the required values last over values only known per instance', () => {
    const perInstance = Cel.expr<Record<string, unknown>>('schema.spec.values');
    const merged = mapExternalSecretsConfigToHelmValues({
      serviceAccountName: 'eso',
      values: perInstance,
    }) as unknown as ValuesMergeExpression;
    expect(isValuesMergeExpression(merged)).toBe(true);
    expect(merged.overlays).toEqual([
      perInstance,
      { installCRDs: true, serviceAccount: { create: true, name: 'eso' } },
    ]);
  });
});
