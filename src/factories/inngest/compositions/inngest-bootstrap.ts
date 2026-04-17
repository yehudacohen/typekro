import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_INNGEST_VERSION,
  inngestHelmRelease,
  inngestHelmRepository,
} from '../resources/helm.js';
import {
  type InngestBootstrapConfig,
  InngestBootstrapConfigSchema,
  InngestBootstrapStatusSchema,
} from '../types.js';
import { mapInngestConfigToHelmValues } from '../utils/helm-values-mapper.js';

/**
 * Inngest Bootstrap Composition
 *
 * Deploys Inngest via HelmRepository and HelmRelease. Inngest is a workflow
 * orchestration platform that requires PostgreSQL and Redis/Valkey.
 *
 * By default, the Helm chart bundles its own PostgreSQL and Redis. To use
 * external databases (e.g., CNPG + Valkey from TypeKro), disable the bundled
 * ones and pass connection URIs:
 *
 * @example
 * ```typescript
 * // 'kro' = KRO mode (continuous reconciliation)
 * // 'direct' = Direct mode (immediate apply)
 * const factory = inngestBootstrap.factory('kro', {
 *   namespace: 'inngest',
 *   waitForReady: true,
 * });
 *
 * await factory.deploy({
 *   name: 'inngest',
 *   namespace: 'inngest',
 *   inngest: {
 *     eventKey: 'your-event-key',
 *     signingKey: 'your-signing-key',
 *     // Use external CNPG PostgreSQL + Valkey
 *     postgres: { uri: 'postgresql://inngest:password@my-db-rw:5432/inngest' },
 *     redis: { uri: 'redis://my-cache:6379' },
 *   },
 *   postgresql: { enabled: false },  // Disable bundled PG
 *   redis: { enabled: false },       // Disable bundled Redis
 * });
 * ```
 */
export const inngestBootstrap = kubernetesComposition(
  {
    name: 'inngest-bootstrap',
    kind: 'InngestBootstrap',
    spec: InngestBootstrapConfigSchema,
    status: InngestBootstrapStatusSchema,
  },
  (spec: InngestBootstrapConfig) => {
    const resolvedNamespace = spec.namespace || 'inngest';
    const resolvedVersion = spec.version || DEFAULT_INNGEST_VERSION;
    const repositoryName = `${spec.name}-inngest-repo`;

    // Build the config for the mapper. Cannot spread the magic proxy directly —
    // nested proxy objects don't survive Object.assign. Access fields explicitly
    // and use Object.assign to skip undefined (exactOptionalPropertyTypes).
    const mapperConfig: InngestBootstrapConfig = Object.assign(
      { name: spec.name, inngest: spec.inngest },
      spec.replicaCount !== undefined && { replicaCount: spec.replicaCount },
      spec.resources && { resources: spec.resources },
      spec.postgresql && { postgresql: spec.postgresql },
      spec.redis && { redis: spec.redis },
      spec.ingress && { ingress: spec.ingress },
      spec.keda && { keda: spec.keda },
      spec.nodeSelector && { nodeSelector: spec.nodeSelector },
      spec.tolerations && { tolerations: spec.tolerations },
      spec.customValues && { customValues: spec.customValues },
    );
    const helmValues = mapInngestConfigToHelmValues(mapperConfig);

    // Resources are _-prefixed — registered via side effects in the
    // kubernetesComposition callback. The composition captures them automatically.
    const _inngestNamespace = namespace({
      metadata: {
        name: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'inngest',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/version': resolvedVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'inngestNamespace',
    });

    const _helmRepository = inngestHelmRepository({
      name: repositoryName,
      namespace: DEFAULT_FLUX_NAMESPACE,
      id: 'inngestHelmRepository',
    });

    const _helmRelease = inngestHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
      repositoryName: repositoryName,
      id: 'inngestHelmRelease',
    });

    return {
      ready: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      phase: Cel.expr<'Ready' | 'Installing'>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
      ),
      failed: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "False")'
      ),
      // Static — reflects deploy-time version, not runtime.
      version: resolvedVersion,
    };
  }
);
