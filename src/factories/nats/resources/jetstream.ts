import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type {
  JetStreamConsumerConfig,
  JetStreamResourceStatus,
  JetStreamStreamConfig,
} from '../types.js';

function jetStreamReadiness(resource: unknown): ResourceStatus {
  const status = (resource as { status?: JetStreamResourceStatus } | undefined)?.status;
  const ready = status?.conditions?.find((condition) => condition.type === 'Ready');
  return {
    ready: ready?.status === 'True',
    reason: ready?.reason ?? (status ? 'ReadyConditionMissing' : 'StatusMissing'),
    message: ready?.message ?? 'NACK has not reported the resource ready.',
  };
}

/** Create a NACK-managed JetStream Stream. */
export function jetStreamStream(
  config: Composable<JetStreamStreamConfig>
): Enhanced<JetStreamStreamConfig, JetStreamResourceStatus> {
  return createResource(
    {
      apiVersion: 'jetstream.nats.io/v1beta2',
      kind: 'Stream',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
        labels: { 'app.kubernetes.io/managed-by': 'typekro' },
      },
      spec: {
        name: config.streamName ?? config.name,
        subjects: config.subjects,
        ...(config.description && { description: config.description }),
        ...(config.retention && { retention: config.retention }),
        ...(config.storage && { storage: config.storage }),
        ...(config.replicas && { replicas: config.replicas }),
        ...(config.maxConsumers !== undefined && { maxConsumers: config.maxConsumers }),
        ...(config.maxMsgs !== undefined && { maxMsgs: config.maxMsgs }),
        ...(config.maxBytes !== undefined && { maxBytes: config.maxBytes }),
        ...(config.maxAge && { maxAge: config.maxAge }),
        ...(config.maxMsgSize !== undefined && { maxMsgSize: config.maxMsgSize }),
        ...(config.duplicateWindow && { duplicateWindow: config.duplicateWindow }),
        ...(config.discard && { discard: config.discard }),
        ...(config.preventDelete !== undefined && { preventDelete: config.preventDelete }),
        ...(config.preventUpdate !== undefined && { preventUpdate: config.preventUpdate }),
        ...(config.servers && { servers: config.servers }),
        ...(config.creds && { creds: config.creds }),
        ...(config.nkey && { nkey: config.nkey }),
        ...(config.jsDomain && { jsDomain: config.jsDomain }),
      },
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced', dnsAddressable: false }
  ).withReadinessEvaluator(jetStreamReadiness) as Enhanced<
    JetStreamStreamConfig,
    JetStreamResourceStatus
  >;
}

/** Create a NACK-managed durable or ephemeral JetStream Consumer. */
export function jetStreamConsumer(
  config: Composable<JetStreamConsumerConfig>
): Enhanced<JetStreamConsumerConfig, JetStreamResourceStatus> {
  return createResource(
    {
      apiVersion: 'jetstream.nats.io/v1beta2',
      kind: 'Consumer',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
        labels: { 'app.kubernetes.io/managed-by': 'typekro' },
      },
      spec: {
        durableName: config.durableName ?? config.name,
        streamName: config.streamName,
        ...(config.ackPolicy && { ackPolicy: config.ackPolicy }),
        ...(config.ackWait && { ackWait: config.ackWait }),
        ...(config.maxDeliver !== undefined && { maxDeliver: config.maxDeliver }),
        ...(config.filterSubject && { filterSubject: config.filterSubject }),
        ...(config.filterSubjects && { filterSubjects: config.filterSubjects }),
        ...(config.deliverPolicy && { deliverPolicy: config.deliverPolicy }),
        ...(config.replayPolicy && { replayPolicy: config.replayPolicy }),
        ...(config.maxAckPending !== undefined && { maxAckPending: config.maxAckPending }),
        ...(config.replicas && { replicas: config.replicas }),
        ...(config.servers && { servers: config.servers }),
        ...(config.creds && { creds: config.creds }),
        ...(config.nkey && { nkey: config.nkey }),
        ...(config.jsDomain && { jsDomain: config.jsDomain }),
        ...(config.preventDelete !== undefined && { preventDelete: config.preventDelete }),
        ...(config.preventUpdate !== undefined && { preventUpdate: config.preventUpdate }),
      },
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced', dnsAddressable: false }
  ).withReadinessEvaluator(jetStreamReadiness) as Enhanced<
    JetStreamConsumerConfig,
    JetStreamResourceStatus
  >;
}
