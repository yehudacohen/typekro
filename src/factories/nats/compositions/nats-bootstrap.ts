import { mergeValuesExpression } from '../../../core/aspects/values-merge.js';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import {
  createBunCompatibleKubernetesObjectApi,
  getKubeConfig,
} from '../../../core/kubernetes/index.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton, stableSerialize } from '../../../core/singleton/singleton.js';
import type {
  DirectResourceFactory,
  KroResourceFactory,
  PublicFactoryOptions,
  ResourceFactoryDeployOptions,
} from '../../../core/types/deployment.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_NACK_REPOSITORY_NAME,
  DEFAULT_NACK_VERSION,
  DEFAULT_NATS_REPOSITORY_NAME,
  DEFAULT_NATS_REPOSITORY_URL,
  DEFAULT_NATS_VERSION,
  natsHelmRelease,
  natsHelmRepository,
} from '../resources/helm.js';
import {
  type NackControllerBootstrapConfigSchema,
  type NatsBootstrapBuildOptions,
  type NatsBootstrapConfig,
  NatsBootstrapConfigSchema,
  NatsBootstrapStatusSchema,
  type NatsHelmValues,
} from '../types.js';
import { nackControllerBootstrap } from './nack-controller-bootstrap.js';
import { retireLegacyNackController } from './nack-controller-migration.js';

const DEFAULT_NATS_NAMESPACE = 'nats-system';
const DEFAULT_NACK_NAMESPACE = 'typekro-nack-system';
type NatsBootstrapSchemaSpec = typeof NatsBootstrapConfigSchema.infer;
type NatsBootstrapSchemaStatus = typeof NatsBootstrapStatusSchema.infer;

/**
 * Build a NATS installation composition backed by one cluster-wide NACK owner.
 *
 * NACK ownership is deliberately build-time. Every consumer of the singleton
 * must agree on an identical concrete controller spec.
 */
export function makeNatsBootstrap(options: NatsBootstrapBuildOptions = {}) {
  const controllerSingletonId = options.controller?.singletonId ?? 'nack-controller';
  const controllerSpec: typeof NackControllerBootstrapConfigSchema.infer = {
    name: options.controller?.name ?? 'nack',
    namespace: options.controller?.namespace ?? DEFAULT_NACK_NAMESPACE,
    namespaceOwnership: options.controller?.namespaceOwnership ?? 'owned',
    version: options.controller?.version ?? DEFAULT_NACK_VERSION,
    repositoryName: options.controller?.repositoryName ?? DEFAULT_NACK_REPOSITORY_NAME,
    repositoryUrl: options.controller?.repositoryUrl ?? DEFAULT_NATS_REPOSITORY_URL,
    ...(options.controller?.values ? { values: options.controller.values } : {}),
  };

  const composition = kubernetesComposition(
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
        validateLegacyControllerConfig(spec, controllerSpec);
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
            // The official chart merges this object into the StatefulSet root,
            // so Kubernetes spec fields must remain nested below `spec`.
            // Emitting the retention policy directly below `merge` produces an
            // invalid top-level StatefulSet field that Flux cannot server-side
            // apply.
            spec: {
              persistentVolumeClaimRetentionPolicy: {
                whenDeleted: pvcWhenDeleted,
                whenScaled: 'Retain',
              },
            },
          },
        },
      };
      const serverValues = spec.values
        ? mergeValuesExpression(serverDefaults, spec.values)
        : serverDefaults;

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
      const controller = singleton(nackControllerBootstrap, {
        id: controllerSingletonId,
        spec: controllerSpec,
      });
      // The sourceRef values are Kubernetes identity, while these explicit
      // graph edges are lifecycle authority: repository before releases on
      // create, releases before repository on destroy.
      server.dependsOn(_repository);
      const serverStatus = helmReleaseConditionSummary(server);
      const ready = Cel.expr<boolean>(serverStatus.ready, ' && ', controller.status.ready);
      const failed = Cel.expr<boolean>(serverStatus.failed, ' || ', controller.status.failed);
      return {
        ready,
        failed,
        phase: Cel.expr<'Ready' | 'Installing' | 'Failed'>(
          failed,
          ' ? "Failed" : (',
          ready,
          ' ? "Ready" : "Installing")'
        ),
        serverVersion: spec.version ?? DEFAULT_NATS_VERSION,
        controllerVersion: controllerSpec.version ?? DEFAULT_NACK_VERSION,
        endpoint,
      };
    },
    {
      schemaFieldValidations: {
        nackVersion: `self == ${JSON.stringify(controllerSpec.version ?? DEFAULT_NACK_VERSION)}`,
        // Open-object fields have a structural schema type while CEL literals
        // are maps. Widen both operands before comparison so Kubernetes CEL
        // can validate the deprecated compatibility assertion.
        nackValues: `dyn(self) == dyn(${JSON.stringify(controllerSpec.values ?? {})})`,
      },
    }
  );

  const originalFactory = composition.factory.bind(composition);
  function natsBootstrapFactory(
    mode: 'kro',
    factoryOptions?: PublicFactoryOptions
  ): KroResourceFactory<NatsBootstrapSchemaSpec, NatsBootstrapSchemaStatus>;
  function natsBootstrapFactory(
    mode: 'direct',
    factoryOptions?: PublicFactoryOptions
  ): DirectResourceFactory<NatsBootstrapSchemaSpec, NatsBootstrapSchemaStatus>;
  function natsBootstrapFactory(
    mode: 'kro' | 'direct',
    factoryOptions?: PublicFactoryOptions
  ):
    | KroResourceFactory<NatsBootstrapSchemaSpec, NatsBootstrapSchemaStatus>
    | DirectResourceFactory<NatsBootstrapSchemaSpec, NatsBootstrapSchemaStatus> {
    if (mode === 'kro') {
      return originalFactory('kro', factoryOptions);
    }

    const factory = originalFactory('direct', factoryOptions);
    const originalDeploy = factory.deploy.bind(factory);
    factory.deploy = async (
      spec: NatsBootstrapSchemaSpec,
      deployOptions?: ResourceFactoryDeployOptions
    ) => {
      // Direct mode does not prune graph nodes removed by a library upgrade.
      // The singleton owner is synchronously made Ready by originalDeploy()
      // before this retirement runs, so the v0.33.5 controller is never
      // removed until its replacement can reconcile.
      const deployed = await originalDeploy(spec, deployOptions);
      const kubeConfig = factoryOptions?.kubeConfig ?? getKubeConfig();
      const abortSignals = [factoryOptions?.abortSignal, deployOptions?.abortSignal].filter(
        (signal): signal is AbortSignal => signal !== undefined
      );
      const abortSignal =
        abortSignals.length > 1
          ? AbortSignal.any(abortSignals)
          : abortSignals.length === 1
            ? abortSignals[0]
            : undefined;
      await retireLegacyNackController({
        namespace: spec.namespace ?? DEFAULT_NATS_NAMESPACE,
        instanceName: spec.name,
        kubernetesApi: createBunCompatibleKubernetesObjectApi(
          kubeConfig,
          factoryOptions?.httpTimeouts
        ),
        ...(factoryOptions?.timeout !== undefined ? { timeout: factoryOptions.timeout } : {}),
        ...(abortSignal ? { abortSignal } : {}),
      });
      return deployed;
    };
    return factory;
  }

  (composition as { factory: typeof composition.factory }).factory = natsBootstrapFactory;
  return composition;
}

/** Install an official NATS cluster backed by the shared NACK controller. */
export const natsBootstrap = makeNatsBootstrap();

/** Explicit lifecycle alias for shared platform ownership. */
export const natsInstallation = natsBootstrap;

function validateReplicaCount(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error('NATS replicas must be an integer greater than or equal to 1.');
  }
}

function validateLegacyControllerConfig(
  spec: NatsBootstrapConfig,
  controllerSpec: typeof NackControllerBootstrapConfigSchema.infer
): void {
  if (spec.nackVersion !== undefined && spec.nackVersion !== controllerSpec.version) {
    throw new Error(
      'nackVersion is now build-time singleton configuration. Move it to ' +
        'makeNatsBootstrap({ controller: { version } }).'
    );
  }
  if (
    spec.nackValues !== undefined &&
    stableSerialize(spec.nackValues) !== stableSerialize(controllerSpec.values ?? {})
  ) {
    throw new Error(
      'nackValues is now build-time singleton configuration. Move it to ' +
        'makeNatsBootstrap({ controller: { values } }).'
    );
  }
}
