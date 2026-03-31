/**
 * SearXNG Bootstrap Composition
 *
 * Deploys a complete SearXNG instance: Namespace + ConfigMap + Deployment + Service.
 * Configurable search settings, optional rate limiter via Redis/Valkey URL.
 *
 * @example
 * ```typescript
 * import { searxngBootstrap } from 'typekro/searxng';
 *
 * const factory = searxngBootstrap.factory('direct', {
 *   namespace: 'search',
 *   waitForReady: true,
 * });
 *
 * await factory.deploy({
 *   name: 'searxng',
 *   search: { formats: ['html', 'json'] },
 *   server: { limiter: false, secret_key: 'change-me-in-production' },
 * });
 * ```
 */

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { simple } from '../../simple/index.js';
import { searxngConfigMap } from '../resources/config.js';
import { searxng } from '../resources/searxng.js';
import {
  DEFAULT_SEARXNG_IMAGE,
  DEFAULT_SEARXNG_PORT,
  type SearxngBootstrapConfig,
  SearxngBootstrapConfigSchema,
  SearxngBootstrapStatusSchema,
} from '../types.js';

export const searxngBootstrap = kubernetesComposition(
  {
    name: 'searxng-bootstrap',
    kind: 'SearxngBootstrap',
    spec: SearxngBootstrapConfigSchema,
    status: SearxngBootstrapStatusSchema,
  },
  (spec: SearxngBootstrapConfig) => {
    const resolvedNamespace = spec.namespace ?? 'searxng';
    const resolvedImage = spec.image ?? DEFAULT_SEARXNG_IMAGE;
    const port = DEFAULT_SEARXNG_PORT;

    // ── Namespace ──────────────────────────────────────────────────────

    const _ns = namespace({
      metadata: {
        name: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'searxng',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'searxngNamespace',
    });

    // ── Settings ConfigMap ─────────────────────────────────────────────
    // secret_key is stripped from the ConfigMap — injected via SEARXNG_SECRET env var

    const settings: Record<string, unknown> = {
      use_default_settings: true,
    };

    if (spec.server) {
      settings.server = { ...spec.server };
    }
    if (spec.search) {
      settings.search = spec.search;
    }

    // If redisUrl is provided, configure the rate limiter in settings.yml
    // UNLESS the user explicitly set limiter: false
    if (spec.redisUrl) {
      if (!settings.server) settings.server = {};
      const server = settings.server as Record<string, unknown>;
      if (server.limiter !== false) {
        server.limiter = true;
      }
      settings.redis = { url: spec.redisUrl };
    }

    const configMapName = `${spec.name}-config`;
    const _config = searxngConfigMap({
      name: configMapName,
      namespace: resolvedNamespace,
      settings,
      id: 'searxngConfig',
    });

    // ── Deployment ─────────────────────────────────────────────────────

    const _deployment = searxng({
      name: spec.name,
      namespace: resolvedNamespace,
      spec: {
        image: resolvedImage,
        replicas: spec.replicas ?? 1,
        instanceName: spec.instanceName ?? spec.name,
        baseUrl: spec.baseUrl ?? `http://${spec.name}:${port}/`,
        configMapName,
        server: spec.server,
        env: spec.env,
        resources: spec.resources,
      },
      id: 'searxngDeployment',
    });

    // ── Service ────────────────────────────────────────────────────────

    simple.Service({
      name: spec.name,
      namespace: resolvedNamespace,
      selector: {
        'app.kubernetes.io/name': 'searxng',
        'app.kubernetes.io/instance': spec.name,
      },
      ports: [{ port, targetPort: port, name: 'http' }],
      id: 'searxngService',
    });

    // ── Status ─────────────────────────────────────────────────────────
    // Use Cel.expr for KRO compatibility — direct property access doesn't
    // work in KRO mode where resources are proxy objects.

    return {
      ready: Cel.expr<boolean>(
        _deployment.status.conditions,
        '.exists(c, c.type == "Available" && c.status == "True")'
      ),
      phase: Cel.expr<'Ready' | 'Installing'>(
        _deployment.status.conditions,
        '.exists(c, c.type == "Available" && c.status == "True") ? "Ready" : "Installing"'
      ),
      failed: Cel.expr<boolean>(
        _deployment.status.conditions,
        '.exists(c, c.type == "Available" && c.status == "False")'
      ),
      url: `http://${spec.name}.${resolvedNamespace}:${port}`,
    };
  }
);
