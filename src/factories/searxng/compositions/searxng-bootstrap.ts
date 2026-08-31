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
 *   server: { limiter: false, secret_key: process.env.SEARXNG_SECRET_KEY! },
 * });
 * ```
 */

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { TypeKroError } from '../../../core/errors.js';
import { getIncludeWhen, setIncludeWhen } from '../../../core/metadata/resource-metadata.js';
import type { StaticYamlMaterializationOptions } from '../../../core/planning/materialization.js';
import { Cel } from '../../../core/references/cel.js';
import type {
  DirectResourceFactory,
  KroResourceFactory,
  PublicFactoryOptions,
} from '../../../core/types/deployment.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { configMap } from '../../kubernetes/config/config-map.js';
import { secret } from '../../kubernetes/config/secret.js';
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

/**
 * Return a copy of the server config with `secret_key` removed. The field
 * is delivered via a dedicated K8s Secret, not via the Deployment spec —
 * this helper makes sure direct mode's plaintext does not leak into the
 * searxng() factory's `spec.server`, which would otherwise inject it as an
 * env value. KRO rejects the inline field and uses only `secretKeyRef`.
 */
function stripSecretKey<T extends { secret_key?: unknown }>(server: T): Omit<T, 'secret_key'> {
  const { secret_key: _discarded, ...rest } = server;
  return rest;
}

function appendIncludeWhen(resource: WeakKey, conditions: unknown[]): void {
  setIncludeWhen(resource, [...(getIncludeWhen(resource) ?? []), ...conditions]);
}

type SearxngKroFactory = KroResourceFactory<
  SearxngBootstrapConfig,
  typeof SearxngBootstrapStatusSchema.infer
>;

function validateKroBootstrapInstanceSpec(spec: SearxngBootstrapConfig): void {
  if (spec.enabled === false) {
    throw new TypeKroError(
      'searxngBootstrap KRO mode does not support enabled=false because status depends on the Deployment resource. ' +
        'Use direct mode for disabled instances or omit the KRO instance.',
      'UNSUPPORTED_KRO_CONFIG',
      { field: 'enabled', mode: 'kro' }
    );
  }

  if (spec.server?.secret_key !== undefined) {
    throw new TypeKroError(
      'searxngBootstrap KRO mode rejects server.secret_key even when secretKeyRef is present. KRO credentials are reference-only so plaintext is never materialized into the instance custom resource.',
      'UNSUPPORTED_KRO_CONFIG',
      { field: 'server.secret_key', mode: 'kro' }
    );
  }

  if (!spec.secretKeyRef) {
    throw new TypeKroError(
      'searxngBootstrap KRO mode requires secretKeyRef for enabled instances. Inline server.secret_key is direct-mode-only so plaintext credentials are not stored in KRO custom resources.',
      'REQUIRED_CONFIG_MISSING',
      { field: 'secretKeyRef', mode: 'kro' }
    );
  }
}

function withKroInstanceValidation(
  factory: SearxngKroFactory
): SearxngKroFactory {
  return new Proxy(factory, {
    get(target, prop, receiver) {
      if (prop === 'deploy') {
        return (
          spec: SearxngBootstrapConfig,
          opts?: Parameters<
            KroResourceFactory<
              SearxngBootstrapConfig,
              typeof SearxngBootstrapStatusSchema.infer
            >['deploy']
          >[1]
        ) => {
          validateKroBootstrapInstanceSpec(spec);
          return target.deploy(spec, opts);
        };
      }

      if (prop === 'toYaml') {
        return (spec?: SearxngBootstrapConfig, options?: StaticYamlMaterializationOptions) => {
          if (spec !== undefined) {
            validateKroBootstrapInstanceSpec(spec);
            return target.toYaml(spec, options);
          }
          return target.toYaml();
        };
      }

      if (prop === 'toAlchemyResources') {
        return async (
          spec: SearxngBootstrapConfig,
          opts?: Parameters<SearxngKroFactory['toAlchemyResources']>[1]
        ) => {
          validateKroBootstrapInstanceSpec(spec);
          return target.toAlchemyResources(spec, opts);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const searxngBootstrapComposition = kubernetesComposition(
  {
    name: 'searxng-bootstrap',
    kind: 'SearxngBootstrap',
    spec: SearxngBootstrapConfigSchema,
    status: SearxngBootstrapStatusSchema,
  },
  (spec: SearxngBootstrapConfig) => {
    const resolvedNamespace = isKubernetesRef(spec.namespace)
      ? Cel.default(spec.namespace, 'searxng')
      : (spec.namespace ?? 'searxng');
    const resolvedImage = isKubernetesRef(spec.image)
      ? Cel.default(spec.image, DEFAULT_SEARXNG_IMAGE)
      : (spec.image ?? DEFAULT_SEARXNG_IMAGE);
    const resolvedReplicas = isKubernetesRef(spec.replicas)
      ? Cel.default(spec.replicas, 1)
      : (spec.replicas ?? 1);
    const isGraphMode = isKubernetesRef(spec.name);
    const enabledWhen = Cel.expr<boolean>(
      '!(has(schema.spec.enabled)) || schema.spec.enabled != false'
    );
    // ArkType's cross-field `.narrow()` protects JavaScript factory calls, but
    // KRO does not carry that predicate into the generated CRD schema. Raw
    // GitOps clients can therefore submit an enabled instance without the
    // required external reference. Fail closed at the graph boundary too:
    // such an instance owns no Namespace, Secret, Deployment, ConfigMap, or
    // Service. Inline secrets remain a direct-mode-only convenience so secret
    // data never controls KRO resource activation or lives in an instance CR.
    const credentialSourcePresentWhen = Cel.expr<boolean>('has(schema.spec.secretKeyRef)');
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
      if (isGraphMode) {
        appendIncludeWhen(_ns, [enabledWhen, credentialSourcePresentWhen]);
      }

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
      const redisSection = isKubernetesRef(spec.redisUrl)
        ? `${Cel.cond<string>(Cel.has(spec.redisUrl), `\nredis:\n  url: ${spec.redisUrl}`, '')}`
        : spec.redisUrl
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

      const serverLimiterRef = isKubernetesRef(spec.server?.limiter)
        ? spec.server?.limiter
        : undefined;
      const serverLimiter = serverLimiterRef
        ? '$' +
          '{string(has(schema.spec.server) && has(schema.spec.server.limiter) ? schema.spec.server.limiter : false)}'
        : (spec.server?.limiter ?? false);
      const serverSettings = [
        `  limiter: ${serverLimiter}`,
        ...(typeof spec.server?.bind_address === 'string'
          ? [`  bind_address: ${spec.server.bind_address}`]
          : []),
        ...(typeof spec.server?.method === 'string' ? [`  method: ${spec.server.method}`] : []),
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
      if (isGraphMode) {
        appendIncludeWhen(_config, [enabledWhen, credentialSourcePresentWhen]);
      }

      // ── Secret (SEARXNG_SECRET delivery) ───────────────────────────────
      //
      // Secret delivery rules:
      //   (1) If the user provided an external `secretKeyRef`, the Deployment
      //       mounts that existing Secret via valueFrom — the bootstrap does
      //       NOT create its own. This is the path for external-secrets
      //       workflows (Vault, AWS SM, external-secrets operator).
      //   (2) In direct mode, the bootstrap can instead create a dedicated
      //       `{name}-secret` Secret from `server.secret_key`. The plaintext
      //       stops at the Secret's stringData and never enters the Deployment
      //       env. KRO mode requires the external-reference form.
      //
      // Direct mode suppresses the generated Secret when `secretKeyRef` is
      // present, so an external Secret remains externally owned; KRO mode
      // suppresses it unconditionally. The Deployment and every sibling are
      // gated on credential-source PRESENCE so raw GitOps instances that
      // bypass ArkType validation fail
      // closed without creating a broken workload. Secret DATA never controls
      // resource activation. KRO always selects the external reference; only
      // direct mode can select the generated Secret.
      //
      // Why `simple.Secret` is NOT used here: it eagerly base64-encodes
      // stringData values via `Buffer.from(...)` at composition time, which
      // would encode the `__KUBERNETES_REF__` marker token in KRO mode
      // instead of the actual user-supplied secret, baking a broken value
      // into the RGD. The low-level `secret()` factory passes `stringData`
      // through untouched so KRO can resolve it at reconcile time.
      const secretName = `${spec.name}-secret`;
      const dynamicSecretKeyRef = isKubernetesRef(spec.secretKeyRef)
        ? spec.secretKeyRef
        : undefined;
      const hasDynamicSecretKeyRef = dynamicSecretKeyRef !== undefined;
      const secretKey = spec.server?.secret_key;

      if (!hasDynamicSecretKeyRef && !spec.secretKeyRef && secretKey === undefined) {
        throw new TypeKroError(
          'searxngBootstrap requires server.secret_key or secretKeyRef when enabled. ' +
            'Use secretKeyRef for production deployments managed by external secret tooling.',
          'REQUIRED_CONFIG_MISSING',
          { field: 'server.secret_key', alternative: 'secretKeyRef' }
        );
      }

      const generatedSecret = secret({
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
          secret_key: secretKey ?? '',
        },
        id: 'searxngSecret',
      });

      if (isGraphMode) {
        // Inline credentials are deliberately direct-mode-only. Keeping the
        // generated Secret inactive in every KRO instance prevents plaintext
        // credentials from becoming a supported CR storage path.
        setIncludeWhen(generatedSecret, [Cel.expr<boolean>('false')]);
      } else if (hasDynamicSecretKeyRef) {
        setIncludeWhen(generatedSecret, [Cel.not(dynamicSecretKeyRef)]);
      } else if (spec.secretKeyRef) {
        setIncludeWhen(generatedSecret, [false]);
      }

      // ── Deployment ─────────────────────────────────────────────────────
      //
      // The Deployment never sees the plaintext secret — it mounts a
      // `secretKeyRef` instead, which the factory translates into
      // `valueFrom.secretKeyRef` on the SEARXNG_SECRET env var.
      //
      // In KRO mode the explicit CEL reference selects the required external
      // Secret. Direct mode may instead select the auto-created Secret.
      const deploymentSecretRefName = hasDynamicSecretKeyRef
        ? `${Cel.cond<string>(Cel.has(dynamicSecretKeyRef), dynamicSecretKeyRef.name, secretName)}`
        : spec.secretKeyRef
          ? spec.secretKeyRef.name
          : secretName;
      const deploymentSecretRefKey = hasDynamicSecretKeyRef
        ? `${Cel.cond<string>(Cel.has(dynamicSecretKeyRef), dynamicSecretKeyRef.key, 'secret_key')}`
        : spec.secretKeyRef
          ? spec.secretKeyRef.key
          : 'secret_key';

      deployment = searxng({
        name: spec.name,
        namespace: resolvedNamespace,
        spec: {
          image: resolvedImage,
          replicas: resolvedReplicas,
          instanceName: isKubernetesRef(spec.instanceName)
            ? Cel.default(spec.instanceName, spec.name)
            : (spec.instanceName ?? spec.name),
          baseUrl: isKubernetesRef(spec.baseUrl)
            ? Cel.default(spec.baseUrl, `http://${spec.name}:${port}/`)
            : (spec.baseUrl ?? `http://${spec.name}:${port}/`),
          configMapName,
          // Strip secret_key before passing server config through — the
          // plaintext stops here and is delivered exclusively via the
          // Secret resource above.
          ...(spec.server && {
            server: stripSecretKey(spec.server),
          }),
          secretKeyRef: {
            name: deploymentSecretRefName,
            key: deploymentSecretRefKey,
          },
          env: isKubernetesRef(spec.env) ? undefined : spec.env,
          resources: spec.resources,
        },
        id: 'searxngDeployment',
      });
      if (isGraphMode) {
        appendIncludeWhen(deployment, [enabledWhen, credentialSourcePresentWhen]);
      }

      // ── Service ────────────────────────────────────────────────────────

      const svc = simple.Service({
        name: spec.name,
        namespace: resolvedNamespace,
        selector: {
          'app.kubernetes.io/name': 'searxng',
          'app.kubernetes.io/instance': spec.name,
        },
        ports: [{ port, targetPort: port, name: 'http' }],
        id: 'searxngService',
      });
      if (isGraphMode) {
        appendIncludeWhen(svc, [enabledWhen, credentialSourcePresentWhen]);
      }
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

    return {
      ready: Cel.expr<boolean>(
        deployment.status.conditions,
        '.exists(c, c.type == "Available" && c.status == "True")'
      ),
      phase: Cel.expr<'Ready' | 'Installing' | 'Disabled'>(
        deployment.status.conditions,
        '.exists(c, c.type == "Available" && c.status == "True") ? "Ready" : "Installing"'
      ),
      failed: Cel.expr<boolean>(
        deployment.status.conditions,
        '.exists(c, c.type == "Available" && c.status == "False")'
      ),
      url: `http://${spec.name}.${resolvedNamespace}:${port}`,
    };
  },
  {
    // Direct mode intentionally retains the ergonomic inline-to-Secret path,
    // but a KRO custom resource is a broadly readable persistence boundary.
    // This optional-leaf validation runs only when the field is present, so
    // raw GitOps instances cannot submit plaintext — including alongside an
    // otherwise valid secretKeyRef.
    schemaFieldValidations: {
      'server.secret_key': 'false',
    },
  }
);

const baseFactory = searxngBootstrapComposition.factory.bind(searxngBootstrapComposition);

function searxngBootstrapFactory(
  mode: 'kro',
  options?: PublicFactoryOptions
): KroResourceFactory<SearxngBootstrapConfig, typeof SearxngBootstrapStatusSchema.infer>;
function searxngBootstrapFactory(
  mode: 'direct',
  options?: PublicFactoryOptions
): DirectResourceFactory<SearxngBootstrapConfig, typeof SearxngBootstrapStatusSchema.infer>;
function searxngBootstrapFactory(mode: 'kro' | 'direct', options?: PublicFactoryOptions) {
  const factory = baseFactory(mode, options);
  return mode === 'kro'
    ? withKroInstanceValidation(
        factory as KroResourceFactory<
          SearxngBootstrapConfig,
          typeof SearxngBootstrapStatusSchema.infer
        >
      )
    : factory;
}

Object.defineProperty(searxngBootstrapComposition, 'factory', {
  value: searxngBootstrapFactory,
  writable: true,
  enumerable: true,
  configurable: true,
});

export const searxngBootstrap = searxngBootstrapComposition;
