import { mergeValuesExpression } from '../../../core/aspects/values-merge.js';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_NACK_VERSION,
  DEFAULT_NACK_REPOSITORY_NAME,
  DEFAULT_NATS_REPOSITORY_URL,
  natsHelmRelease,
  natsHelmRepository,
} from '../resources/helm.js';
import {
  type NackControllerBootstrapConfig,
  NackControllerBootstrapConfigSchema,
  NackControllerBootstrapStatusSchema,
  type NatsHelmValues,
} from '../types.js';

/**
 * Own the single cluster-wide NACK controller used by NATS installations.
 *
 * The official chart's non-namespaced mode creates fixed-name ClusterRoles and
 * ClusterRoleBindings. Installing the chart once per NATS cluster makes those
 * resources cross-instance shared state: deleting one release can remove RBAC
 * from another controller. This composition gives that state one explicit
 * lifecycle owner. `natsBootstrap` consumes it through `singleton(...)`.
 *
 * The controller intentionally omits a default NATS URL, selecting NACK's
 * `-crd-connect` mode. Each Stream, Consumer, or Account then identifies its
 * own NATS system through its typed connection fields, allowing one controller
 * to reconcile multiple NATS systems safely.
 */
export const nackControllerBootstrap = kubernetesComposition(
  {
    name: 'nack-controller-bootstrap',
    kind: 'NackControllerBootstrap',
    spec: NackControllerBootstrapConfigSchema,
    status: NackControllerBootstrapStatusSchema,
  },
  (spec: NackControllerBootstrapConfig) => {
    const graphMode = isKubernetesRef(spec.name);
    const ownsNamespace = graphMode
      ? Cel.expr<boolean>(
          '!has(schema.spec.namespaceOwnership) || schema.spec.namespaceOwnership == "owned"'
        )
      : spec.namespaceOwnership !== 'external';
    const version = spec.version ?? DEFAULT_NACK_VERSION;
    const repositoryName = spec.repositoryName ?? DEFAULT_NACK_REPOSITORY_NAME;
    const repositoryUrl = spec.repositoryUrl ?? DEFAULT_NATS_REPOSITORY_URL;
    const defaults: NatsHelmValues = {
      jetstream: {
        enabled: true,
        controlLoop: true,
      },
      namespaced: false,
    };
    const values = spec.values ? mergeValuesExpression(defaults, spec.values) : defaults;

    namespace({
      id: 'nackNamespace',
      metadata: {
        name: spec.namespace,
        labels: {
          'app.kubernetes.io/name': 'nack',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
    }).withIncludeWhen(ownsNamespace);

    const repository = natsHelmRepository({
      id: 'nackHelmRepository',
      name: repositoryName,
      namespace: spec.namespace,
      url: repositoryUrl,
    });
    const release = natsHelmRelease({
      id: 'nackHelmRelease',
      name: spec.name,
      namespace: spec.namespace,
      chart: 'nack',
      version,
      values,
      repositoryName,
      repositoryNamespace: spec.namespace,
      repositoryUrl,
    });
    release.dependsOn(repository);

    return {
      ...helmReleaseConditionSummary(release),
      version,
    };
  }
);

/** Explicit lifecycle alias for the cluster-wide NACK owner. */
export const nackControllerInstallation = nackControllerBootstrap;
