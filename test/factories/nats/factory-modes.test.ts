import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { resourceFromDirectArtifactRecordForTest } from '../../../src/alchemy/resource-registration.js';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { Cel } from '../../../src/core/references/cel.js';
import { nackControllerBootstrap } from '../../../src/factories/nats/compositions/nack-controller-bootstrap.js';
import {
  makeNatsBootstrap,
  natsBootstrap,
} from '../../../src/factories/nats/compositions/nats-bootstrap.js';
import {
  DEFAULT_NACK_VERSION,
  DEFAULT_NATS_VERSION,
} from '../../../src/factories/nats/resources/helm.js';
import {
  jetStreamConsumer,
  jetStreamStream,
} from '../../../src/factories/nats/resources/jetstream.js';

function documents(yaml: string): string[] {
  return yaml
    .split(/^---$/m)
    .map((document) => document.trim())
    .filter(Boolean);
}

function kind(document: string): string | undefined {
  return document.match(/^kind: (.+)$/m)?.[1];
}

const streamResources = kubernetesComposition(
  {
    name: 'jetstream-resources',
    kind: 'JetStreamResources',
    spec: type({ name: 'string', namespace: 'string' }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const stream = jetStreamStream({
      id: 'events',
      name: 'application-events',
      streamName: spec.name,
      namespace: spec.namespace,
      subjects: ['applik8s.events.>'],
      storage: 'file',
      retention: 'limits',
      replicas: 1,
      duplicateWindow: '2m',
      preventDelete: true,
      servers: ['nats://nats.nats-system.svc:4222'],
    });
    const consumer = jetStreamConsumer({
      id: 'processor',
      name: 'account-commands',
      namespace: spec.namespace,
      streamName: spec.name,
      ackPolicy: 'explicit',
      ackWait: '30s',
      maxDeliver: 5,
      filterSubject: 'applik8s.events.account-changed.>',
      servers: ['nats://nats.nats-system.svc:4222'],
    });
    return {
      ready: Cel.expr<boolean>(
        stream.status.observedGeneration,
        ' > 0 && ',
        consumer.status.observedGeneration,
        ' > 0'
      ),
    };
  }
);

describe('NATS and JetStream factories', () => {
  it('emits the instance-owned NATS server with persistent JetStream defaults', () => {
    const yaml = natsBootstrap.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'nats',
      namespace: 'nats-system',
      replicas: 3,
      storageSize: '20Gi',
    });
    const docs = documents(yaml);

    expect(docs.map(kind).filter((value) => value === 'HelmRelease')).toHaveLength(1);
    expect(docs.map(kind)).toContain('Namespace');
    expect(docs.map(kind)).toContain('HelmRepository');
    expect(yaml).toContain(`version: ${DEFAULT_NATS_VERSION}`);
    expect(yaml).not.toContain(`version: ${DEFAULT_NACK_VERSION}`);
    expect(yaml).toMatch(/jetstream:\s*\n\s+enabled: true/);
    expect(yaml).toMatch(/cluster:\s*\n\s+enabled: true\s*\n\s+replicas: 3/);
    expect(yaml).toContain('size: 20Gi');
    expect(yaml).toContain('fullnameOverride: nats');
    expect(yaml).toMatch(
      /statefulSet:\s*\n\s+merge:\s*\n\s+spec:\s*\n\s+persistentVolumeClaimRetentionPolicy:\s*\n\s+whenDeleted: Retain\s*\n\s+whenScaled: Retain/
    );

    const ephemeral = natsBootstrap.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'ephemeral-nats',
      namespace: 'nats-system',
      pvcRetentionPolicy: 'delete',
    });
    expect(ephemeral).toMatch(
      /statefulSet:\s*\n\s+merge:\s*\n\s+spec:\s*\n\s+persistentVolumeClaimRetentionPolicy:\s*\n\s+whenDeleted: Delete\s*\n\s+whenScaled: Retain/
    );

    const externallyOwnedNamespace = natsBootstrap
      .factory('direct', { namespace: 'typekro-system' })
      .toYaml({
        name: 'durable-nats',
        namespace: 'durable-nats-system',
        namespaceOwnership: 'external',
      });
    expect(documents(externallyOwnedNamespace).map(kind)).not.toContain('Namespace');
    expect(externallyOwnedNamespace).toContain('namespace: durable-nats-system');
    for (const document of documents(externallyOwnedNamespace).filter(
      (document) => kind(document) === 'HelmRelease'
    )) {
      expect(document).toMatch(/metadata:\s*\n\s+name: .+\n\s+namespace: durable-nats-system/);
    }

    const customName = natsBootstrap.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'application-events',
      namespace: 'nats-system',
    });
    expect(customName).toContain('fullnameOverride: application-events');
  });

  it('owns one cluster-wide NACK controller in CRD-connect mode', () => {
    const yaml = nackControllerBootstrap
      .factory('direct', { namespace: 'typekro-singletons' })
      .toYaml({
        name: 'nack',
        namespace: 'typekro-nack-system',
        version: DEFAULT_NACK_VERSION,
      });
    const docs = documents(yaml);

    expect(docs.map(kind)).toEqual(['Namespace', 'HelmRepository', 'HelmRelease']);
    expect(yaml).toContain(`version: ${DEFAULT_NACK_VERSION}`);
    expect(yaml).toMatch(/jetstream:\s*\n\s+controlLoop: true\s*\n\s+enabled: true/);
    expect(yaml).toContain('namespaced: false');
    expect(yaml).toContain('nameOverride: nack');
    expect(yaml).toContain('namespaceOverride: typekro-nack-system');
    expect(yaml).toContain('serviceAccountName: nack-controller');
    expect(yaml).toContain('useLegacyNames: false');
    expect(yaml).toContain('readOnly: false');
    expect(yaml).toContain('automountServiceAccountToken: true');
    // Omitting jetstream.nats.url selects NACK's official -crd-connect mode.
    // Stream/Consumer/Account resources carry their own target connection.
    expect(yaml).not.toContain('url: nats://');
  });

  it('protects singleton routing and lifecycle values from Helm passthrough overrides', async () => {
    const customized = makeNatsBootstrap({
      controller: {
        values: {
          namespaced: true,
          readOnly: true,
          nameOverride: 'unsafe-name',
          namespaceOverride: 'unsafe-namespace',
          serviceAccountName: 'jetstream-controller',
          useLegacyNames: true,
          jetstream: {
            enabled: false,
            controlLoop: false,
          },
          resources: { requests: { cpu: '100m' } },
        },
      },
    });
    const declarations = await customized
      .factory('direct', { namespace: 'typekro-system', waitForReady: false })
      .toAlchemyResources({
        name: 'application-events',
        namespace: 'application-system',
        namespaceOwnership: 'external',
      });
    const controller = declarations.find(
      (declaration) => declaration.props.resourceId === 'nackHelmRelease'
    );

    expect(controller?.props.resource.spec?.values).toMatchObject({
      namespaced: false,
      readOnly: false,
      automountServiceAccountToken: true,
      nameOverride: 'nack',
      namespaceOverride: 'typekro-nack-system',
      serviceAccountName: 'nack-controller',
      useLegacyNames: false,
      jetstream: {
        enabled: true,
        controlLoop: true,
      },
      resources: { requests: { cpu: '100m' } },
    });

    expect(() =>
      nackControllerBootstrap.factory('direct', { namespace: 'typekro-singletons' }).toYaml({
        name: 'nack',
        namespace: 'typekro-nack-system',
        values: {
          jetstream: {
            nats: { url: 'nats://one.example:4222' },
          },
        },
      })
    ).toThrow(/values\.jetstream\.nats must be omitted/);

    const rgd = nackControllerBootstrap
      .factory('kro', { namespace: 'typekro-singletons' })
      .toYaml();
    expect(rgd).toContain('values: object | validation="');
    expect(rgd).toContain('size(self.jetstream.nats) == 0');
    expect(rgd).toContain('size(self.jetstream.tls) == 0');
    expect(rgd).toContain('arg.startsWith');
    expect(rgd).toContain('!has(self.rbacRules)');
    expect(rgd).toContain('"serviceAccountName": string(schema.spec.name) + "-controller"');
  });

  it('serializes bootstrap in KRO mode and hoists an owned workload Namespace out of the graph', () => {
    const factory = natsBootstrap.factory('kro', { namespace: 'typekro-system' });
    const rgd = factory.toYaml();
    expect(rgd.match(/kind: ResourceGraphDefinition/g)).toHaveLength(2);
    expect(rgd).toContain('name: nack-controller-bootstrap');
    expect(rgd).toContain('kind: NackControllerBootstrap');
    expect(rgd).toContain('namespace: typekro-singletons');
    expect(rgd).toContain('kind: HelmRelease');
    expect(rgd).toContain('has(schema.spec.namespace) ? schema.spec.namespace');
    expect(rgd).toContain('(has(schema.spec.replicas) ? schema.spec.replicas : 1) > 1');
    expect(rgd).toContain('replicas: integer | minimum=1');
    expect(rgd).toContain('pvcRetentionPolicy: string | enum="delete,retain"');
    expect(rgd).toContain('namespaceOwnership: string | enum="external,owned"');
    expect(rgd).toContain('nackValues: object | validation="dyn(self) == dyn({})"');
    expect(rgd).toContain('nackVersion: string | validation="self == \\"0.34.0\\""');
    expect(rgd).toContain('schema.spec.pvcRetentionPolicy');
    expect(rgd).toContain('Delete');
    // The owned workload Namespace (named after spec.namespace) is hoisted OUT of
    // the shared RGD graph — it is no longer a graph child that KRO could GC.
    expect(rgd).not.toContain('kind: Namespace');

    const minimal = factory.toYaml({ name: 'nats' });
    expect(minimal).toContain('kind: NatsBootstrap');
    expect(minimal).toContain('name: nats');
    expect(minimal).not.toContain('spec:\n  name: nats\n  namespace:');
    expect(minimal).toContain('kind: NackControllerBootstrap');
    expect(minimal).toContain('name: nack-controller');

    const clustered = factory.toYaml({ name: 'nats', replicas: 3 });
    expect(clustered).toContain('replicas: 3');

    // natsBootstrap owns its workload Namespace, so the natural same-namespace call
    // HOISTS that namespace out of the graph (retained, deps-first) and leaves the
    // instance CR in its natural namespace — no relocation, no rejection.
    const hoisted = natsBootstrap.factory('kro', { namespace: 'nats-system' }).toYaml({
      name: 'nats',
      namespace: 'nats-system',
    });
    expect(hoisted).toContain('kind: NatsBootstrap');
    expect(hoisted).toMatch(/namespace: nats-system$/m);
    expect(hoisted).not.toContain('typekro-system');
    expect(hoisted).toContain('typekro.io/kro-instance-namespace');

    // Pinning the instance CR into its own owned namespace is now SAFE: the namespace
    // is a sibling created before the RGD and deleted after it, so it no longer risks
    // finalizer stranding — it just hoists.
    expect(() =>
      natsBootstrap
        .factory('kro', { namespace: 'nats-system', instanceNamespace: 'nats-system' })
        .toYaml({ name: 'nats', namespace: 'nats-system' })
    ).not.toThrow();

    // An externally-owned namespace is never owned, so it is never hoisted and
    // never throws (the conditional Namespace is inactive for this spec).
    const external = natsBootstrap.factory('kro', { namespace: 'nats-system' }).toYaml({
      name: 'nats',
      namespace: 'nats-system',
      namespaceOwnership: 'external',
    });
    expect(external).toContain('kind: NatsBootstrap');
    expect(external).toContain("typekro.io/hoisted-namespaces: '[]'");
  });

  it('materializes one singleton NACK owner and an independent NATS server graph', async () => {
    const declarations = await natsBootstrap
      .factory('direct', { namespace: 'typekro-system', waitForReady: false })
      .toAlchemyResources({
        name: 'application-events',
        namespace: 'application-system',
        namespaceOwnership: 'external',
      });
    const byResourceId = new Map(
      declarations.map((declaration) => [declaration.props.resourceId, declaration])
    );
    const repository = byResourceId.get('natsHelmRepository');
    const server = byResourceId.get('natsHelmRelease');
    const controllerNamespace = byResourceId.get('nackNamespace');
    const controllerRepository = byResourceId.get('nackHelmRepository');
    const controller = byResourceId.get('nackHelmRelease');

    expect(repository).toBeDefined();
    expect(controllerNamespace).toBeDefined();
    expect(controllerRepository).toBeDefined();
    expect(controller).toBeDefined();
    expect(controllerNamespace?.props.resource.metadata?.name).toBe('typekro-nack-system');
    expect(controller?.props.resource.metadata?.namespace).toBe('typekro-nack-system');
    expect(controller?.props.resource.spec?.values).toMatchObject({
      jetstream: { enabled: true, controlLoop: true },
      namespaced: false,
    });
    expect(controller?.props.resource.spec?.values).not.toHaveProperty('jetstream.nats.url');
    expect(server?.dependsOn).toContain(repository?.id);
    expect(controller?.dependsOn).toContain(controllerRepository?.id);
    expect(declarations.indexOf(repository!)).toBeLessThan(declarations.indexOf(server!));
    expect(declarations.indexOf(controllerRepository!)).toBeLessThan(
      declarations.indexOf(controller!)
    );
    expect(new Set(declarations.map((declaration) => declaration.id)).size).toBe(
      declarations.length
    );
  });

  it('accepts NACK singleton customization only as concrete build-time configuration', async () => {
    const customized = makeNatsBootstrap({
      controller: {
        version: '0.34.1',
        values: { resources: { requests: { cpu: '100m' } } },
      },
    });
    const declarations = await customized
      .factory('direct', { namespace: 'typekro-system', waitForReady: false })
      .toAlchemyResources({
        name: 'application-events',
        namespace: 'application-system',
        namespaceOwnership: 'external',
      });
    const controller = declarations.find(
      (declaration) => declaration.props.resourceId === 'nackHelmRelease'
    );

    expect(controller?.props.resource.spec?.chart?.spec?.version).toBe('0.34.1');
    expect(controller?.props.resource.spec?.values).toMatchObject({
      jetstream: { enabled: true, controlLoop: true },
      namespaced: false,
      resources: { requests: { cpu: '100m' } },
    });
    expect(() =>
      customized.factory('direct', { namespace: 'typekro-system' }).toYaml({
        name: 'application-events',
        namespace: 'application-system',
        nackVersion: '0.34.0',
      })
    ).toThrow(/nackVersion is now build-time singleton configuration/);
    expect(() =>
      customized.factory('direct', { namespace: 'typekro-system' }).toYaml({
        name: 'application-events',
        namespace: 'application-system',
        nackValues: { resources: { requests: { cpu: '200m' } } },
      })
    ).toThrow(/nackValues is now build-time singleton configuration/);
    expect(() =>
      customized.factory('direct', { namespace: 'typekro-system' }).toYaml({
        name: 'application-events',
        namespace: 'application-system',
        nackVersion: '0.34.1',
        nackValues: { resources: { requests: { cpu: '100m' } } },
      })
    ).not.toThrow();
  });

  it('materializes custom values in direct Alchemy without leaking the merge marker', async () => {
    const customValues = {
      config: {
        jetstream: {
          fileStore: {
            pvc: {
              storageClassName: 'local-path',
            },
          },
        },
      },
    };
    const declarations = await natsBootstrap
      .factory('direct', { namespace: 'typekro-system', waitForReady: false })
      .toAlchemyResources({
        name: 'application-events',
        namespace: 'application-system',
        namespaceOwnership: 'external',
        values: customValues,
      });
    const server = declarations.find(
      (declaration) => declaration.props.resourceId === 'natsHelmRelease'
    );
    expect(server).toBeDefined();

    const declaredValues = (
      server!.props.resource as {
        spec?: { values?: Record<string, unknown> };
      }
    ).spec?.values;
    const rehydratedValues = (
      resourceFromDirectArtifactRecordForTest({
        ...server!.props,
        dependencies: [{ resourceId: 'natsHelmRepository' } as never],
      }) as {
        spec?: { values?: Record<string, unknown> };
      }
    ).spec?.values;

    for (const values of [declaredValues, rehydratedValues]) {
      expect(values).toMatchObject({
        config: {
          jetstream: {
            enabled: true,
            fileStore: {
              pvc: {
                enabled: true,
                size: '10Gi',
                storageClassName: 'local-path',
              },
            },
          },
        },
      });
      expect(JSON.stringify(values)).not.toContain('__typekroValuesMerge');
    }
    expect(customValues).toEqual({
      config: {
        jetstream: {
          fileStore: {
            pvc: {
              storageClassName: 'local-path',
            },
          },
        },
      },
    });

    const directYaml = natsBootstrap
      .factory('direct', { namespace: 'typekro-system', waitForReady: false })
      .toYaml({
        name: 'application-events',
        namespace: 'application-system',
        namespaceOwnership: 'external',
        values: customValues,
      });
    expect(directYaml).not.toContain('__typekroValuesMerge');
    expect(directYaml).toMatch(
      /jetstream:\s*\n\s+enabled: true\s*\n\s+fileStore:\s*\n\s+enabled: true\s*\n\s+pvc:\s*\n\s+enabled: true\s*\n\s+size: 10Gi\s*\n\s+storageClassName: local-path/
    );

    const kroYaml = natsBootstrap
      .factory('kro', { namespace: 'typekro-system', waitForReady: false })
      .toYaml();
    expect(kroYaml).not.toContain('__typekroValuesMerge');
    expect(kroYaml).toContain(
      'has(schema.spec.values) ? json.unmarshal(json.marshal(schema.spec.values)) : {}'
    );
    expect(kroYaml).toContain('.merge({');
  });

  it('rejects non-positive and fractional replica counts', () => {
    const factory = natsBootstrap.factory('direct', { namespace: 'typekro-system' });
    expect(() => factory.toYaml({ name: 'nats', replicas: 0 })).toThrow();
    expect(() => factory.toYaml({ name: 'nats', replicas: -1 })).toThrow();
    expect(() => factory.toYaml({ name: 'nats', replicas: 1.5 })).toThrow();
  });

  it('requires current observedGeneration before Stream or Consumer readiness', () => {
    const stream = jetStreamStream({ name: 'events', subjects: ['events.>'] });
    const consumer = jetStreamConsumer({ name: 'processor', streamName: 'EVENTS' });
    const stale = {
      metadata: { generation: 2 },
      status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True' as const }] },
    };
    const current = {
      metadata: { generation: 2 },
      status: { observedGeneration: 2, conditions: [{ type: 'Ready', status: 'True' as const }] },
    };
    expect(stream.readinessEvaluator?.(stale)).toMatchObject({
      ready: false,
      reason: 'ObservedGenerationStale',
    });
    expect(consumer.readinessEvaluator?.(stale)).toMatchObject({
      ready: false,
      reason: 'ObservedGenerationStale',
    });
    expect(stream.readinessEvaluator?.(current)).toMatchObject({ ready: true });
    expect(consumer.readinessEvaluator?.(current)).toMatchObject({ ready: true });
  });

  it('emits NACK Stream and Consumer resources in direct and KRO modes', () => {
    const spec = { name: 'APPLIK8S_EVENTS', namespace: 'apps' };
    const direct = streamResources.factory('direct', { namespace: 'apps' }).toYaml(spec);
    const kro = streamResources.factory('kro', { namespace: 'typekro-system' }).toYaml();

    expect(documents(direct).map(kind)).toEqual(['Stream', 'Consumer']);
    expect(direct).toContain('apiVersion: jetstream.nats.io/v1beta2');
    expect(direct).toContain('namespace: apps');
    expect(direct).toContain('duplicateWindow: 2m');
    expect(direct).toContain('ackPolicy: explicit');
    expect(direct).toContain('durableName: account-commands');
    expect(kro).toContain('kind: ResourceGraphDefinition');
    expect(kro).toContain('kind: Stream');
    expect(kro).toContain('kind: Consumer');
    expect(kro).toContain('namespace: ${schema.spec.namespace}');
  });
});
