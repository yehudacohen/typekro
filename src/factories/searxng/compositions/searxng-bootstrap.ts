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
    //
    // WHY TEMPLATE LITERALS (not `yaml.dump(...)`):
    //
    // The composition function runs in two very different modes:
    //
    //   (1) Direct mode — spec fields are real values (`'redis://...'`,
    //       `['html', 'json']`, `false`). `yaml.dump()` would work fine
    //       and is in fact used by the `buildSearxngSettings` helper for
    //       direct-mode callers who pass a pre-built `settingsYaml`.
    //
    //   (2) KRO mode — spec fields are `KubernetesRef` proxy objects
    //       whose string coercion yields `__KUBERNETES_REF___schema___spec.xxx__`
    //       marker tokens. These markers are recognized by the framework
    //       later and rewritten into CEL expressions like
    //       `${string(schema.spec.redisUrl)}` inside the final RGD YAML.
    //       `yaml.dump()` cannot produce those markers — it would call
    //       `.toString()`/`.toJSON()` on the proxy and flatten everything
    //       into the wrong thing, losing the reference entirely.
    //
    // The template-literal approach is what makes mixed templates work:
    // the literal text (`use_default_settings: true`, key names, indentation)
    // is rendered as-is, while `${spec.redisUrl}` interpolation emits the
    // marker token that the framework then converts to CEL. This is the
    // only way to build a string that is BOTH (a) valid YAML when the
    // spec is concrete, and (b) a carrier for CEL references when it
    // isn't. Changing this to `yaml.dump()` will break KRO mode.
    //
    // The `typeof spec.settingsYaml === 'string'` branch lets advanced
    // direct-mode callers override the entire file with a hand-crafted
    // (or `buildSearxngSettings`-generated) string — in KRO mode the
    // proxy isn't a string, so this branch is never taken.
    //
    // `secret_key` is intentionally NOT written into the ConfigMap — it
    // flows through the SEARXNG_SECRET env var on the Deployment instead
    // so the ConfigMap can stay ReadOnly and the secret can be rotated
    // without reconciling config.
    const redisSection = spec.redisUrl
      ? `\nredis:\n  url: ${spec.redisUrl}`
      : '';

    // Build search formats: use spec.search.formats in direct mode (real array),
    // fall back to defaults in KRO mode (the proxy isn't a real array, so
    // `Array.isArray()` returns false and the literal default list is emitted).
    // TODO(typekro#array-cel): once CEL template support for arrays lands,
    // this can emit `${spec.search.formats}` in KRO mode too.
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
