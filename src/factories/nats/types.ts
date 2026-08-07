import { type } from 'arktype';
import type { TypeKroChartValue } from '../../core/types/common.js';

export const NatsBootstrapConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'namespaceOwnership?': '"owned" | "external"',
  'version?': 'string',
  /**
   * @deprecated Configure the shared controller through
   * `makeNatsBootstrap({ controller: { version } })`.
   */
  'nackVersion?': 'string',
  'repositoryName?': 'string',
  'repositoryNamespace?': 'string',
  'repositoryUrl?': 'string',
  'replicas?': 'number.integer >= 1',
  'storageSize?': 'string',
  'storageClassName?': 'string',
  'pvcRetentionPolicy?': '"retain" | "delete"',
  'values?': 'Record<string, unknown>',
  /**
   * @deprecated Configure the shared controller through
   * `makeNatsBootstrap({ controller: { values } })`.
   */
  'nackValues?': 'Record<string, unknown>',
});

export type NatsBootstrapConfig = Omit<
  typeof NatsBootstrapConfigSchema.infer,
  'values' | 'nackValues'
> & {
  values?: TypeKroChartValue<Record<string, unknown>>;
  nackValues?: TypeKroChartValue<Record<string, unknown>>;
};

/**
 * Build-time ownership settings for the shared NACK controller.
 *
 * These cannot be runtime fields because every NATS consumer must resolve to
 * one identical singleton owner. A schema-proxy value could make the shared
 * controller's identity depend on an individual consumer instance.
 */
export interface NatsBootstrapBuildOptions {
  readonly controller?: {
    /** Stable TypeKro singleton identity shared by every consumer. */
    readonly singletonId?: string;
    readonly name?: string;
    readonly namespace?: string;
    readonly namespaceOwnership?: 'owned' | 'external';
    readonly version?: string;
    readonly repositoryName?: string;
    readonly repositoryUrl?: string;
    readonly values?: Record<string, unknown>;
  };
}

export const NatsBootstrapStatusSchema = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  serverVersion: 'string',
  controllerVersion: 'string',
  endpoint: 'string',
});

export type NatsBootstrapStatus = typeof NatsBootstrapStatusSchema.infer;

/**
 * Configuration for the cluster-wide NACK controller owner.
 *
 * NACK's non-namespaced chart resources include fixed-name ClusterRoles and
 * ClusterRoleBindings. TypeKro therefore owns exactly one controller and lets
 * every NATS installation reference it through `singleton(...)`.
 */
export const NackControllerBootstrapConfigSchema = type({
  name: 'string',
  namespace: 'string',
  'namespaceOwnership?': '"owned" | "external"',
  'version?': 'string',
  'repositoryName?': 'string',
  'repositoryUrl?': 'string',
  'values?': 'Record<string, unknown>',
});

export type NackControllerBootstrapConfig = Omit<
  typeof NackControllerBootstrapConfigSchema.infer,
  'values'
> & {
  values?: TypeKroChartValue<Record<string, unknown>>;
};

export const NackControllerBootstrapStatusSchema = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  version: 'string',
});

export type NackControllerBootstrapStatus = typeof NackControllerBootstrapStatusSchema.infer;

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
