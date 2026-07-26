import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import { createResource } from '../../shared.js';
import type {
  JetStreamConsumerConfig,
  JetStreamResourceStatus,
  JetStreamStreamConfig,
} from '../types.js';

function jetStreamReadiness(resource: unknown): ResourceStatus {
  const typed = resource as
    | { metadata?: { generation?: number }; status?: JetStreamResourceStatus }
    | undefined;
  const status = typed?.status;
  const ready = status?.conditions?.find((condition) => condition.type === 'Ready');
  const generation = typed?.metadata?.generation;
  const generationCurrent = generation !== undefined && status?.observedGeneration === generation;
  return {
    ready: generationCurrent && ready?.status === 'True',
    reason: !status
      ? 'StatusMissing'
      : !generationCurrent
        ? 'ObservedGenerationStale'
        : (ready?.reason ?? 'ReadyConditionMissing'),
    message: !generationCurrent
      ? `NACK observed generation ${status?.observedGeneration ?? 'none'}; expected ${generation ?? 'none'}.`
      : (ready?.message ?? 'NACK has not reported the resource ready.'),
  };
}

registerPortableReadinessEvaluator(
  'typekro.readiness.nats.jetstream',
  '1',
  jetStreamReadiness
);

/** Create a NACK-managed JetStream Stream. */
export function jetStreamStream(
  config: Composable<JetStreamStreamConfig>
): Enhanced<JetStreamStreamConfig, JetStreamResourceStatus> {
  validateOptionalInteger('Stream replicas', config.replicas, 1);
  validateOptionalInteger('Stream maxConsumers', config.maxConsumers, -1);
  validateOptionalInteger('Stream maxMsgs', config.maxMsgs, -1);
  validateOptionalInteger('Stream maxBytes', config.maxBytes, -1);
  validateOptionalInteger('Stream maxMsgSize', config.maxMsgSize, -1);
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

/**
 * Create a NACK-managed durable JetStream Consumer.
 *
 * `durableName` defaults to the Kubernetes resource `name`; this factory does
 * not expose ephemeral consumers because NACK continuously reconciles the
 * declared Consumer resource.
 */
export function jetStreamConsumer(
  config: Composable<JetStreamConsumerConfig>
): Enhanced<JetStreamConsumerConfig, JetStreamResourceStatus> {
  validateOptionalInteger('Consumer maxDeliver', config.maxDeliver, -1);
  validateOptionalInteger('Consumer maxAckPending', config.maxAckPending, -1);
  validateOptionalInteger('Consumer replicas', config.replicas, 1);
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

function validateOptionalInteger(label: string, value: unknown, minimum: number): void {
  if (typeof value === 'number' && (!Number.isInteger(value) || value < minimum)) {
    throw new Error(`${label} must be an integer greater than or equal to ${minimum}.`);
  }
}
