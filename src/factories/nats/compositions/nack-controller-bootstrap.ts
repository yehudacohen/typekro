import { mergeValuesExpression } from '../../../core/aspects/values-merge.js';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_NACK_REPOSITORY_NAME,
  DEFAULT_NACK_VERSION,
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

const NACK_VALUES_VALIDATION =
  '(!has(self.jetstream) || (' +
  '(!has(self.jetstream.nats) || size(self.jetstream.nats) == 0) && ' +
  '(!has(self.jetstream.tls) || size(self.jetstream.tls) == 0) && ' +
  '(!has(self.jetstream.additionalArgs) || self.jetstream.additionalArgs.all(arg, ' +
  '!(arg == "-s" || arg.startsWith("-s=") || arg == "--server" || ' +
  'arg.startsWith("--server=") || arg == "--namespace" || ' +
  'arg.startsWith("--namespace=") || arg == "--read-only" || ' +
  'arg.startsWith("--read-only="))))) && !has(self.rbacRules)';

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
    if (!graphMode) {
      validateNackControllerValues(spec.values);
    }
    const controllerName = graphMode
      ? Cel.expr<string>('"typekro-" + string(schema.spec.name) + "-controller"')
      : `typekro-${spec.name}-controller`;
    const protectedValues: NatsHelmValues = {
      jetstream: {
        enabled: true,
        controlLoop: true,
      },
      namespaced: false,
      // The v0.33.5 per-installation chart used the chart default
      // `jetstream-controller`. The TypeKro prefix makes this identity
      // disjoint for every legal controller name, including `jetstream`, so
      // the singleton can become Ready before the legacy release is retired
      // without asking Helm to steal another release's ClusterRole/Binding.
      nameOverride: spec.name,
      namespaceOverride: spec.namespace,
      serviceAccountName: controllerName,
      useLegacyNames: false,
      readOnly: false,
      automountServiceAccountToken: true,
    };
    // User values are deliberately the base. The singleton invariants are the
    // final overlay so ordinary chart customization remains available without
    // being able to select a single NATS server, a namespace-only watch, or a
    // controller that never reconciles.
    const values = spec.values
      ? mergeValuesExpression(spec.values, protectedValues)
      : protectedValues;

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
  },
  {
    schemaFieldValidations: {
      values: NACK_VALUES_VALIDATION,
    },
  }
);

/** Explicit lifecycle alias for the cluster-wide NACK owner. */
export const nackControllerInstallation = nackControllerBootstrap;

function validateNackControllerValues(values: NackControllerBootstrapConfig['values']): void {
  if (!values || typeof values !== 'object' || isKubernetesRef(values)) return;
  const valuesRecord = values as Record<string, unknown>;
  if (Object.hasOwn(valuesRecord, 'rbacRules')) {
    throw new Error(
      'NACK singleton values.rbacRules cannot replace the controller permissions. Add separate ' +
        'RBAC resources for extra access.'
    );
  }
  const jetstream = valuesRecord.jetstream;
  if (!jetstream || typeof jetstream !== 'object' || Array.isArray(jetstream)) return;
  const nats = (jetstream as Record<string, unknown>).nats;
  if (
    nats &&
    typeof nats === 'object' &&
    !Array.isArray(nats) &&
    Object.keys(nats as Record<string, unknown>).length > 0
  ) {
    throw new Error(
      'NACK singleton values.jetstream.nats must be omitted. The shared controller uses ' +
        'CRD-connect mode; each JetStream resource declares its own NATS connection.'
    );
  }
  const tls = (jetstream as Record<string, unknown>).tls;
  if (
    tls &&
    typeof tls === 'object' &&
    !Array.isArray(tls) &&
    Object.keys(tls as Record<string, unknown>).length > 0
  ) {
    throw new Error(
      'NACK singleton values.jetstream.tls must be omitted. Shared-controller connection ' +
        'security belongs on each JetStream resource.'
    );
  }
  const additionalArgs = (jetstream as Record<string, unknown>).additionalArgs;
  if (
    Array.isArray(additionalArgs) &&
    additionalArgs.some(
      (argument) =>
        typeof argument === 'string' &&
        (argument === '-s' ||
          argument.startsWith('-s=') ||
          argument === '--server' ||
          argument.startsWith('--server=') ||
          argument === '--namespace' ||
          argument.startsWith('--namespace=') ||
          argument === '--read-only' ||
          argument.startsWith('--read-only='))
    )
  ) {
    throw new Error(
      'NACK singleton values.jetstream.additionalArgs cannot override server, namespace, or ' +
        'read-only routing invariants.'
    );
  }
}
