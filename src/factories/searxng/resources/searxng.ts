/**
 * SearXNG Deployment Factory
 *
 * Creates a SearXNG Deployment with a mounted settings ConfigMap,
 * health probes at /healthz, and optional environment variables.
 * The secret_key is injected via SEARXNG_SECRET env var (not in ConfigMap).
 */

import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import {
  DEFAULT_SEARXNG_IMAGE,
  DEFAULT_SEARXNG_PORT,
  type SearxngConfig,
  type SearxngStatus,
} from '../types.js';

function searxngReadinessEvaluator(liveResource: unknown): ResourceStatus {
  try {
    const resource = liveResource as {
      status?: { readyReplicas?: number; conditions?: Array<{ type: string; status: string; message?: string }> };
      spec?: { replicas?: number };
    };

    const desired = resource.spec?.replicas ?? 1;
    const ready = resource.status?.readyReplicas ?? 0;

    if (ready >= desired) {
      return { ready: true, reason: 'DeploymentReady', message: `${ready}/${desired} replicas ready` };
    }
    return { ready: false, reason: 'ReplicasNotReady', message: `${ready}/${desired} replicas ready` };
  } catch {
    return { ready: false, reason: 'EvaluationError', message: 'Failed to evaluate SearXNG readiness' };
  }
}

/**
 * Create a SearXNG Deployment resource.
 *
 * @example
 * ```typescript
 * const search = searxng({
 *   name: 'my-searxng',
 *   namespace: 'search',
 *   spec: {
 *     instanceName: 'My Search',
 *     search: { formats: ['html', 'json'] },
 *     server: { secret_key: 'injected-via-env', limiter: false },
 *   },
 * });
 * ```
 */
function createSearxngResource(
  config: Composable<SearxngConfig>
): Enhanced<SearxngConfig['spec'], SearxngStatus> {
  const image = config.spec.image ?? DEFAULT_SEARXNG_IMAGE;
  const replicas = config.spec.replicas ?? 1;
  const port = DEFAULT_SEARXNG_PORT;
  const configMapName = config.spec.configMapName ?? `${config.name}-config`;

  const env: Array<{ name: string; value?: string; valueFrom?: unknown }> = [];

  if (config.spec.instanceName) {
    env.push({ name: 'INSTANCE_NAME', value: config.spec.instanceName });
  }
  if (config.spec.baseUrl) {
    env.push({ name: 'BASE_URL', value: config.spec.baseUrl });
  }
  // secret_key injected via SEARXNG_SECRET env var — never in ConfigMap
  if (config.spec.server?.secret_key) {
    env.push({ name: 'SEARXNG_SECRET', value: config.spec.server.secret_key });
  }
  if (config.spec.env) {
    for (const [key, value] of Object.entries(config.spec.env)) {
      env.push({ name: key, value });
    }
  }

  return createResource(
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
        labels: {
          'app.kubernetes.io/name': 'searxng',
          'app.kubernetes.io/instance': config.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      spec: {
        replicas,
        selector: {
          matchLabels: {
            'app.kubernetes.io/name': 'searxng',
            'app.kubernetes.io/instance': config.name,
          },
        },
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/name': 'searxng',
              'app.kubernetes.io/instance': config.name,
            },
          },
          spec: {
            containers: [
              {
                name: 'searxng',
                image,
                ...(config.spec.imagePullPolicy && { imagePullPolicy: config.spec.imagePullPolicy }),
                ports: [{ name: 'http', containerPort: port, protocol: 'TCP' }],
                ...(env.length > 0 && { env }),
                ...(config.spec.resources && { resources: config.spec.resources }),
                volumeMounts: [
                  {
                    name: 'searxng-config',
                    mountPath: '/etc/searxng/settings.yml',
                    subPath: 'settings.yml',
                    readOnly: true,
                  },
                ],
                // SearXNG takes 10-20s to initialize engines.
                // Use startupProbe to avoid premature liveness kills.
                startupProbe: {
                  httpGet: { path: '/healthz', port: 'http' },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                  failureThreshold: 6,
                },
                livenessProbe: {
                  httpGet: { path: '/healthz', port: 'http' },
                  periodSeconds: 10,
                },
                readinessProbe: {
                  httpGet: { path: '/healthz', port: 'http' },
                  periodSeconds: 5,
                },
              },
            ],
            volumes: [
              {
                name: 'searxng-config',
                configMap: { name: configMapName },
              },
            ],
            ...(config.spec.nodeSelector && { nodeSelector: config.spec.nodeSelector }),
            ...(config.spec.tolerations && { tolerations: config.spec.tolerations }),
          },
        },
      },
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(searxngReadinessEvaluator) as unknown as Enhanced<
    SearxngConfig['spec'],
    SearxngStatus
  >;
}

export const searxng = createSearxngResource;
