import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import type { TypeKroValueTreeObject } from '../../../core/types/common.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_DAGSTER_REPO_NAME,
  DEFAULT_DAGSTER_REPO_URL,
  DEFAULT_DAGSTER_VERSION,
  dagsterHelmRelease,
} from '../resources/helm.js';
import {
  type DagsterBootstrapConfig,
  DagsterBootstrapConfigSchema,
  DagsterBootstrapStatusSchema,
} from '../types.js';
import { mapDagsterConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { dagsterHelmRepositoryBootstrap } from './dagster-helm-repository.js';

type DagsterBootstrapSchemaConfig = typeof DagsterBootstrapConfigSchema.infer;

/**
 * Conservative default liveness probe for the Dagster daemon.
 *
 * When the daemon loses its DB connection it can hang ("too many retries for DB
 * connection") WITHOUT the container exiting, so k8s never restarts it (seen in
 * production after a node reschedule). The chart ships no daemon liveness probe,
 * so we add the dagster-canonical exec check. Thresholds are deliberately loose
 * to avoid flapping during a slow startup or transient DB blip.
 */
const DEFAULT_DAEMON_LIVENESS_PROBE: TypeKroValueTreeObject = {
  exec: { command: ['dagster-daemon', 'liveness-check'] },
  initialDelaySeconds: 120,
  periodSeconds: 60,
  timeoutSeconds: 10,
  failureThreshold: 5,
};

/**
 * The default liveness probe as a CEL map literal (cel-go / KRO syntax) for the
 * KRO-mode fallback expression. Kept in sync with DEFAULT_DAEMON_LIVENESS_PROBE.
 */
const DEFAULT_DAEMON_LIVENESS_PROBE_CEL =
  '{"exec": {"command": ["dagster-daemon", "liveness-check"]}, ' +
  '"initialDelaySeconds": 120, "periodSeconds": 60, "timeoutSeconds": 10, "failureThreshold": 5}';

/**
 * High-level Dagster bootstrap composition.
 *
 * Creates the target Namespace, official Dagster HelmRepository, and Dagster
 * HelmRelease. Status is derived only from owned Flux Helm resources.
 */
export const dagsterBootstrap = kubernetesComposition(
  {
    name: 'dagster-bootstrap',
    kind: 'DagsterBootstrap',
    spec: DagsterBootstrapConfigSchema,
    status: DagsterBootstrapStatusSchema,
  },
  (spec) => {
    const resolvedNamespace = spec.namespace || 'dagster';
    const resolvedVersion = spec.version || DEFAULT_DAGSTER_VERSION;
    const helmValues = buildHelmValues(spec);

    // Readiness is the Flux HelmRelease Ready condition. The HelmRelease does not set
    // `disableWait`, so helm-controller waits for the release's workloads (webserver, daemon,
    // bundled postgres) to become ready before it reports Ready — i.e. `helmReleaseReady` is
    // already workload-aware, and the consuming layer gates its converge on this status.
    //
    // We deliberately do NOT observe the individual Deployments via externalRef. KRO's externalRef
    // is name-keyed (no label selector), and the chart's per-workload names are a fragile function
    // of `.Release.Name` + per-component `nameOverride`s (settable via raw `values`); reconstructing
    // them in CEL risks pinning `ready` to false forever on a name mismatch — for no signal beyond
    // the wait-gated HelmRelease. Per-instance daemon/postgres health (which a shared, schema-proxy
    // RGD can't conditionalize anyway) is covered post-deploy by the deploying layer's readiness gate.
    const _dagsterNamespace = namespace({
      metadata: {
        name: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'dagster',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/version': resolvedVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'dagsterNamespace',
    });

    // The official Dagster chart repository is one cluster-level Flux source shared
    // by every Dagster instance, so deploy it once via singleton(...) with a fixed
    // identity. Inlining it would make each instance's KRO ApplySet try to own the
    // HelmRepository exclusively, breaking a second instance (dev + prod) with an
    // ApplySet reassignment error. Every instance's HelmRelease references the same
    // shared repository by the official `sourceRef` defaults.
    const _dagsterHelmRepository = singleton(dagsterHelmRepositoryBootstrap, {
      id: 'dagster-helm-repository',
      spec: {
        name: DEFAULT_DAGSTER_REPO_NAME,
        namespace: DEFAULT_FLUX_NAMESPACE,
        url: DEFAULT_DAGSTER_REPO_URL,
      },
    });

    const _dagsterHelmRelease = dagsterHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
      id: 'dagsterHelmRelease',
    });

    const helmRepositoryReady = _dagsterHelmRepository.status.ready;
    const helmReleaseReady = Cel.expr<boolean>(
      _dagsterHelmRelease.status.conditions,
      '.exists(c, c.type == "Ready" && c.status == "True")'
    );

    return {
      ready: helmReleaseReady,
      phase: Cel.expr<'Ready' | 'Installing' | 'Failed'>(
        'dagsterHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "False") ' +
          '? "Failed" : dagsterHelmRelease.status.conditions.exists(c, c.type == "Ready" && ' +
          'c.status == "True") ? "Ready" : "Installing"'
      ),
      failed: Cel.expr<boolean>(
        _dagsterHelmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "False")'
      ),
      version: resolvedVersion,
      // Component readiness reflects the wait-gated HelmRelease (a Ready release means its
      // workloads are ready). Per-workload observation was removed — see the readiness note above.
      components: {
        helmRepository: helmRepositoryReady,
        helmRelease: helmReleaseReady,
        webserver: helmReleaseReady,
        daemon: helmReleaseReady,
        userDeployments: helmReleaseReady,
      },
    };
  }
);

function buildHelmValues(spec: DagsterBootstrapSchemaConfig) {
  return mapDagsterConfigToHelmValues(buildMapperConfig(spec));
}

function buildMapperConfig(spec: DagsterBootstrapSchemaConfig): DagsterBootstrapConfig {
  return Object.assign(
    { name: spec.name },
    spec.namespace !== undefined && { namespace: spec.namespace },
    spec.version !== undefined && { version: spec.version },
    spec.serviceAccountName !== undefined && { serviceAccountName: spec.serviceAccountName },
    spec.nameOverride !== undefined && { nameOverride: spec.nameOverride },
    spec.fullnameOverride !== undefined && { fullnameOverride: spec.fullnameOverride },
    spec.rbacEnabled !== undefined && { rbacEnabled: spec.rbacEnabled },
    spec.imagePullSecrets !== undefined && { imagePullSecrets: spec.imagePullSecrets },
    spec.webserver !== undefined && { webserver: spec.webserver },
    { daemon: resolveDaemonConfig(spec.daemon) },
    spec.userDeployments !== undefined && { userDeployments: spec.userDeployments },
    spec.postgresql !== undefined && { postgresql: spec.postgresql },
    spec.runLauncher !== undefined && { runLauncher: spec.runLauncher },
    spec.scheduler !== undefined && { scheduler: spec.scheduler },
    spec.computeLogManager !== undefined && { computeLogManager: spec.computeLogManager },
    spec.ingress !== undefined && { ingress: spec.ingress },
    spec.flower !== undefined && { flower: spec.flower },
    spec.rabbitmq !== undefined && { rabbitmq: spec.rabbitmq },
    spec.redis !== undefined && { redis: spec.redis },
    spec.global !== undefined && { global: spec.global },
    spec.values !== undefined && { values: spec.values }
  ) as DagsterBootstrapConfig;
}

/**
 * Apply the default daemon liveness probe when the daemon is enabled and the
 * user supplied none. A user-supplied `daemon.livenessProbe` always wins, and
 * the default is never applied when the daemon is disabled.
 *
 * Two modes:
 *  - Direct mode (concrete spec): `daemon.livenessProbe` is a real value, so we
 *    inject the default object only when it is genuinely absent (undefined).
 *  - KRO mode (schema proxy): `daemon` / `daemon.livenessProbe` are KubernetesRefs
 *    that are never `undefined` at build time and resolve per instance. We can't
 *    branch in JS, so we emit a CEL fallback into the (schema-ref-allowed) chart
 *    values: `has(schema.spec.daemon.livenessProbe) ? <user> : <default>`. The
 *    default is a CEL map literal that cel-go (KRO) evaluates at instance time.
 */
function resolveDaemonConfig(
  daemon: DagsterBootstrapSchemaConfig['daemon']
): DagsterBootstrapConfig['daemon'] {
  // Daemon explicitly disabled (concrete false) → never inject a probe.
  if (daemon?.enabled === false) return daemon as DagsterBootstrapConfig['daemon'];

  const probe: unknown = daemon?.livenessProbe;

  // KRO mode: probe field is a schema proxy. Emit a CEL fallback so a user probe
  // wins per instance and the default applies otherwise.
  if (isKubernetesRef(probe) || isKubernetesRef(daemon)) {
    return {
      ...((daemon ?? {}) as object),
      livenessProbe: Cel.expr<TypeKroValueTreeObject>(
        `has(schema.spec.daemon) && has(schema.spec.daemon.livenessProbe) ? ` +
          `schema.spec.daemon.livenessProbe : ${DEFAULT_DAEMON_LIVENESS_PROBE_CEL}`
      ) as unknown as TypeKroValueTreeObject,
    } as DagsterBootstrapConfig['daemon'];
  }

  // Direct mode: concrete value present → user wins; absent → inject default.
  if (probe !== undefined) return daemon as DagsterBootstrapConfig['daemon'];

  return {
    ...(daemon ?? {}),
    livenessProbe: DEFAULT_DAEMON_LIVENESS_PROBE,
  } as DagsterBootstrapConfig['daemon'];
}
