import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { otelHelmRepository } from '../resources/helm.js';
import {
  OtelHelmRepositorySingletonSpecSchema,
  OtelHelmRepositorySingletonStatusSchema,
} from '../types.js';

/**
 * Shared OpenTelemetry HelmRepository singleton.
 *
 * The official OpenTelemetry chart repository
 * (https://open-telemetry.github.io/opentelemetry-helm-charts) is a single
 * cluster-level Flux source shared by every `clickstackK8sTelemetry` instance
 * (and any other OTel chart consumer). Owned via `singleton(...)` for the
 * same ApplySet-ownership reason documented on
 * `clickstackHelmRepositoryBootstrap`.
 */
export const otelHelmRepositoryBootstrap = kubernetesComposition(
  {
    name: 'opentelemetry-helm-repository',
    kind: 'OpenTelemetryHelmRepository',
    spec: OtelHelmRepositorySingletonSpecSchema,
    status: OtelHelmRepositorySingletonStatusSchema,
  },
  (spec) => {
    const repository = otelHelmRepository({
      name: spec.name,
      namespace: spec.namespace,
      url: spec.url,
      id: 'repository',
    });

    return {
      ready: Cel.expr<boolean>(
        repository.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
    };
  }
);
