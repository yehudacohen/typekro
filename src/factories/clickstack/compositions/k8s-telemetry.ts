/**
 * ClickStack Kubernetes Telemetry Composition.
 *
 * The documented ClickStack pattern for collecting cluster telemetry
 * (https://clickhouse.com/docs/use-cases/observability/clickstack/ingesting-data/kubernetes):
 * TWO instances of the STOCK `opentelemetry-collector` chart from
 * https://open-telemetry.github.io/opentelemetry-helm-charts —
 *
 * 1. A DAEMONSET instance on every node: presets `logsCollection`,
 *    `hostMetrics`, `kubernetesAttributes`, `kubeletMetrics` (+ the
 *    docs-recommended kubeletstats utilization metrics).
 * 2. A DEPLOYMENT instance (single replica): presets `kubernetesAttributes`,
 *    `kubernetesEvents`, `clusterMetrics`.
 *
 * Both export `otlphttp` to the ClickStack gateway collector (default: the
 * in-cluster `clickstack-otel-collector` Service on 4318 — prefer wiring
 * `stack.status.gateway.otlpHttpEndpoint` from the bootstrap's status
 * contract) authenticated with an `authorization: <HYPERDX_API_KEY>` header.
 * The key is delivered via a `secretKeyRef` env var and referenced through
 * OTel `${env:…}` config expansion, so the key value never lands in Helm
 * values.
 *
 * BUILD-TIME vs RUNTIME: per-instance raw chart values are BUILD-TIME options
 * on `makeClickstackK8sTelemetry(...)` (a free-form values tree cannot be
 * represented per-instance in a KRO schema without silently dropping it);
 * the runtime spec carries only proxy-safe values (name, namespace, version,
 * endpoint, apiKeySecret coordinates).
 *
 * This is deliberately NOT the clickstack chart — the gateway collector ships
 * with `clickstackBootstrap`; these are the per-cluster edge collectors.
 *
 * @example
 * ```typescript
 * const factory = clickstackK8sTelemetry.factory('kro', {
 *   namespace: 'clickstack-telemetry',
 * });
 *
 * await factory.deploy({
 *   name: 'clickstack-telemetry',
 *   apiKeySecret: { name: 'hyperdx-secret' },
 *   endpoint: stack.status.gateway.otlpHttpEndpoint,
 * });
 * ```
 */

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import { containsKubernetesRefs, isKubernetesRef } from '../../../utils/type-guards.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_OTEL_COLLECTOR_VERSION,
  DEFAULT_OTEL_REPO_NAME,
  DEFAULT_OTEL_REPO_URL,
  otelCollectorHelmRelease,
} from '../resources/helm.js';
import {
  type ClickStackK8sTelemetryBuildOptions,
  type ClickStackK8sTelemetryConfig,
  ClickStackK8sTelemetryConfigSchema,
  ClickStackK8sTelemetryStatusSchema,
} from '../types.js';
import {
  DEFAULT_CLICKSTACK_TELEMETRY_NAMESPACE,
  mapK8sTelemetryConfigToHelmValues,
} from '../utils/helm-values-mapper.js';
import { otelHelmRepositoryBootstrap } from './otel-helm-repository.js';

/**
 * Construct a k8s telemetry composition. Build-time options bake static raw
 * chart values per collector instance; everything per-instance stays in the
 * runtime spec.
 */
export function makeClickstackK8sTelemetry(options: ClickStackK8sTelemetryBuildOptions = {}) {
  // Build-time options must be CONCRETE (see makeClickstackBootstrap): per-instance values belong
  // in the runtime spec.
  if (containsKubernetesRefs(options)) {
    throw new Error(
      'makeClickstackK8sTelemetry: build-time options contain a schema/resource reference. ' +
        'Move per-instance values into the runtime spec instead.'
    );
  }
  return kubernetesComposition(
    {
      name: options.name ?? 'clickstack-k8s-telemetry',
      kind: options.kind ?? 'ClickStackK8sTelemetry',
      spec: ClickStackK8sTelemetryConfigSchema,
      status: ClickStackK8sTelemetryStatusSchema,
    },
    (spec: ClickStackK8sTelemetryConfig) => {
      const resolvedNamespace = isKubernetesRef(spec.namespace)
        ? Cel.default(spec.namespace, DEFAULT_CLICKSTACK_TELEMETRY_NAMESPACE)
        : (spec.namespace ?? DEFAULT_CLICKSTACK_TELEMETRY_NAMESPACE);
      const resolvedVersion = isKubernetesRef(spec.version)
        ? Cel.default(spec.version, DEFAULT_OTEL_COLLECTOR_VERSION)
        : (spec.version ?? DEFAULT_OTEL_COLLECTOR_VERSION);

      const { daemonset: daemonsetValues, deployment: deploymentValues } =
        mapK8sTelemetryConfigToHelmValues(spec, {
          ...(options.daemonset !== undefined && { daemonset: options.daemonset }),
          ...(options.deployment !== undefined && { deployment: options.deployment }),
        });

      const _telemetryNamespace = namespace({
        metadata: {
          name: resolvedNamespace,
          labels: {
            'app.kubernetes.io/name': 'clickstack-k8s-telemetry',
            'app.kubernetes.io/instance': spec.name,
            'app.kubernetes.io/managed-by': 'typekro',
          },
        },
        id: 'clickstackTelemetryNamespace',
      });

      // Shared cluster-level OTel chart repository singleton (ApplySet
      // ownership rationale documented on otelHelmRepositoryBootstrap).
      const _otelHelmRepository = singleton(otelHelmRepositoryBootstrap, {
        id: 'opentelemetry-helm-repository',
        spec: {
          name: DEFAULT_OTEL_REPO_NAME,
          namespace: DEFAULT_FLUX_NAMESPACE,
          url: DEFAULT_OTEL_REPO_URL,
        },
      });

      // Template-literal names work in both modes: concrete strings in direct
      // mode, marker tokens rewritten to CEL in KRO mode (searxng precedent).
      const _daemonsetRelease = otelCollectorHelmRelease({
        name: `${spec.name}-daemonset`,
        namespace: resolvedNamespace,
        version: resolvedVersion,
        values: daemonsetValues,
        id: 'clickstackTelemetryDaemonset',
      });

      const _deploymentRelease = otelCollectorHelmRelease({
        name: `${spec.name}-deployment`,
        namespace: resolvedNamespace,
        version: resolvedVersion,
        values: deploymentValues,
        id: 'clickstackTelemetryDeployment',
      });

      return {
        ready: Cel.expr<boolean>(
          'clickstackTelemetryDaemonset.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && ' +
            'clickstackTelemetryDeployment.status.conditions.exists(c, c.type == "Ready" && c.status == "True")'
        ),
        phase: Cel.expr<'Ready' | 'Installing'>(
          'clickstackTelemetryDaemonset.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && ' +
            'clickstackTelemetryDeployment.status.conditions.exists(c, c.type == "Ready" && c.status == "True") ' +
            '? "Ready" : "Installing"'
        ),
      };
    }
  );
}

/** Composition type for the k8s telemetry pair. */
export type ClickStackK8sTelemetryComposition = ReturnType<typeof makeClickstackK8sTelemetry>;

/**
 * The default k8s telemetry composition (no build-time value overrides).
 * Use `makeClickstackK8sTelemetry(...)` to bake per-instance raw chart values.
 */
export const clickstackK8sTelemetry = makeClickstackK8sTelemetry();
