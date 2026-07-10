import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { TypeKroError } from '../../../core/errors.js';
import { Cel } from '../../../core/references/cel.js';
import type {
  DirectResourceFactory,
  KroResourceFactory,
  PublicFactoryOptions,
} from '../../../core/types/deployment.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_VALKEY_REPO_NAME,
  DEFAULT_VALKEY_REPO_URL,
  DEFAULT_VALKEY_VERSION,
  valkeyHelmRepository,
  valkeyHelmRelease,
} from '../resources/helm.js';
import {
  type ValkeyBootstrapConfig,
  ValkeyBootstrapConfigSchema,
  ValkeyBootstrapStatusSchema,
} from '../types.js';
import { mapValkeyConfigToHelmValues } from '../utils/helm-values-mapper.js';

/**
 * Strips the '-chart' suffix from the verified built-in Hyperspike version.
 * Runtime schema references cannot be normalized synchronously, so explicit
 * version overrides are preserved as supplied.
 */
function stripChartSuffix(version: string): string {
  return version.replace(/-chart$/, '');
}

const DEFAULT_VALKEY_OPERATOR_NAMESPACE = 'valkey-operator-system';

/**
 * A KRO owner must not own the Namespace containing its own custom-resource
 * instance. Deleting the instance asks KRO to delete every graph child; if
 * that includes the instance namespace, Kubernetes can terminate the
 * namespace before the instance finalizer clears and deadlock deletion.
 */
function validateKroControlPlaneBoundary(
  spec: ValkeyBootstrapConfig,
  instanceNamespace: string
): void {
  const operatorNamespace = spec.namespace ?? DEFAULT_VALKEY_OPERATOR_NAMESPACE;
  if (operatorNamespace === instanceNamespace) {
    throw new TypeKroError(
      `valkeyBootstrap KRO instances must use a control-plane namespace separate from the owned operator namespace '${operatorNamespace}'. ` +
        `Create the factory with another namespace (for example, { namespace: 'typekro-system' }) while keeping spec.namespace as '${operatorNamespace}'.`,
      'UNSAFE_KRO_NAMESPACE_OWNERSHIP',
      { instanceNamespace, operatorNamespace, mode: 'kro' }
    );
  }
}

function withKroNamespaceValidation(
  factory: KroResourceFactory<ValkeyBootstrapConfig, typeof ValkeyBootstrapStatusSchema.infer>
): KroResourceFactory<ValkeyBootstrapConfig, typeof ValkeyBootstrapStatusSchema.infer> {
  return new Proxy(factory, {
    get(target, prop, receiver) {
      if (prop === 'deploy') {
        return (
          spec: ValkeyBootstrapConfig,
          opts?: Parameters<
            KroResourceFactory<
              ValkeyBootstrapConfig,
              typeof ValkeyBootstrapStatusSchema.infer
            >['deploy']
          >[1]
        ) => {
          validateKroControlPlaneBoundary(spec, target.namespace);
          return target.deploy(spec, opts);
        };
      }

      if (prop === 'toYaml') {
        return (spec?: ValkeyBootstrapConfig) => {
          if (spec !== undefined) {
            validateKroControlPlaneBoundary(spec, target.namespace);
            return target.toYaml(spec);
          }
          return target.toYaml();
        };
      }

      if (prop === 'toAlchemyResources') {
        return (
          spec: ValkeyBootstrapConfig,
          opts?: Parameters<
            KroResourceFactory<
              ValkeyBootstrapConfig,
              typeof ValkeyBootstrapStatusSchema.infer
            >['toAlchemyResources']
          >[1]
        ) => {
          validateKroControlPlaneBoundary(spec, target.namespace);
          return target.toAlchemyResources(spec, opts);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Hyperspike Valkey Operator Bootstrap Composition
 *
 * Deploys the Hyperspike Valkey operator via HelmRepository and HelmRelease.
 * The operator manages Valkey clusters as Kubernetes-native resources.
 *
 * This composition:
 * 1. Creates the target namespace
 * 2. Creates a HelmRepository pointing to the Hyperspike OCI registry
 * 3. Creates a HelmRelease that installs the operator
 *
 * After the operator is running, use the `valkey()` factory to create
 * Valkey cluster resources.
 *
 * @example
 * ```typescript
 * // 'kro' = KRO mode (continuous reconciliation via ResourceGraphDefinition)
 * // 'direct' = Direct mode (immediate apply, no KRO controller needed)
 * const factory = valkeyBootstrap.factory('kro', {
 *   namespace: 'typekro-system', // KRO instance/control-plane namespace
 *   waitForReady: true,
 * });
 *
 * await factory.deploy({
 *   name: 'valkey-operator',
 *   namespace: 'valkey-operator-system',
 * });
 * ```
 */
export const valkeyBootstrap = kubernetesComposition(
  {
    name: 'valkey-bootstrap',
    kind: 'ValkeyBootstrap',
    spec: ValkeyBootstrapConfigSchema,
    status: ValkeyBootstrapStatusSchema,
  },
  (spec: ValkeyBootstrapConfig) => {
    const resolvedNamespace = spec.namespace ?? DEFAULT_VALKEY_OPERATOR_NAMESPACE;
    const resolvedVersion = spec.version ?? DEFAULT_VALKEY_VERSION;
    // A schema-proxy string cannot be normalized synchronously. Keep the
    // upstream chart tag for overrides; normalize the verified built-in default.
    const reportedVersion = spec.version ? spec.version : stripChartSuffix(DEFAULT_VALKEY_VERSION);
    const repositoryName = spec.repositoryName ?? DEFAULT_VALKEY_REPO_NAME;
    const repositoryNamespace = spec.repositoryNamespace ?? resolvedNamespace;
    const repositoryUrl = spec.repositoryUrl ?? DEFAULT_VALKEY_REPO_URL;

    const helmValues = mapValkeyConfigToHelmValues({
      ...(spec.customValues !== undefined && { customValues: spec.customValues }),
      ...(spec.values !== undefined && { values: spec.values }),
    });

    // Resources are _-prefixed because they're registered via side effects in the
    // kubernetesComposition callback — the composition captures them automatically.
    // They're referenced in the status return via their `id`.
    const _valkeyNamespace = namespace({
      metadata: {
        name: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'valkey-operator',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/version': reportedVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'valkeyNamespace',
    });

    const _helmRepository = valkeyHelmRepository({
      name: repositoryName,
      namespace: repositoryNamespace,
      url: repositoryUrl,
      id: 'valkeyHelmRepository',
    });

    const _helmRelease = valkeyHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
      repositoryName,
      repositoryNamespace,
      repositoryUrl,
      id: 'valkeyHelmRelease',
    });

    // Status derived from HelmRelease conditions.
    return {
      ready: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      // Phase cannot distinguish Failed from Installing due to a CEL evaluator
      // limitation (#48). Use the `failed` field for failure detection.
      phase: Cel.expr<'Ready' | 'Installing'>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
      ),
      // Separate failed boolean — workaround for the nested CEL ternary limitation.
      // True when the Ready condition is explicitly False (not just absent/Unknown).
      failed: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "False")'
      ),
      // Static version from deploy-time config, not derived from live HelmRelease
      // status. If the operator is upgraded out-of-band (e.g. Flux automation),
      // this value will not reflect the running version.
      version: reportedVersion,
    };
  }
);

const baseFactory = valkeyBootstrap.factory.bind(valkeyBootstrap);

function valkeyBootstrapFactory(
  mode: 'kro',
  options?: PublicFactoryOptions
): KroResourceFactory<ValkeyBootstrapConfig, typeof ValkeyBootstrapStatusSchema.infer>;
function valkeyBootstrapFactory(
  mode: 'direct',
  options?: PublicFactoryOptions
): DirectResourceFactory<ValkeyBootstrapConfig, typeof ValkeyBootstrapStatusSchema.infer>;
function valkeyBootstrapFactory(mode: 'kro' | 'direct', options?: PublicFactoryOptions) {
  const factory = baseFactory(mode, options);
  return mode === 'kro'
    ? withKroNamespaceValidation(
        factory as KroResourceFactory<
          ValkeyBootstrapConfig,
          typeof ValkeyBootstrapStatusSchema.infer
        >
      )
    : factory;
}

Object.defineProperty(valkeyBootstrap, 'factory', {
  value: valkeyBootstrapFactory,
  writable: true,
  enumerable: true,
  configurable: true,
});

/** Explicit lifecycle name for code that wants to emphasize ownership. */
export const valkeyOperatorInstallation = valkeyBootstrap;
