/**
 * SearXNG Bootstrap Composition
 *
 * Deploys a complete SearXNG instance: Namespace + ConfigMap + Deployment + Service.
 * Settings are built from typed spec fields — no proxy objects pass through to YAML.
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
import { configMap } from '../../kubernetes/config/config-map.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { simple } from '../../simple/index.js';
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
    // Direct mode: if settingsYaml is provided (string), use it as-is.
    // Otherwise, build from individual spec fields via template literals.
    // KRO mode: proxy fields are always truthy, so typeof distinguishes
    // real strings from proxies. Template literals produce mixed templates
    // with ${CEL} refs that KRO evaluates at reconciliation time.
    // secret_key goes via SEARXNG_SECRET env var, not in ConfigMap.
    // Build Redis section only when redisUrl is provided (non-empty string).
    // In KRO mode this becomes a CEL conditional via the mixed template.
    const redisSection = spec.redisUrl
      ? `\nredis:\n  url: ${spec.redisUrl}`
      : '';

    // Build search formats: use spec.search.formats in direct mode (real array),
    // fall back to defaults in KRO mode (proxy isn't a real array).
    const searchFormats = Array.isArray(spec.search?.formats)
      ? spec.search.formats.map((f: string) => `    - ${f}`).join('\n')
      : '    - html\n    - json';

    const settingsYaml =
      typeof spec.settingsYaml === 'string'
        ? spec.settingsYaml
        : `use_default_settings: true
server:
  limiter: ${spec.server?.limiter ?? false}
search:
  formats:
${searchFormats}
${redisSection}`;
    const configMapName = `${spec.name}-config`;

    const _config = configMap({
      metadata: {
        name: configMapName,
        namespace: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'searxng',
          'app.kubernetes.io/component': 'config',
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      data: { 'settings.yml': settingsYaml },
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
