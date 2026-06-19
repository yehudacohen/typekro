import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { externalRef } from '../../../core/references/external-refs.js';
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

/** HelmRelease Ready-condition CEL, by the release resource id. */
const HELM_RELEASE_READY_CEL =
  'dagsterHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")';

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

    // Readiness must reflect a REAL workload, not just Flux's HelmRelease Ready
    // condition. We observe the chart's webserver Deployment via externalRef and
    // fold its readiness into `ready`.
    //
    // SCOPE NOTE — webserver only, on purpose. The daemon and bundled postgres
    // are deployed only conditionally (daemon.enabled, external-vs-bundled pg),
    // and that condition is PER-INSTANCE. But:
    //   1. KRO status CEL cannot reference schema.spec (probed live, kro 0.9.2),
    //      so a daemon/postgres readiness term cannot be re-gated per instance.
    //   2. The KRO RGD is built once from a schema proxy and shared by every
    //      instance, so the build-time spec can't decide per-instance presence.
    //   3. A conditional `externalRef(...)` call is hoisted by the composition
    //      analyzer into a broken placeholder resource (kind: ExternalRef), so it
    //      can't be cleanly omitted either.
    // Requiring a daemon/postgres that a given instance disabled would make
    // `ready` hang forever. The webserver is the one workload the chart ALWAYS
    // creates for every instance, so observing it is both honest and hang-safe.
    // Daemon/postgres therefore stay on the HelmRelease signal (see components).
    const WEBSERVER_ID = 'dagsterWebserverDeployment';

    // Webserver Deployment name. We build this as ONE CEL expression that mirrors
    // the chart's `dagster.fullname` template exactly (incl. the `contains` rule)
    // rather than computing it from `spec.*` in JS: in KRO mode `spec.name` is a
    // proxy, so a JS template-literal (`${spec.name}-...`) leaks raw ref markers
    // and a JS-side trunc mangles the embedded template. CEL evaluates it at
    // instance time against the real release name. Verified live: release
    // `dagster` → `dagster-dagster-webserver`.
    //   fullname = fullnameOverride
    //            ? fullnameOverride
    //            : name.contains(chartName) ? name : name + "-" + chartName
    //   chartName = nameOverride ?? "dagster"
    //   webserver = fullname + "-dagster-webserver"
    // (No trunc(63): foundry release names are short; the fullname-derived name
    // stays well under the 63-char object-name cap.)
    const webserverName = webserverNameCel();

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

    // Unconditional externalRef (no `if` guard) so the analyzer emits a real
    // externalRef entry, not a placeholder stub. The webserver is always present.
    externalRef({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: webserverName as unknown as string, namespace: resolvedNamespace },
      id: WEBSERVER_ID,
    });

    const helmRepositoryReady = _dagsterHelmRepository.status.ready;
    const helmReleaseReady = Cel.expr<boolean>(
      _dagsterHelmRelease.status.conditions,
      '.exists(c, c.type == "Ready" && c.status == "True")'
    );

    // Null-safe webserver readiness. KRO CEL supports has(); guarding the status
    // path makes the term evaluate to `false` (never an eval error) before the
    // observed Deployment exists during install.
    const webserverReady = Cel.expr<boolean>(deploymentReadyCel(WEBSERVER_ID));

    // `ready` = HelmRelease Ready AND the webserver Deployment is up. Both terms
    // reference resources always present for every instance, so this never hangs.
    const ready = Cel.expr<boolean>(
      `(${HELM_RELEASE_READY_CEL}) && (${deploymentReadyCel(WEBSERVER_ID)})`
    );

    return {
      ready,
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
      components: {
        helmRepository: helmRepositoryReady,
        helmRelease: helmReleaseReady,
        // Honest: reflects the actual webserver Deployment.
        webserver: webserverReady,
        // daemon/postgres/userDeployments stay on the HelmRelease signal — see
        // the SCOPE NOTE above for why per-instance-conditional workloads can't
        // be observed hang-safely in a shared KRO RGD.
        // TODO: per-code-location user deployments could be observed too (one
        // Deployment per `userDeployments.deployments[*].name`); their names are
        // user-driven, so left as the HelmRelease signal for now.
        daemon: helmReleaseReady,
        userDeployments: helmReleaseReady,
      },
    };
  }
);

/** Null-safe Deployment readiness CEL referencing an observed resource by id. */
function deploymentReadyCel(id: string): string {
  return `has(${id}.status) && has(${id}.status.availableReplicas) && ${id}.status.availableReplicas >= 1`;
}

/**
 * Webserver Deployment name as a CEL expression mirroring the chart's
 * `dagster.fullname` template. Built as a CEL string (not JS interpolation of
 * the schema proxy) so it resolves correctly at KRO instance time.
 */
function webserverNameCel() {
  const chartName = 'has(schema.spec.nameOverride) ? schema.spec.nameOverride : "dagster"';
  const fullname =
    'has(schema.spec.fullnameOverride) ? schema.spec.fullnameOverride : ' +
    `(schema.spec.name.contains(${chartName}) ? schema.spec.name : ` +
    `schema.spec.name + "-" + (${chartName}))`;
  return Cel.expr<string>(`(${fullname}) + "-dagster-webserver"`);
}

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
