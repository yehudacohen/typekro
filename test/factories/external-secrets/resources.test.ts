import { describe, expect, it } from 'bun:test';
import { type, type Type } from 'arktype';
import yaml from 'js-yaml';
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
  clusterSecretStoreConditions,
  clusterSecretStoreNamespaces,
  DEFAULT_EXTERNAL_SECRETS_CHART_VERSION,
  DEFAULT_EXTERNAL_SECRETS_REPOSITORY_URL,
  externalSecret,
  externalSecretsHelmRelease,
  externalSecretsHelmRepository,
  mapExternalSecretsConfigToHelmValues,
  secretStore,
} from '../../../src/factories/external-secrets/index.js';
import { CLUSTER_SECRET_STORE_CONDITIONS } from '../../../src/factories/external-secrets/resources/store-conditions.js';
import { kubernetesComposition } from '../../../src/index.js';
import { admissionErrors, instanceSpecSchema } from '../../utils/kro-admission.js';
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

describe('clusterSecretStore with conditions from the composition spec', () => {
  const status = type({ ready: 'boolean' });

  /** A composition passing `pick(spec)` as the store's conditions. */
  function storeComposition(schema: Type<object>, pick: (spec: never) => unknown) {
    return kubernetesComposition(
      { name: 'conditioned-store', kind: 'ConditionedStore', spec: schema, status },
      (spec) => {
        clusterSecretStore({
          name: 'aws',
          spec: { ...awsSpec, conditions: pick(spec as never) as typeof clusterSpec.conditions },
          id: 'store',
        });
        return { ready: true };
      }
    );
  }

  /** Defining the composition runs its body against the schema proxy; then serialize it. */
  function build(schema: Type<object>, pick: (spec: never) => unknown): string {
    return storeComposition(schema, pick).toYaml();
  }

  /** The code of the innermost TypeKroError `run` throws, through composition wrappers. */
  function refusalCode(run: () => unknown): string | undefined {
    try {
      run();
    } catch (error) {
      let code: string | undefined;
      for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
        if (cause instanceof TypeKroError) code = cause.code;
      }
      return code ?? `untyped: ${String(error)}`;
    }
    return undefined;
  }

  const constrained = type({ conditions: clusterSecretStoreConditions() });
  const fromConditions = (spec: { conditions: unknown }) => spec.conditions;

  describe('a field declared with clusterSecretStoreConditions()', () => {
    const yamlText = build(constrained, fromConditions);

    it('passes the conditions through to the store', () => {
      const rgd = (
        yaml.loadAll(yamlText) as Array<{
          kind: string;
          spec: { resources: Array<{ id: string; template: { spec: { conditions: unknown } } }> };
        }>
      ).find((document) => document?.kind === 'ResourceGraphDefinition');
      const store = rgd?.spec.resources.find((resource) => resource.id === 'store');
      expect(store?.template.spec.conditions).toBe('${schema.spec.conditions}');
    });

    it('admits instances whose conditions each limit the store', () => {
      for (const conditions of [
        [{ namespaces: ['app'] }],
        [{ namespaceSelector: { matchLabels: { 'secrets.example.com/aws': 'allowed' } } }],
        [{ namespaceSelector: { matchExpressions: [{ key: 'team', operator: 'Exists' }] } }],
        [{ namespaceRegexes: ['^team-a-'] }],
        [{ namespaces: ['app'] }, { namespaceRegexes: ['^team-a-'] }],
      ]) {
        expect(admissionErrors(yamlText, 'ConditionedStore', { conditions })).toEqual([]);
      }
    });

    it('refuses at admission the instances the factory refuses in direct mode', () => {
      const rule = `failed rule: ${CLUSTER_SECRET_STORE_CONDITIONS.rule}`;
      expect(admissionErrors(yamlText, 'ConditionedStore', {})).toEqual([
        'spec.conditions: Required value',
      ]);
      for (const conditions of [
        [],
        [{}],
        [{ namespaces: [] }],
        [{ namespaceSelector: {} }],
        [{ namespaces: ['app'], namespaceSelector: { matchLabels: {} } }],
        [{ namespaces: ['app'] }, {}],
      ]) {
        expect(admissionErrors(yamlText, 'ConditionedStore', { conditions })).toEqual([
          `spec.conditions: ${rule}`,
        ]);
      }
    });

    it('declares each condition as a structured type, so the rule can read its fields', () => {
      const schema = instanceSpecSchema(yamlText, 'ConditionedStore');
      expect(schema.required).toContain('conditions');
      expect(Object.keys(schema.properties?.conditions?.items?.properties ?? {}).sort()).toEqual([
        'namespaceRegexes',
        'namespaceSelector',
        'namespaces',
      ]);
    });

    it('refuses the same conditions in direct mode', async () => {
      const factory = storeComposition(constrained, fromConditions).factory('direct');
      expect(
        (
          yaml.loadAll(factory.toYaml({ conditions: [{ namespaces: ['app'] }] })) as Array<{
            kind?: string;
          }>
        )
          .filter(Boolean)
          .map((document) => document.kind)
      ).toContain('ClusterSecretStore');
      for (const conditions of [[], [{}], [{ namespaceSelector: {} }]]) {
        expect(() => factory.toYaml({ conditions })).toThrow(/limit it to some namespaces/);
      }
    });
  });

  it('accepts a condition whose namespaces come from a field declared with clusterSecretStoreNamespaces()', () => {
    expect(
      refusalCode(() =>
        build(type({ allowed: clusterSecretStoreNamespaces() }), (spec: { allowed: unknown }) => [
          { namespaces: spec.allowed },
        ])
      )
    ).toBeUndefined();
  });

  it('refuses at build time conditions from a field that does not carry the constraint', () => {
    const unguarded: [Type<object>, (spec: never) => unknown][] = [
      // An unconstrained list of conditions: an instance could send [] or [{}].
      [
        type({
          conditions: type({ 'namespaces?': 'string[]', 'namespaceRegexes?': 'string[]' }).array(),
        }),
        fromConditions,
      ],
      // The constrained type on an optional field: an instance could omit it.
      [type({ 'conditions?': clusterSecretStoreConditions() }), fromConditions],
      // An unconstrained namespace list: an instance could send [].
      [
        type({ allowed: 'string[]' }),
        (spec: { allowed: unknown }) => [{ namespaces: spec.allowed }],
      ],
      // A guarded list beside an empty selector, which selects every namespace.
      [
        type({ allowed: clusterSecretStoreNamespaces() }),
        (spec: { allowed: unknown }) => [{ namespaces: spec.allowed, namespaceSelector: {} }],
      ],
      // A selector only known per instance.
      [
        type({ labels: 'Record<string, string>' }),
        (spec: { labels: unknown }) => [{ namespaceSelector: { matchLabels: spec.labels } }],
      ],
      // A CEL expression over the guarded field.
      [
        constrained,
        (spec: { conditions: unknown }) =>
          Cel.expr('has(', spec.conditions, ') ? ', spec.conditions, ' : []'),
      ],
    ];
    for (const [schema, pick] of unguarded) {
      expect(refusalCode(() => build(schema, pick))).toBe(
        'EXTERNAL_SECRETS_CLUSTER_STORE_UNCONDITIONED'
      );
    }
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
