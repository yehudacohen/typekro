import { type } from 'arktype';
import type { TypeKroChartValue } from '../../core/types/common.js';

export const NatsBootstrapConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'nackVersion?': 'string',
  'repositoryName?': 'string',
  'repositoryNamespace?': 'string',
  'repositoryUrl?': 'string',
  'replicas?': 'number.integer >= 1',
  'storageSize?': 'string',
  'storageClassName?': 'string',
  'values?': 'Record<string, unknown>',
  'nackValues?': 'Record<string, unknown>',
});

export type NatsBootstrapConfig = Omit<
  typeof NatsBootstrapConfigSchema.infer,
  'values' | 'nackValues'
> & {
  values?: TypeKroChartValue<Record<string, unknown>>;
  nackValues?: TypeKroChartValue<Record<string, unknown>>;
};

export const NatsBootstrapStatusSchema = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Ready" | "Installing"',
  serverVersion: 'string',
  controllerVersion: 'string',
  endpoint: 'string',
});

export type NatsBootstrapStatus = typeof NatsBootstrapStatusSchema.infer;

export const JetStreamStreamConfigSchema = type({
  name: 'string',
  'streamName?': 'string',
  'namespace?': 'string',
  'id?': 'string',
  subjects: 'string[]',
  'description?': 'string',
  'retention?': '"limits" | "interest" | "workqueue"',
  'storage?': '"file" | "memory"',
  'replicas?': 'number.integer >= 1',
  'maxConsumers?': 'number.integer >= -1',
  'maxMsgs?': 'number.integer >= -1',
  'maxBytes?': 'number.integer >= -1',
  'maxAge?': 'string',
  'maxMsgSize?': 'number.integer >= -1',
  'duplicateWindow?': 'string',
  'discard?': '"old" | "new"',
  'preventDelete?': 'boolean',
  'preventUpdate?': 'boolean',
  'servers?': 'string[]',
  'creds?': 'string',
  'nkey?': 'string',
  'jsDomain?': 'string',
});

export type JetStreamStreamConfig = typeof JetStreamStreamConfigSchema.infer;

export const JetStreamConsumerConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'id?': 'string',
  streamName: 'string',
  'durableName?': 'string',
  'ackPolicy?': '"none" | "all" | "explicit"',
  'ackWait?': 'string',
  'maxDeliver?': 'number.integer >= -1',
  'filterSubject?': 'string',
  'filterSubjects?': 'string[]',
  'deliverPolicy?': '"all" | "last" | "new" | "lastPerSubject"',
  'replayPolicy?': '"instant" | "original"',
  'maxAckPending?': 'number.integer >= -1',
  'replicas?': 'number.integer >= 1',
  'servers?': 'string[]',
  'creds?': 'string',
  'nkey?': 'string',
  'jsDomain?': 'string',
  'preventDelete?': 'boolean',
  'preventUpdate?': 'boolean',
});

export type JetStreamConsumerConfig = typeof JetStreamConsumerConfigSchema.infer;

export interface JetStreamCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface JetStreamResourceStatus {
  observedGeneration?: number;
  conditions?: JetStreamCondition[];
}

export type NatsHelmValues = TypeKroChartValue<Record<string, unknown>>;
