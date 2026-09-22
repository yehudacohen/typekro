/**
 * ClickHouse Server Container Probes
 *
 * WHY THIS MODULE EXISTS. `clickHouseInstallation()` builds the CHI pod
 * template itself, and used to set NO probes at all — so the container
 * inherited the Altinity operator's defaults, which are wrong for a database:
 *
 * - The operator's default LIVENESS probe is `GET /ping` on the `http` port
 *   with `initialDelaySeconds: 60`, `periodSeconds: 3`, `failureThreshold: 10`
 *   and no `timeoutSeconds` (so Kubernetes' 1s default). It therefore SIGKILLs
 *   a container that has not answered by ~90 seconds
 *   (`pkg/model/chi/creator/probe.go`, release-0.27.1).
 * - There is NO startup probe. The operator can render one, but
 *   `createDefaultStartupProbe` for a CHI is literally
 *   `createDefaultLivenessProbe` again, and the option that would install it
 *   (`reconcile.host.wait.probes.startup`) ships as `no`
 *   (`config/config.yaml`).
 *
 * ClickHouse's startup time is a function of how much data it has, so a server
 * that has been up long enough will eventually take longer than 90 seconds to
 * load. Liveness then kills it mid-boot, the next attempt starts over, and the
 * cluster is in a crash loop that only gets worse — triggered by TIME, not by
 * load or by any configuration change. See
 * https://github.com/yehudacohen/typekro/issues/230.
 *
 * A startup probe is the exact instrument for this: liveness answers "is this
 * process wedged", startup answers "is this process still coming up", and
 * Kubernetes suspends liveness and readiness entirely until the startup probe
 * first succeeds. So the defaults below give the server a GENEROUS boot budget
 * and then a SHORT liveness leash — it may take as long as it needs to start,
 * and is still killed promptly if it wedges after starting.
 *
 * The operator only fills in a probe the pod template left `nil`
 * (`stsEnsureAppContainerProbesSpecified` in
 * `pkg/model/common/creator/stateful-set-application.go`), so every probe set
 * here survives reconcile, and any probe set to `false` here falls back to the
 * operator's own default.
 *
 * @module
 */

import type { ClickHouseProbeOptions, ClickHouseProbeSettings } from '../types.js';
import type { Loosen } from './loosen.js';

/**
 * Probe options as they arrive from a `Composable<...>` config: every field
 * loosened to `| undefined`, because the runtime check below — not the
 * compile-time shape — is this function's contract.
 */
export type ClickHouseProbeInput = Loosen<ClickHouseProbeOptions>;

/** One probe's overrides, loosened the same way. */
export type ClickHouseProbeSettingsInput = Loosen<ClickHouseProbeSettings>;

/**
 * The container port NAME the probes target.
 *
 * The operator names the HTTP container port `http`
 * (`ChDefaultHTTPPortName`, pkg/apis/clickhouse.altinity.com/v1/type_host.go)
 * and ensures it exists on the app container, and its own probes address it by
 * that name. Using the name rather than the number 8123 keeps these probes
 * correct if the HTTP port is ever remapped.
 */
export const CLICKHOUSE_PROBE_PORT_NAME = 'http';

/** The HTTP path every ClickHouse probe uses; answers `Ok.` once serving. */
export const CLICKHOUSE_PROBE_PATH = '/ping';

/**
 * Default STARTUP probe: 90 failures x 10s = a FIFTEEN MINUTE boot budget.
 *
 * The incident that produced #230 had a server taking 2m48s to load and being
 * killed at ~90s. Fifteen minutes is deliberately far beyond that: the cost of
 * being too generous is a wedged pod taking longer to be noticed (and the
 * operator surfaces the host as not-ready throughout), while the cost of being
 * too tight is the unrecoverable crash loop this exists to prevent. The 10s
 * period keeps the probe cheap on a server that is busy loading, and the 5s
 * timeout replaces Kubernetes' 1s default, which is optimistic against an HTTP
 * handler on a mid-load server.
 */
export const DEFAULT_CLICKHOUSE_STARTUP_PROBE: Required<ClickHouseProbeSettings> = {
  initialDelaySeconds: 10,
  periodSeconds: 10,
  timeoutSeconds: 5,
  failureThreshold: 90,
  successThreshold: 1,
};

/**
 * Default LIVENESS probe: 6 failures x 10s = killed ~60s after it wedges.
 *
 * NO `initialDelaySeconds`: the startup probe already gates liveness entirely
 * (Kubernetes does not run liveness until startup first succeeds), so an
 * initial delay here would only add dead time AFTER the server is known to be
 * up. Once started, this is a real leash — a minute of an unresponsive `/ping`
 * restarts the container — which is what liveness is for.
 */
export const DEFAULT_CLICKHOUSE_LIVENESS_PROBE: Required<
  Omit<ClickHouseProbeSettings, 'initialDelaySeconds' | 'successThreshold'>
> = {
  periodSeconds: 10,
  timeoutSeconds: 5,
  failureThreshold: 6,
};

/**
 * Default READINESS probe: takes the host out of the Service after ~30s of
 * failed `/ping`, without restarting it.
 *
 * Set explicitly (rather than left to the operator) only to raise
 * `timeoutSeconds` off Kubernetes' 1s default, for the same reason as above.
 * The operator waits on readiness during its own host-launch procedure
 * (`reconcile.host.wait.probes.readiness: yes`), which continues to work.
 */
export const DEFAULT_CLICKHOUSE_READINESS_PROBE: Required<
  Omit<ClickHouseProbeSettings, 'initialDelaySeconds'>
> = {
  periodSeconds: 10,
  timeoutSeconds: 5,
  failureThreshold: 3,
  successThreshold: 1,
};

/** A rendered Kubernetes probe (the CRD's pod spec is an open structure). */
export interface ClickHouseRenderedProbe extends ClickHouseProbeSettings {
  readonly httpGet: { readonly path: string; readonly port: string };
}

/** The probe block of the ClickHouse server container, with defaults applied. */
export interface ResolvedClickHouseProbes {
  readonly startupProbe?: ClickHouseRenderedProbe;
  readonly livenessProbe?: ClickHouseRenderedProbe;
  readonly readinessProbe?: ClickHouseRenderedProbe;
}

const PROBE_NUMERIC_FIELDS = [
  'initialDelaySeconds',
  'periodSeconds',
  'timeoutSeconds',
  'failureThreshold',
  'successThreshold',
] as const;

function assertProbeSettings(
  factoryName: string,
  probeName: string,
  settings: ClickHouseProbeSettingsInput
): void {
  for (const field of PROBE_NUMERIC_FIELDS) {
    const value = settings[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `${factoryName}: probes.${probeName}.${field} must be a positive integer (got ` +
          `${String(value)}). Set \`probes.${probeName}: false\` to omit the probe and fall ` +
          `back to the clickhouse-operator's default.`
      );
    }
  }
}

function renderProbe(
  factoryName: string,
  probeName: string,
  defaults: ClickHouseProbeSettings,
  override: ClickHouseProbeSettingsInput | false | undefined
): ClickHouseRenderedProbe | undefined {
  if (override === false) return undefined;
  if (override !== undefined) assertProbeSettings(factoryName, probeName, override);
  // An EXPLICIT field-by-field merge rather than an object spread: the
  // override arrives from a `Composable<...>` config, where every optional
  // field is `T | undefined`, so spreading it would write `periodSeconds:
  // undefined` over the default and emit a probe with a null field.
  const merged: ClickHouseProbeSettings = { ...defaults };
  for (const field of PROBE_NUMERIC_FIELDS) {
    const value = override?.[field];
    if (value !== undefined) merged[field] = value;
  }
  return {
    httpGet: { path: CLICKHOUSE_PROBE_PATH, port: CLICKHOUSE_PROBE_PORT_NAME },
    ...merged,
  };
}

/**
 * Apply the probe defaults for a ClickHouse server container.
 *
 * @param factoryName - Caller name, quoted into validation errors
 * @param options - Caller's probe overrides, if any
 */
export function resolveClickHouseProbes(
  factoryName: string,
  options: ClickHouseProbeInput | undefined
): ResolvedClickHouseProbes {
  const startupProbe = renderProbe(
    factoryName,
    'startup',
    DEFAULT_CLICKHOUSE_STARTUP_PROBE,
    options?.startup
  );
  const livenessProbe = renderProbe(
    factoryName,
    'liveness',
    DEFAULT_CLICKHOUSE_LIVENESS_PROBE,
    options?.liveness
  );
  const readinessProbe = renderProbe(
    factoryName,
    'readiness',
    DEFAULT_CLICKHOUSE_READINESS_PROBE,
    options?.readiness
  );

  return {
    ...(startupProbe !== undefined && { startupProbe }),
    ...(livenessProbe !== undefined && { livenessProbe }),
    ...(readinessProbe !== undefined && { readinessProbe }),
  };
}
