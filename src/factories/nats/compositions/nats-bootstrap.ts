import { mergeValuesExpression } from '../../../core/aspects/values-merge.js';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_NACK_VERSION,
  DEFAULT_NATS_REPOSITORY_NAME,
  DEFAULT_NATS_REPOSITORY_URL,
  DEFAULT_NATS_VERSION,
  natsHelmRelease,
  natsHelmRepository,
} from '../resources/helm.js';
import {
  type NatsBootstrapConfig,
  NatsBootstrapConfigSchema,
  NatsBootstrapStatusSchema,
  type NatsHelmValues,
} from '../types.js';

const DEFAULT_NATS_NAMESPACE = 'nats-system';

/** Install an official NATS cluster with JetStream and the NACK controller. */
export const natsBootstrap = kubernetesComposition(
  {
    name: 'nats-bootstrap',
    kind: 'NatsBootstrap',
    spec: NatsBootstrapConfigSchema,
    status: NatsBootstrapStatusSchema,
  },
  (spec: NatsBootstrapConfig) => {
    const graphMode = isKubernetesRef(spec.name);
    const targetNamespace = graphMode
      ? Cel.expr<string>('has(schema.spec.namespace) ? schema.spec.namespace : "nats-system"')
      : (spec.namespace ?? DEFAULT_NATS_NAMESPACE);
    const ownsTargetNamespace = graphMode
      ? Cel.expr<boolean>(
          '!has(schema.spec.namespaceOwnership) || schema.spec.namespaceOwnership == "owned"'
        )
      : spec.namespaceOwnership !== 'external';
    const repositoryName = spec.repositoryName ?? DEFAULT_NATS_REPOSITORY_NAME;
    const repositoryNamespace = spec.repositoryNamespace ?? targetNamespace;
    const repositoryUrl = spec.repositoryUrl ?? DEFAULT_NATS_REPOSITORY_URL;
    if (!graphMode) {
      validateReplicaCount(spec.replicas);
    }
    const replicas = graphMode
      ? Cel.expr<number>('has(schema.spec.replicas) ? schema.spec.replicas : 1')
      : (spec.replicas ?? 1);
    const clusteringEnabled = graphMode ? Cel.expr<boolean>(replicas, ' > 1') : replicas > 1;
    const pvcWhenDeleted = graphMode
      ? Cel.expr<'Delete' | 'Retain'>(
          'has(schema.spec.pvcRetentionPolicy) && schema.spec.pvcRetentionPolicy == "delete" ? "Delete" : "Retain"'
        )
      : spec.pvcRetentionPolicy === 'delete'
        ? 'Delete'
        : 'Retain';
    const endpoint = graphMode
      ? Cel.expr<string>(
          '"nats://" + string(schema.spec.name) + "." + string(has(schema.spec.namespace) ? schema.spec.namespace : "nats-system") + ".svc:4222"'
        )
      : `nats://${spec.name}.${targetNamespace}.svc:4222`;
    const serverDefaults: NatsHelmValues = {
      // Keep the chart Service identity identical to the public endpoint for
      // every release name. Without this, Helm appends "-nats" whenever the
      // release name itself does not contain the chart name.
      fullnameOverride: spec.name,
      config: {
        cluster: { enabled: clusteringEnabled, replicas },
        jetstream: {
          enabled: true,
          fileStore: {
            enabled: true,
            pvc: {
              enabled: true,
              size: spec.storageSize ?? '10Gi',
              ...(spec.storageClassName && { storageClassName: spec.storageClassName }),
            },
          },
        },
      },
      natsBox: { enabled: true },
      statefulSet: {
        merge: {
          persistentVolumeClaimRetentionPolicy: {
            whenDeleted: pvcWhenDeleted,
            whenScaled: 'Retain',
          },
        },
      },
    };
    const nackDefaults: NatsHelmValues = {
      jetstream: { enabled: true, nats: { url: endpoint }, controlLoop: true },
      namespaced: false,
    };
    const serverValues = spec.values
      ? mergeValuesExpression(serverDefaults, spec.values)
      : serverDefaults;
    const nackValues = spec.nackValues
      ? mergeValuesExpression(nackDefaults, spec.nackValues)
      : nackDefaults;

    const _namespace = namespace({
      id: 'natsNamespace',
      metadata: {
        name: targetNamespace,
        labels: {
          'app.kubernetes.io/name': 'nats',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
    }).withIncludeWhen(ownsTargetNamespace);
    const _repository = natsHelmRepository({
      id: 'natsHelmRepository',
      name: repositoryName,
      namespace: repositoryNamespace,
      url: repositoryUrl,
    });
    const server = natsHelmRelease({
      id: 'natsHelmRelease',
      name: spec.name,
      namespace: targetNamespace,
      chart: 'nats',
      version: spec.version ?? DEFAULT_NATS_VERSION,
      values: serverValues,
      repositoryName,
      repositoryNamespace,
      repositoryUrl,
    });
    const controller = natsHelmRelease({
      id: 'nackHelmRelease',
      name: 'nack',
      namespace: targetNamespace,
      chart: 'nack',
      version: spec.nackVersion ?? DEFAULT_NACK_VERSION,
      values: nackValues,
      repositoryName,
      repositoryNamespace,
      repositoryUrl,
    });
    return {
      ...helmReleaseConditionSummary(server, controller),
      serverVersion: spec.version ?? DEFAULT_NATS_VERSION,
      controllerVersion: spec.nackVersion ?? DEFAULT_NACK_VERSION,
      endpoint,
    };
  }
);

/** Explicit lifecycle alias for shared platform ownership. */
export const natsInstallation = natsBootstrap;

function validateReplicaCount(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error('NATS replicas must be an integer greater than or equal to 1.');
  }
}
