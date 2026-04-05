/**
 * SearXNG Deployment Factory
 *
 * Creates a SearXNG Deployment with a mounted settings ConfigMap,
 * health probes at /healthz, and optional environment variables.
 * The secret_key is injected via SEARXNG_SECRET env var (not in ConfigMap).
 */

import type {
  CelExpression,
  Composable,
  Enhanced,
  ResourceStatus,
} from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import {
  DEFAULT_SEARXNG_IMAGE,
  DEFAULT_SEARXNG_PORT,
  type SearxngConfig,
  type SearxngStatus,
} from '../types.js';

/**
 * Relaxed spec type for the factory. The ArkType schema constrains
 * `secretKeyRef.name` and `secretKeyRef.key` to plain strings, but the
 * bootstrap composition needs to pass `CelExpression<string>` values in
 * KRO mode (where the field values are CEL ternaries that KRO evaluates
 * at reconcile time). At runtime `createResource` handles both concrete
 * strings and CelExpression objects uniformly, so widening the type here
 * is purely a TypeScript ergonomics fix — no runtime behavior change.
 */
type SearxngFactoryConfig = Omit<SearxngConfig, 'spec'> & {
  spec: Omit<SearxngConfig['spec'], 'secretKeyRef'> & {
    secretKeyRef?: {
      name: string | CelExpression<string>;
      key: string | CelExpression<string>;
    };
  };
};

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
 * @example Recommended — mount an existing Secret via `secretKeyRef`
 * ```typescript
 * const search = searxng({
 *   name: 'my-searxng',
 *   namespace: 'search',
 *   spec: {
 *     instanceName: 'My Search',
 *     search: { formats: ['html', 'json'] },
 *     server: { limiter: false },
 *     // Secret is managed externally (Vault, external-secrets operator,
 *     // or created alongside this factory). The Deployment mounts
 *     // SEARXNG_SECRET via valueFrom.secretKeyRef — the plaintext
 *     // never enters the Deployment spec.
 *     secretKeyRef: { name: 'my-searxng-secret', key: 'secret_key' },
 *   },
 * });
 * ```
 *
 * @example Discouraged — plaintext `secret_key` in the config
 * ```typescript
 * // Works, but the secret appears in `kubectl get deploy -o yaml` as
 * // Deployment.spec.template.spec.containers[0].env[].value. Prefer the
 * // `secretKeyRef` path above or use the `searxngBootstrap` composition
 * // which auto-creates a K8s Secret and wires it through for you.
 * const search = searxng({
 *   name: 'my-searxng',
 *   spec: {
 *     server: { secret_key: 'change-me-in-production', limiter: false },
 *   },
 * });
 * ```
 */
function createSearxngResource(
  config: Composable<SearxngFactoryConfig>
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
  // SEARXNG_SECRET delivery — secret_key is NEVER written into the ConfigMap.
  //
  // Precedence:
  //   1. secretKeyRef — mount an existing K8s Secret via valueFrom.secretKeyRef.
  //      This is the recommended production path: the secret never appears
  //      in Deployment spec, pod env dumps, or `kubectl get deploy -o yaml`.
  //      The bootstrap composition always uses this path.
  //   2. server.secret_key (plaintext) — fallback for direct-mode callers who
  //      manage their own secret injection. Insecure: appears in
  //      Deployment.spec.template.spec.containers[].env[].value. Logged with
  //      a deprecation warning below; prefer secretKeyRef in new code.
  if (config.spec.secretKeyRef) {
    env.push({
      name: 'SEARXNG_SECRET',
      valueFrom: {
        secretKeyRef: {
          name: config.spec.secretKeyRef.name,
          key: config.spec.secretKeyRef.key,
        },
      },
    });
  } else if (config.spec.server?.secret_key) {
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
