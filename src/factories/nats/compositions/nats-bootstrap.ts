import { mergeValuesExpression } from '../../../core/aspects/values-merge.js';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
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
    const targetNamespace = spec.namespace ?? DEFAULT_NATS_NAMESPACE;
    const repositoryName = spec.repositoryName ?? DEFAULT_NATS_REPOSITORY_NAME;
    const repositoryNamespace = spec.repositoryNamespace ?? targetNamespace;
    const repositoryUrl = spec.repositoryUrl ?? DEFAULT_NATS_REPOSITORY_URL;
    const replicas = spec.replicas ?? 1;
    const endpoint = `nats://${spec.name}.${targetNamespace}.svc:4222`;
    const serverDefaults: NatsHelmValues = {
      // Keep the chart Service identity identical to the public endpoint for
      // every release name. Without this, Helm appends "-nats" whenever the
      // release name itself does not contain the chart name.
      fullnameOverride: spec.name,
      config: {
        cluster: { enabled: replicas > 1, replicas },
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
    });
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
      ready: Cel.expr<boolean>(
        server.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") && ',
        controller.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      failed: Cel.expr<boolean>(
        server.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "False") || ',
        controller.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "False")'
      ),
      phase: Cel.expr<'Ready' | 'Installing'>(
        server.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") && ',
        controller.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")',
        ' ? "Ready" : "Installing"'
      ),
      serverVersion: spec.version ?? DEFAULT_NATS_VERSION,
      controllerVersion: spec.nackVersion ?? DEFAULT_NACK_VERSION,
      endpoint,
    };
  }
);

/** Explicit lifecycle alias for shared platform ownership. */
export const natsInstallation = natsBootstrap;
