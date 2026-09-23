/**
 * ClickHouse Pod Template Fingerprint
 *
 * WHY THIS MODULE EXISTS. When a CHI change both (a) touches configuration the
 * clickhouse-operator classifies as restart-requiring (`settings/*`,
 * `files/config.d/*.xml` — `configurationRestartPolicy` in the operator's
 * `config.yaml`) and (b) changes the pod template, the operator 0.27.x
 * reconciles the host in this order (`reconcileHostStatefulSet` in
 * `pkg/controller/chi/worker-reconciler-chi.go`, release-0.27.1):
 *
 * 1. push the new ConfigMaps;
 * 2. SOFTWARE-RESTART the running server (`SYSTEM SHUTDOWN`, the kubelet
 *    restarts the container) — under the OLD pod template, OLD probes included;
 * 3. wait up to the reconcile timeout (5 minutes) for it to become ready;
 * 4. only then roll the StatefulSet to the new pod template.
 *
 * Step 2 is skipped only when `hostRequiresStatefulSetRollout()` says the
 * rollout will restart the pod anyway, and that check compares ONE thing: each
 * container's `env`. Probe, resource, volume and affinity changes are
 * deliberately not compared (the upstream comment says so), so they take the
 * software-restart-first path.
 *
 * That ordering is what broke the upgrade that introduced the startup probe
 * (#230/#232, #238): the system-log settings changed (restart-requiring), the
 * probes changed (template), the operator restarted the server under the old
 * ~90s liveness probe, the server — which needed that very probe change to
 * boot — was killed mid-load on every attempt, and ClickHouse was down until
 * the operator's 5-minute wait expired and it fell back to scaling the pod
 * down and rolling the StatefulSet.
 *
 * THE FIX. Stamp a digest of the pod template into the container's env
 * ({@link CLICKHOUSE_POD_TEMPLATE_HASH_ENV}). Any change to the template
 * changes the env, so the operator skips the in-place restart and restarts the
 * pod exactly once, through the StatefulSet rollout, with the new template AND
 * the new configuration. A configuration-only change leaves the digest alone
 * and keeps the operator's cheaper in-place restart.
 *
 * WHAT IT COVERS. The digest is over each pod template as TypeKro renders it
 * at construction time, so a zone template's digest moves only when that
 * template does (adding a zone leaves the existing zones' digests alone).
 * Schema references (e.g. KRO-mode `podResources` or `version`) are hashed as
 * their reference, not their runtime value, so a
 * change that only alters a runtime value does not change the digest. Image
 * changes are handled by the operator itself (`isImageChangeRequested` defers
 * the restart to the rollout); the remaining runtime-valued fields are
 * resources, which are harmless to run for one extra restart.
 *
 * OPERATOR VERSIONS. `hostRequiresStatefulSetRollout()` is identical across
 * 0.27.0–0.27.3. Before 0.27 the operator had no such check and always
 * restarted in place first, so there the digest has no effect (and no harm).
 *
 * @module
 */

import { canonicalDigest } from '../../../core/planning/canonical.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';

/**
 * Env var on the `clickhouse` container that carries the pod template digest.
 * Its VALUE is meaningless to ClickHouse; its CHANGE is what makes the operator
 * roll the StatefulSet instead of restarting the server in place first.
 */
export const CLICKHOUSE_POD_TEMPLATE_HASH_ENV = 'TYPEKRO_POD_TEMPLATE_HASH';

/**
 * Replace schema references and CEL expressions with stable string markers so
 * the template can be canonically hashed. A reference is identified by what it
 * points at, not by the value it will resolve to.
 */
function withStableReferences(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (isKubernetesRef(value)) return `$ref:${value.resourceId}:${value.fieldPath}`;
  if (isCelExpression(value)) return `$cel:${value.expression}`;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) {
    throw new Error('clickHousePodTemplateHash: the pod template contains a circular reference');
  }
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => (item === undefined ? null : withStableReferences(item, seen)));
  } else {
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = Reflect.get(value, key);
      if (child !== undefined) record[key] = withStableReferences(child, seen);
    }
    result = record;
  }
  seen.delete(value);
  return result;
}

/**
 * Digest of one rendered ClickHouse pod template spec (a zone template
 * includes its affinity). Short on purpose: it only has to change when the
 * template does.
 */
export function clickHousePodTemplateHash(input: Record<string, unknown>): string {
  return canonicalDigest(withStableReferences(input)).slice(0, 16);
}
