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
import { secret } from '../../kubernetes/config/secret.js';
import { simple } from '../../simple/index.js';
import { searxng } from '../resources/searxng.js';
import {
  DEFAULT_SEARXNG_IMAGE,
  DEFAULT_SEARXNG_PORT,
  type SearxngBootstrapConfig,
  SearxngBootstrapConfigSchema,
  SearxngBootstrapStatusSchema,
} from '../types.js';

const DEFAULT_SEARXNG_SECRET_KEY = 'change-me-in-production';

/**
 * Return a copy of the server config with `secret_key` removed. The field
 * is delivered via a dedicated K8s Secret, not via the Deployment spec —
 * this helper makes sure the plaintext (or the KubernetesRef proxy that
 * carries it in KRO mode) does not leak into the searxng() factory's
 * `spec.server` which would otherwise fall back to injecting it as a
 * plaintext env var.
 */
function stripSecretKey<T extends { secret_key?: unknown }>(server: T): Omit<T, 'secret_key'> {
  const { secret_key: _discarded, ...rest } = server;
  return rest;
}

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
    let deployment: ReturnType<typeof searxng> | undefined;

    if (spec.enabled !== false) {
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
    // `secret_key` is intentionally NOT written into the ConfigMap — and
    // it's also NOT injected as a plaintext env var on the Deployment
    // (which would expose it via `kubectl get deploy -o yaml`). Instead,
    // the secret is delivered via a dedicated K8s Secret resource that
    // the Deployment mounts with `valueFrom.secretKeyRef`. See the
    // Secret block below.
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

      const serverSettings = [
        `  limiter: ${spec.server?.limiter ?? false}`,
        ...(typeof spec.server?.bind_address === 'string'
          ? [`  bind_address: ${spec.server.bind_address}`]
          : []),
        ...(typeof spec.server?.method === 'string'
          ? [`  method: ${spec.server.method}`]
          : []),
      ].join('\n');
      const searchSettings = [
        '  formats:',
        searchFormats,
        ...(typeof spec.search?.default_lang === 'string'
          ? [`  default_lang: ${spec.search.default_lang}`]
          : []),
        ...(typeof spec.search?.autocomplete === 'string'
          ? [`  autocomplete: ${spec.search.autocomplete}`]
          : []),
        ...(typeof spec.search?.safe_search === 'number'
          ? [`  safe_search: ${spec.search.safe_search}`]
          : []),
      ].join('\n');

      const settingsYaml =
        typeof spec.settingsYaml === 'string'
          ? spec.settingsYaml
          : `use_default_settings: true
server:
${serverSettings}
search:
${searchSettings}
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

    // ── Secret (SEARXNG_SECRET delivery) ───────────────────────────────
    //
    // Secret delivery rules:
    //   (1) If the user provided an external `secretKeyRef`, the Deployment
    //       mounts that existing Secret via valueFrom — the bootstrap does
    //       NOT create its own. This is the path for external-secrets
    //       workflows (Vault, AWS SM, external-secrets operator).
    //   (2) Otherwise, the bootstrap creates a dedicated `{name}-secret`
    //       Secret from `server.secret_key`. The plaintext stops at the
    //       Secret's stringData and never enters the Deployment env.
    //
    // The plain `if (!spec.secretKeyRef)` below is transformed into a KRO
    // `includeWhen: ${!has(schema.spec.secretKeyRef)}` directive by the
    // composition AST analyzer during serialization. In direct mode the
    // `if` runs normally; in KRO mode the analyzer attaches the includeWhen
    // so the Secret is only created when the user didn't provide an
    // external ref. The Deployment's `secretKeyRef` field is computed by
    // the JS ternary on the same condition and the analyzer emits the
    // corresponding CEL ternary there as well.
    //
    // Why `simple.Secret` is NOT used here: it eagerly base64-encodes
    // stringData values via `Buffer.from(...)` at composition time, which
    // would encode the `__KUBERNETES_REF__` marker token in KRO mode
    // instead of the actual user-supplied secret, baking a broken value
    // into the RGD. The low-level `secret()` factory passes `stringData`
    // through untouched so KRO can resolve it at reconcile time.
      const secretName = `${spec.name}-secret`;

      if (!spec.secretKeyRef) {
        secret({
          metadata: {
            name: secretName,
            namespace: resolvedNamespace,
            labels: {
              'app.kubernetes.io/name': 'searxng',
              'app.kubernetes.io/instance': spec.name,
              'app.kubernetes.io/component': 'secret',
              'app.kubernetes.io/managed-by': 'typekro',
            },
          },
          type: 'Opaque',
          stringData: {
            secret_key: spec.server?.secret_key ?? DEFAULT_SEARXNG_SECRET_KEY,
          },
          id: 'searxngSecret',
        });
      }

    // ── Deployment ─────────────────────────────────────────────────────
    //
    // The Deployment never sees the plaintext secret — it mounts a
    // `secretKeyRef` instead, which the factory translates into
    // `valueFrom.secretKeyRef` on the SEARXNG_SECRET env var.
    //
    // The two nested ternaries on `secretKeyRef.name` and `secretKeyRef.key`
    // are detected by the composition AST analyzer and emitted as CEL
    // conditionals in the final RGD — in KRO mode the user's CR value
    // for `spec.secretKeyRef` selects between the external Secret and
    // the auto-created one at reconcile time.
      deployment = searxng({
        name: spec.name,
        namespace: resolvedNamespace,
        spec: {
          image: resolvedImage,
          replicas: spec.replicas ?? 1,
          instanceName: spec.instanceName ?? spec.name,
          baseUrl: spec.baseUrl ?? `http://${spec.name}:${port}/`,
          configMapName,
          // Strip secret_key before passing server config through — the
          // plaintext stops here and is delivered exclusively via the
          // Secret resource above.
          ...(spec.server && {
            server: stripSecretKey(spec.server),
          }),
          secretKeyRef: {
            name: spec.secretKeyRef ? spec.secretKeyRef.name : secretName,
            key: spec.secretKeyRef ? spec.secretKeyRef.key : 'secret_key',
          },
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
    }

    if (!deployment) {
      return {
        ready: true,
        phase: 'Disabled' as const,
        failed: false,
        url: '',
      };
    }

    // ── Status ─────────────────────────────────────────────────────────

    const disabledCondition = 'has(schema.spec.enabled) && schema.spec.enabled == false';
    const urlExpression = `"http://" + schema.spec.name + "." + (has(schema.spec.namespace) ? schema.spec.namespace : "searxng") + ":${port}"`;

    return {
      ready: Cel.expr<boolean>(
        `${disabledCondition} ? true : `,
        deployment.status.conditions,
        '.exists(c, c.type == "Available" && c.status == "True")'
      ),
      phase: Cel.expr<'Ready' | 'Installing' | 'Disabled'>(
        `${disabledCondition} ? "Disabled" : (`,
        deployment.status.conditions,
        '.exists(c, c.type == "Available" && c.status == "True") ? "Ready" : "Installing")'
      ),
      failed: Cel.expr<boolean>(
        `${disabledCondition} ? false : `,
        deployment.status.conditions,
        '.exists(c, c.type == "Available" && c.status == "False")'
      ),
      url: Cel.expr<string>(
        `${disabledCondition} ? "" : (`,
        deployment.status.conditions,
        `.exists(c, true) ? ${urlExpression} : ${urlExpression})`
      ),
    };
  }
);
