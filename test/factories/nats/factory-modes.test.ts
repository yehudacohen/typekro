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

    const customName = natsBootstrap.factory('direct', { namespace: 'typekro-system' }).toYaml({
      name: 'application-events',
      namespace: 'nats-system',
    });
    expect(customName).toContain('fullnameOverride: application-events');
    expect(customName).toContain('url: nats://application-events.nats-system.svc:4222');
  });

  it('serializes bootstrap in KRO mode and rejects an owner instance in its owned namespace', () => {
    const factory = natsBootstrap.factory('kro', { namespace: 'typekro-system' });
    expect(factory.toYaml()).toContain('kind: ResourceGraphDefinition');
    expect(factory.toYaml()).toContain('kind: HelmRelease');
    expect(() =>
      natsBootstrap.factory('kro', { namespace: 'nats-system' }).toYaml({
        name: 'nats',
        namespace: 'nats-system',
      })
    ).toThrow('cannot also be an owned Namespace');
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
