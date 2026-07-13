import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { Cel } from '../../../src/core/references/cel.js';
import { natsBootstrap } from '../../../src/factories/nats/compositions/nats-bootstrap.js';
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
  it('emits official NATS and NACK installations with persistent JetStream defaults', () => {
    const yaml = natsBootstrap.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'nats',
      namespace: 'nats-system',
      replicas: 3,
      storageSize: '20Gi',
    });
    const docs = documents(yaml);

    expect(docs.map(kind).filter((value) => value === 'HelmRelease')).toHaveLength(2);
    expect(docs.map(kind)).toContain('Namespace');
    expect(docs.map(kind)).toContain('HelmRepository');
    expect(yaml).toContain(`version: ${DEFAULT_NATS_VERSION}`);
    expect(yaml).toContain(`version: ${DEFAULT_NACK_VERSION}`);
    expect(yaml).toMatch(/jetstream:\s*\n\s+enabled: true/);
    expect(yaml).toMatch(/cluster:\s*\n\s+enabled: true\s*\n\s+replicas: 3/);
    expect(yaml).toContain('size: 20Gi');
    expect(yaml).toContain('url: nats://nats.nats-system.svc:4222');
    expect(yaml).toContain('fullnameOverride: nats');
    expect(yaml).toMatch(
      /persistentVolumeClaimRetentionPolicy:\s*\n\s+whenDeleted: Retain\s*\n\s+whenScaled: Retain/
    );

    const ephemeral = natsBootstrap.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'ephemeral-nats',
      namespace: 'nats-system',
      pvcRetentionPolicy: 'delete',
    });
    expect(ephemeral).toMatch(
      /persistentVolumeClaimRetentionPolicy:\s*\n\s+whenDeleted: Delete\s*\n\s+whenScaled: Retain/
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
    expect(customName).toContain('url: nats://application-events.nats-system.svc:4222');
  });

  it('serializes bootstrap in KRO mode and auto-relocates an owner instance out of its owned namespace', () => {
    const factory = natsBootstrap.factory('kro', { namespace: 'typekro-system' });
    const rgd = factory.toYaml();
    expect(rgd).toContain('kind: ResourceGraphDefinition');
    expect(rgd).toContain('kind: HelmRelease');
    expect(rgd).toContain('has(schema.spec.namespace) ? schema.spec.namespace');
    expect(rgd).toContain('(has(schema.spec.replicas) ? schema.spec.replicas : 1) > 1');
    expect(rgd).toContain('replicas: integer | minimum=1');
    expect(rgd).toContain('pvcRetentionPolicy: string | enum="delete,retain"');
    expect(rgd).toContain('namespaceOwnership: string | enum="external,owned"');
    expect(rgd).toContain('schema.spec.namespaceOwnership');
    expect(rgd).toContain(
      'includeWhen:\n        - ${!has(schema.spec.namespaceOwnership) || schema.spec.namespaceOwnership == "owned"}'
    );
    expect(rgd).toContain('schema.spec.pvcRetentionPolicy');
    expect(rgd).toContain('Delete');

    const minimal = factory.toYaml({ name: 'nats' });
    expect(minimal).toContain('kind: NatsBootstrap');
    expect(minimal).toContain('name: nats');
    expect(minimal).not.toContain('spec:\n  name: nats\n  namespace:');
    expect(rgd).toContain('string(schema.spec.name)');
    expect(rgd).toContain('.svc:4222');

    const clustered = factory.toYaml({ name: 'nats', replicas: 3 });
    expect(clustered).toContain('replicas: 3');

    // natsBootstrap creates and owns its workload Namespace, so the natural
    // same-namespace call is auto-relocated to the shared control-plane
    // namespace `typekro-system` rather than being rejected (regression fix for
    // the v0.25.0 ownership guard) — no flag required.
    const relocated = natsBootstrap.factory('kro', { namespace: 'nats-system' }).toYaml({
      name: 'nats',
      namespace: 'nats-system',
    });
    expect(relocated).toContain('kind: NatsBootstrap');
    expect(relocated).toContain('namespace: typekro-system');
    expect(relocated).toContain('typekro.io/kro-instance-namespace');

    // Guard intact: explicitly pinning the instance CR back into the owned
    // namespace still throws.
    expect(() =>
      natsBootstrap
        .factory('kro', { namespace: 'nats-system', instanceNamespace: 'nats-system' })
        .toYaml({ name: 'nats', namespace: 'nats-system' })
    ).toThrow('cannot also be an owned Namespace');

    // An externally-owned namespace is never owned, so it is never relocated
    // and never throws.
    expect(() =>
      natsBootstrap.factory('kro', { namespace: 'nats-system' }).toYaml({
        name: 'nats',
        namespace: 'nats-system',
        namespaceOwnership: 'external',
      })
    ).not.toThrow();
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
