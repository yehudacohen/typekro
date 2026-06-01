import { TypeKroError } from '../../../core/errors.js';
import { Cel } from '../../../core/references/cel.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import type {
  OryConfigValidationResult,
  OryDependencySource,
  OryHealthCheckStatus,
  OryHelmValueWarning,
  OryHelmValuesMapper,
  OryHydraChartValues,
  OryHydraMaesterChartValues,
  OryIdentityStackConfig,
  OryKetoChartValues,
  OryKratosChartValues,
  OryMappedHelmValues,
  OryMetricSignal,
  OryOathkeeperChartValues,
  OryOathkeeperMaesterChartValues,
  OrySecretKeyRef,
  OryValueSource,
} from '../types.js';

function hasValueSource(source: OryValueSource | undefined): boolean {
  return !!source && (('secretRef' in source && !!source.secretRef.name && !!source.secretRef.key) || ('value' in source && source.value.length > 0));
}

function secretEnv(name: string, source: OryValueSource | undefined): Record<string, unknown> | undefined {
  if (!source) return undefined;
  if ('secretRef' in source) return { name, valueFrom: { secretKeyRef: source.secretRef } };
  return { name, value: source.value };
}

function secretValue(source: OryValueSource | undefined): unknown {
  if (!source) return undefined;
  if ('secretRef' in source) return undefined;
  return source.value;
}

function stringValue(source: OryValueSource | undefined): string | undefined {
  if (!source || 'secretRef' in source) return undefined;
  return source.value;
}

function compact<T extends object>(value: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function envName(value: unknown): string | undefined {
  return isRecord(value) && typeof value.name === 'string' ? value.name : undefined;
}

function isSchemaMarkerKey(key: string): boolean {
  return key.startsWith('__typekro');
}

function mergeExtraEnv(base: unknown[], override: unknown[]): unknown[] {
  const protectedNames = new Set(base.flatMap((entry) => envName(entry) ?? []));
  return [...base, ...override.filter((entry) => !protectedNames.has(envName(entry) ?? ''))];
}

function deepMergeValue(base: unknown, override: unknown, key?: string): unknown {
  if (override === undefined) return base;
  if (key === 'extraEnv' && Array.isArray(base) && Array.isArray(override)) {
    return mergeExtraEnv(base, override);
  }
  if (isRecord(base) && isRecord(override)) {
    return Object.fromEntries(
      Array.from(new Set([...Object.keys(base), ...Object.keys(override)])).map((childKey) => [
        childKey,
        deepMergeValue(base[childKey], override[childKey], childKey),
      ])
    );
  }
  return override;
}

function mergeValues<T extends object>(
  base: T,
  typed?: T,
  serviceCustom?: Record<string, unknown>,
  stackCustom?: Record<string, unknown>
): T {
  let merged: unknown = base;
  for (const next of [typed, serviceCustom, stackCustom]) {
    merged = deepMergeValue(merged, next ?? {});
  }
  return merged as T;
}

function sharedGlobal(config: OryIdentityStackConfig): Record<string, unknown> | undefined {
  return compact<Record<string, unknown>>({
    global: compact<Record<string, unknown>>({ imageRegistry: config.global?.imageRegistry }),
    imagePullSecrets: config.global?.imagePullSecrets?.map((name) => ({ name })),
  });
}

function envList(
  env: Record<string, unknown> | Array<Record<string, unknown> | undefined> | undefined
): Record<string, unknown>[] | undefined {
  const entries = Array.isArray(env) ? env.filter((entry) => entry !== undefined) : env ? [env] : [];
  return entries.length > 0 ? entries : undefined;
}

function deploymentTargets(
  env: Record<string, unknown> | Array<Record<string, unknown> | undefined> | undefined,
  resources?: unknown
): Record<string, unknown> {
  const extraEnv = envList(env);
  return {
    deployment: compact({
      extraEnv,
      automigration: extraEnv ? { extraEnv } : undefined,
      resources,
    }),
  };
}

function statefulSetTargets(
  env: Record<string, unknown> | Array<Record<string, unknown> | undefined> | undefined,
  resources?: unknown
): Record<string, unknown> {
  return { statefulSet: compact({ extraEnv: envList(env), resources }) };
}

function jobTargets(
  env: Record<string, unknown> | Array<Record<string, unknown> | undefined> | undefined
): Record<string, unknown> {
  return { job: compact({ extraEnv: envList(env) }) };
}

function automigrationEnv(
  env: Record<string, unknown> | Array<Record<string, unknown> | undefined> | undefined
): Record<string, unknown> | undefined {
  const extraEnv = envList(env);
  return compact<Record<string, unknown>>({ enabled: true, extraEnv });
}

function hydraUrls(config: OryIdentityStackConfig['hydra']): Record<string, unknown> | undefined {
  return compact<Record<string, unknown>>({
    self: config?.issuerUrl ? { issuer: config.issuerUrl } : undefined,
    login: config?.loginUrl,
    consent: config?.consentUrl,
    logout: config?.logoutUrl,
  });
}

function defaultKratosIdentitySchema(): string {
  return JSON.stringify({
    $id: 'https://typekro.dev/schemas/ory/default-identity.schema.json',
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Default Identity',
    type: 'object',
    properties: {
      traits: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
        },
      },
    },
  });
}

function dynamicKratosIdentitySchemas(): Record<string, string> {
  return Cel.expr<Record<string, string>>(
    'has(schema.spec.kratos) && has(schema.spec.kratos.identitySchemas) ? schema.spec.kratos.identitySchemas : {"identity.default.schema.json": ',
    JSON.stringify(defaultKratosIdentitySchema()),
    '}'
  ) as Record<string, string>;
}

function dynamicKratosIdentitySchemaRefs(): Array<{ id: string; url: string }> {
  return Cel.expr<Array<{ id: string; url: string }>>(
    'has(schema.spec.kratos) && has(schema.spec.kratos.identitySchemas) ? schema.spec.kratos.identitySchemas.keys().map(filename, {"id": filename, "url": "file:///etc/config/" + filename}) : [{"id": "default", "url": "file:///etc/config/identity.default.schema.json"}]'
  ) as Array<{ id: string; url: string }>;
}

function kratosIdentitySchemas(config: OryIdentityStackConfig['kratos']): Record<string, string> | undefined {
  if (isKubernetesRef(config?.identitySchemas)) {
    return dynamicKratosIdentitySchemas();
  }

  if (config?.identitySchemas && Object.keys(config.identitySchemas).length > 0) {
    return config.identitySchemas;
  }
  return { 'identity.default.schema.json': defaultKratosIdentitySchema() };
}

function kratosIdentitySchemaRefs(config: OryIdentityStackConfig['kratos']): Array<{ id: string; url: string }> {
  if (isKubernetesRef(config?.identitySchemas)) {
    return dynamicKratosIdentitySchemaRefs();
  }

  return Object.keys(kratosIdentitySchemas(config) ?? {}).map((filename) => ({
    id: filename === 'identity.default.schema.json'
      ? 'default'
      : filename.replace(/\.schema\.json$/, '').replace(/\.json$/, ''),
    url: `file:///etc/config/${filename}`,
  }));
}

function kratosConfig(config: OryIdentityStackConfig['kratos']): Record<string, unknown> {
  const defaultReturnUrl = config?.browserBaseUrl ?? config?.publicBaseUrl;
  return compact<Record<string, unknown>>({
    dsn: secretValue(config?.dsn),
    courier: config?.courier,
    secrets: literalSecretValues(config?.secrets),
    serve: compact({
      public: config?.publicBaseUrl ? { base_url: config.publicBaseUrl } : undefined,
    }),
    selfservice: defaultReturnUrl ? { default_browser_return_url: defaultReturnUrl } : undefined,
    identity: {
      schemas: kratosIdentitySchemaRefs(config),
    },
  });
}

function ketoNamespaces(config: OryIdentityStackConfig['keto']): Array<{ id: number; name: string }> {
  return Array.isArray(config?.namespaces)
    ? config.namespaces.map(({ id, name }) => ({ id, name }))
    : [];
}

function namedSecretEnvs(
  prefix: string,
  sources: Record<string, OryValueSource> | undefined
): Array<Record<string, unknown> | undefined> {
  return Object.entries(sources ?? {}).flatMap(([name, source]) => {
    if (isSchemaMarkerKey(name)) return [];
    return [secretEnv(`${prefix}${name.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`, source)];
  });
}

function literalSecretValues(sources: Record<string, OryValueSource> | undefined): Record<string, unknown> | undefined {
  const entries = Object.entries(sources ?? {}).flatMap(([name, source]) => {
    if (isSchemaMarkerKey(name)) return [];
    return 'value' in source ? [[name, source.value] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function dependencyValueSource(
  source: OryDependencySource | undefined,
  fallbackName: string,
  fallbackKey: string
): OryValueSource | undefined {
  if (!source) return undefined;
  if (source.mode === 'external') return source.value;
  const externalSecretRef = (source as { value?: { secretRef?: OrySecretKeyRef } }).value?.secretRef;
  return {
    secretRef: {
      name: externalSecretRef?.name ?? source.secretName ?? source.resourceName ?? fallbackName,
      key: externalSecretRef?.key ?? source.secretKey ?? fallbackKey,
    },
  };
}

function dependencyUrl(source: OryDependencySource | undefined, fallbackUrl?: string): string | undefined {
  if (!source) return fallbackUrl;
  if (source.mode === 'external') return source.url ?? fallbackUrl;
  return source.url ?? fallbackUrl ?? (source.resourceName ? `http://${source.resourceName}` : undefined);
}

function hasPath(path: string): string {
  const parts = path.split('.');
  const guards: string[] = [];
  for (let index = 2; index < parts.length; index++) {
    guards.push(`has(${parts.slice(0, index + 1).join('.')})`);
  }
  return guards.join(' && ');
}

function graphUrl(
  sourcePath: string,
  explicitPath: string,
  fallbackExpression = 'omit()'
): string {
  const sourceUrlPath = `${sourcePath}.url`;
  const sourceNamePath = `${sourcePath}.resourceName`;
  return Cel.expr<string>(
    `${hasPath(sourceUrlPath)} ? ${sourceUrlPath} : ${hasPath(explicitPath)} ? ${explicitPath} : ${hasPath(sourceNamePath)} ? "http://" + string(${sourceNamePath}) : ${fallbackExpression}`
  ) as string;
}

function configUrl(
  explicit: string | undefined,
  source: OryDependencySource | undefined,
  fallbackUrl?: string,
  graph?: {
    sourcePath: string;
    explicitPath: string;
    fallbackExpression?: string;
  }
): string | undefined {
  if (graph && (isKubernetesRef(source?.url) || isKubernetesRef(source?.resourceName) || isKubernetesRef(explicit))) {
    return graphUrl(graph.sourcePath, graph.explicitPath, graph.fallbackExpression);
  }
  const resolvedSource = dependencyUrl(source, fallbackUrl);
  return isKubernetesRef(explicit) ? resolvedSource ?? explicit : explicit ?? resolvedSource;
}

function kratosPublicServiceFallbackExpression(): string {
  return '"http://" + string(schema.spec.name) + "-kratos-public." + string(has(schema.spec.namespace) ? schema.spec.namespace : "ory-system") + ".svc.cluster.local"';
}

function resolveConfig(config: OryIdentityStackConfig): OryIdentityStackConfig {
  const name = config.name;
  const sources = config.dependencySources;
  const hydraDsn = hasValueSource(config.hydra?.dsn)
    ? config.hydra?.dsn
    : dependencyValueSource(sources?.hydra?.database?.dsn, `${name}-hydra-db`, 'dsn');
  const hydraSystemSecret = hasValueSource(config.hydra?.systemSecret)
    ? config.hydra?.systemSecret
    : dependencyValueSource(sources?.hydra?.systemSecret, `${name}-hydra-secrets`, 'system');
  const kratosDsn = hasValueSource(config.kratos?.dsn)
    ? config.kratos?.dsn
    : dependencyValueSource(sources?.kratos?.database?.dsn, `${name}-kratos-db`, 'dsn');
  const ketoDsn = hasValueSource(config.keto?.dsn)
    ? config.keto?.dsn
    : dependencyValueSource(sources?.keto?.database?.dsn, `${name}-keto-db`, 'dsn');
  const oathkeeperJwks = hasValueSource(config.oathkeeper?.mutatorIdTokenJwks)
    ? config.oathkeeper?.mutatorIdTokenJwks
    : dependencyValueSource(
        sources?.oathkeeper?.mutatorIdTokenJwks,
        `${name}-oathkeeper-secrets`,
        'jwks'
      );
  const kratosSecretSources = sources?.kratos?.secrets;
  const kratosSecrets = {
    ...Object.fromEntries(
      Object.entries(kratosSecretSources ?? {}).flatMap(([key, source]) => {
        const resolved = dependencyValueSource(source, `${name}-kratos-secrets`, key);
        return resolved ? [[key, resolved] as const] : [];
      })
    ),
    ...(config.kratos?.secrets ?? {}),
  };

  return {
    ...config,
    hydra: compact({
      ...(config.hydra ?? {}),
      dsn: hydraDsn,
      systemSecret: hydraSystemSecret,
      issuerUrl: configUrl(config.hydra?.issuerUrl, sources?.hydra?.issuerUrl?.url, undefined, {
        sourcePath: 'schema.spec.dependencySources.hydra.issuerUrl.url',
        explicitPath: 'schema.spec.hydra.issuerUrl',
      }),
      loginUrl: configUrl(config.hydra?.loginUrl, sources?.hydra?.loginUrl?.url, undefined, {
        sourcePath: 'schema.spec.dependencySources.hydra.loginUrl.url',
        explicitPath: 'schema.spec.hydra.loginUrl',
      }),
      consentUrl: configUrl(config.hydra?.consentUrl, sources?.hydra?.consentUrl?.url, undefined, {
        sourcePath: 'schema.spec.dependencySources.hydra.consentUrl.url',
        explicitPath: 'schema.spec.hydra.consentUrl',
      }),
      logoutUrl: configUrl(config.hydra?.logoutUrl, sources?.hydra?.logoutUrl?.url, undefined, {
        sourcePath: 'schema.spec.dependencySources.hydra.logoutUrl.url',
        explicitPath: 'schema.spec.hydra.logoutUrl',
      }),
    }),
    kratos: compact({
      ...(config.kratos ?? {}),
      dsn: kratosDsn,
      publicBaseUrl: configUrl(
        config.kratos?.publicBaseUrl,
        sources?.kratos?.publicBaseUrl?.url,
        `http://${name}-kratos-public.${config.namespace ?? 'ory-system'}.svc.cluster.local`,
        {
          sourcePath: 'schema.spec.dependencySources.kratos.publicBaseUrl.url',
          explicitPath: 'schema.spec.kratos.publicBaseUrl',
          fallbackExpression: kratosPublicServiceFallbackExpression(),
        }
      ),
      browserBaseUrl: configUrl(
        config.kratos?.browserBaseUrl,
        sources?.kratos?.browserBaseUrl?.url,
        `http://${name}-kratos-public.${config.namespace ?? 'ory-system'}.svc.cluster.local`,
        {
          sourcePath: 'schema.spec.dependencySources.kratos.browserBaseUrl.url',
          explicitPath: 'schema.spec.kratos.browserBaseUrl',
          fallbackExpression: kratosPublicServiceFallbackExpression(),
        }
      ),
      secrets: Object.keys(kratosSecrets).length > 0 ? kratosSecrets : config.kratos?.secrets,
    }),
    keto: compact({
      ...(config.keto ?? {}),
      dsn: ketoDsn,
    }),
    oathkeeper: compact({
      ...(config.oathkeeper ?? {}),
      managedAccessRules: config.oathkeeper?.managedAccessRules ?? true,
      mutatorIdTokenJwks: oathkeeperJwks,
    }),
  };
}

class OryConfigurationErrorImpl extends TypeKroError {
  constructor(message: string, issues: OryConfigValidationResult['issues']) {
    super(message, issues[0]?.code ?? 'ORY_INVALID_HELM_VALUES', {
      issues,
    });
    this.name = 'OryConfigurationError';
  }
}

function configurationError(message: string, issues: OryConfigValidationResult['issues']): TypeKroError {
  return new OryConfigurationErrorImpl(message, issues);
}

function unsafeProductionError(path: string, message: string): TypeKroError {
  return configurationError(message, [{ code: 'ORY_UNSAFE_PRODUCTION_VALUE', path, message }]);
}

function explicitLiteralValues(config: OryIdentityStackConfig): Set<string> {
  const sources = [
    config.hydra?.dsn,
    config.hydra?.systemSecret,
    config.kratos?.dsn,
    ...Object.values(config.kratos?.secrets ?? {}),
    config.keto?.dsn,
    config.oathkeeper?.mutatorIdTokenJwks,
  ];
  return new Set(sources.flatMap((source) => (source && 'value' in source ? [source.value] : [])));
}

function findUnsafeLiteral(value: unknown, allowedLiterals: Set<string>, path = ''): string | undefined {
  if (typeof value === 'string' && /postgres:\/\/|mysql:\/\/|cockroach:\/\//i.test(value)) {
    return allowedLiterals.has(value) ? undefined : path;
  }
  if (!value || typeof value !== 'object') return undefined;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const unsafePath = findUnsafeLiteral(item, allowedLiterals, `${path}[${index}]`);
      if (unsafePath) return unsafePath;
    }
    return undefined;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (/dsn|secret|password|jwks/i.test(key) && typeof child === 'string' && !allowedLiterals.has(child)) return childPath;
    const unsafePath = findUnsafeLiteral(child, allowedLiterals, childPath);
    if (unsafePath) return unsafePath;
  }

  return undefined;
}

function assertProductionSafe(config: OryIdentityStackConfig, values: OryMappedHelmValues): void {
  if (isKubernetesRef(config.name)) return;

  const hydraManagedDatabase = config.dependencySources?.hydra?.database?.dsn.mode === 'managed';
  const kratosManagedDatabase = config.dependencySources?.kratos?.database?.dsn.mode === 'managed';
  if (!hydraManagedDatabase && values.hydra.hydra?.dev === true) {
    throw unsafeProductionError('hydra.hydra.dev', 'ORY_UNSAFE_PRODUCTION_VALUE: hydra dev mode is not allowed in production');
  }
  if (!kratosManagedDatabase && values.kratos.kratos?.development === true) {
    throw unsafeProductionError(
      'kratos.kratos.development',
      'ORY_UNSAFE_PRODUCTION_VALUE: kratos development mode is not allowed in production'
    );
  }

  const unsafePath = findUnsafeLiteral(values, explicitLiteralValues(config));
  if (unsafePath) {
    throw unsafeProductionError(
      unsafePath,
      `ORY_UNSAFE_PRODUCTION_VALUE: literal sensitive value is not allowed at ${unsafePath}`
    );
  }
}

export const validateOryConfig = (config: OryIdentityStackConfig): OryConfigValidationResult => {
  const resolvedConfig = resolveConfig(config);
  const issues: OryConfigValidationResult['issues'] = [];

  if (isKubernetesRef(resolvedConfig.name)) {
    return { valid: true, issues };
  }

  if (!hasValueSource(resolvedConfig.hydra?.dsn)) {
    issues.push({ code: 'ORY_UNRESOLVED_DEPENDENCY_SOURCE', path: 'hydra.dsn', message: 'Hydra DSN source is required', component: 'hydra' });
  }
  if (!hasValueSource(resolvedConfig.kratos?.dsn)) {
    issues.push({ code: 'ORY_UNRESOLVED_DEPENDENCY_SOURCE', path: 'kratos.dsn', message: 'Kratos DSN source is required', component: 'kratos' });
  }
  if (!hasValueSource(resolvedConfig.keto?.dsn)) {
    issues.push({ code: 'ORY_UNRESOLVED_DEPENDENCY_SOURCE', path: 'keto.dsn', message: 'Keto DSN source is required', component: 'keto' });
  }
  if (!hasValueSource(resolvedConfig.hydra?.systemSecret)) {
    issues.push({ code: 'ORY_UNRESOLVED_DEPENDENCY_SOURCE', path: 'hydra.systemSecret', message: 'Hydra system Secret source is required', component: 'hydra' });
  }
  for (const key of ['cookie', 'cipher'] as const) {
    if (!hasValueSource(resolvedConfig.kratos?.secrets?.[key])) {
      issues.push({ code: 'ORY_UNRESOLVED_DEPENDENCY_SOURCE', path: `kratos.secrets.${key}`, message: `Kratos ${key} Secret source is required`, component: 'kratos' });
    }
  }

  return { valid: issues.length === 0, issues };
};

export const mapOryConfigToHelmValues: OryHelmValuesMapper = (config) => {
  const resolvedConfig = resolveConfig(config);
  const validation = validateOryConfig(resolvedConfig);
  if (!validation.valid) {
    throw configurationError('Ory production configuration is incomplete', validation.issues);
  }

  const hydraEnv = [secretEnv('DSN', resolvedConfig.hydra?.dsn), secretEnv('SECRETS_SYSTEM', resolvedConfig.hydra?.systemSecret)];
  const kratosEnv = [secretEnv('DSN', resolvedConfig.kratos?.dsn), ...namedSecretEnvs('SECRETS_', resolvedConfig.kratos?.secrets)];
  const ketoEnv = [secretEnv('DSN', resolvedConfig.keto?.dsn)];
  const globalValues = sharedGlobal(resolvedConfig);

  const values: OryMappedHelmValues = {
    hydra: mergeValues<OryHydraChartValues>(
      compact<OryHydraChartValues>({
        ...globalValues,
        replicaCount: resolvedConfig.hydra?.replicaCount,
        hydra: compact({
          dev:
            resolvedConfig.dependencySources?.hydra?.database?.dsn.mode === 'managed' ||
            !!resolvedConfig.hydra?.values?.hydra?.dev,
          config: compact({
            dsn: secretValue(resolvedConfig.hydra?.dsn),
            secrets: compact({ system: secretValue(resolvedConfig.hydra?.systemSecret) }),
            urls: hydraUrls(resolvedConfig.hydra),
          }),
          automigration: automigrationEnv(hydraEnv),
        }),
        ...deploymentTargets(hydraEnv, resolvedConfig.hydra?.resources),
        ...jobTargets(hydraEnv),
        maester: { enabled: resolvedConfig.maester?.hydra?.enabled ?? true },
        serviceMonitor: resolvedConfig.hydra?.serviceMonitor,
      }),
      resolvedConfig.hydra?.values,
      resolvedConfig.hydra?.customValues,
      resolvedConfig.customValues?.hydra
    ),
    kratos: mergeValues<OryKratosChartValues>(
      compact<OryKratosChartValues>({
        ...globalValues,
        replicaCount: resolvedConfig.kratos?.replicaCount,
        kratos: compact({
          development:
            resolvedConfig.dependencySources?.kratos?.database?.dsn.mode === 'managed' ||
            !!resolvedConfig.kratos?.values?.kratos?.development,
          identitySchemas: kratosIdentitySchemas(resolvedConfig.kratos),
          config: kratosConfig(resolvedConfig.kratos),
          automigration: automigrationEnv(kratosEnv),
        }),
        ...deploymentTargets(kratosEnv, resolvedConfig.kratos?.resources),
        ...statefulSetTargets(kratosEnv, resolvedConfig.kratos?.resources),
        ...jobTargets(kratosEnv),
        serviceMonitor: resolvedConfig.kratos?.serviceMonitor,
      }),
      resolvedConfig.kratos?.values,
      resolvedConfig.kratos?.customValues,
      resolvedConfig.customValues?.kratos
    ),
    keto: mergeValues<OryKetoChartValues>(
      compact<OryKetoChartValues>({
        ...globalValues,
        replicaCount: resolvedConfig.keto?.replicaCount,
        keto: {
          config: { dsn: secretValue(resolvedConfig.keto?.dsn), namespaces: ketoNamespaces(resolvedConfig.keto) },
          automigration: automigrationEnv(ketoEnv),
        },
        ...deploymentTargets(ketoEnv, resolvedConfig.keto?.resources),
        ...jobTargets(ketoEnv),
        serviceMonitor: resolvedConfig.keto?.serviceMonitor,
      }),
      resolvedConfig.keto?.values,
      resolvedConfig.keto?.customValues,
      resolvedConfig.customValues?.keto
    ),
    oathkeeper: mergeValues<OryOathkeeperChartValues>(
      compact<OryOathkeeperChartValues>({
        ...globalValues,
        oathkeeper: compact({ managedAccessRules: resolvedConfig.oathkeeper?.managedAccessRules ?? true, mutatorIdTokenJWKs: stringValue(resolvedConfig.oathkeeper?.mutatorIdTokenJwks) }),
        ...deploymentTargets(secretEnv('OATHKEEPER_MUTATOR_ID_TOKEN_JWKS', resolvedConfig.oathkeeper?.mutatorIdTokenJwks), resolvedConfig.oathkeeper?.resources),
        maester: { enabled: resolvedConfig.maester?.oathkeeper?.enabled ?? true },
        serviceMonitor: resolvedConfig.oathkeeper?.serviceMonitor,
      }),
      resolvedConfig.oathkeeper?.values,
      resolvedConfig.oathkeeper?.customValues,
      resolvedConfig.customValues?.oathkeeper
    ),
    hydraMaester: compact<OryHydraMaesterChartValues>({
      ...(resolvedConfig.maester?.hydraValues ?? {}),
      singleNamespaceMode: resolvedConfig.maester?.hydra?.singleNamespaceMode ?? true,
      enabledNamespaces: resolvedConfig.maester?.hydra?.enabledNamespaces,
      serviceMonitor: resolvedConfig.maester?.hydra?.serviceMonitor,
    }),
    oathkeeperMaester: compact<OryOathkeeperMaesterChartValues>({
      ...(resolvedConfig.maester?.oathkeeperValues ?? {}),
      singleNamespaceMode: resolvedConfig.maester?.oathkeeper?.singleNamespaceMode ?? true,
      rulesConfigmapNamespace: resolvedConfig.maester?.oathkeeper?.rulesConfigmapNamespace,
      rulesFileName: resolvedConfig.maester?.oathkeeper?.rulesFileName,
    }),
  };

  assertProductionSafe(resolvedConfig, values);
  return values;
};

export const getOryHelmValueWarnings = (config: OryIdentityStackConfig): OryHelmValueWarning[] => {
  const warnings: OryHelmValueWarning[] = [];
  if ((config.hydra?.replicaCount ?? 2) < 2) {
    warnings.push({ path: 'hydra.replicaCount', message: 'Hydra should run at least two replicas in production', component: 'hydra' });
  }
  return warnings;
};

export const getOryHealthChecks = (config: OryIdentityStackConfig): OryHealthCheckStatus[] => {
  const valid = validateOryConfig(config).valid;
  const maesterHydra = config.maester?.hydra?.enabled !== false;
  const maesterOathkeeper = config.maester?.oathkeeper?.enabled !== false;
  return [
    { name: 'helmRepositoryReady', component: 'hydra', healthy: true, resourceName: 'ory' },
    { name: 'hydraReady', component: 'hydra', healthy: valid },
    { name: 'kratosReady', component: 'kratos', healthy: valid },
    { name: 'ketoReady', component: 'keto', healthy: valid },
    { name: 'oathkeeperReady', component: 'oathkeeper', healthy: true },
    { name: 'hydraMaesterReady', component: 'hydra', healthy: maesterHydra },
    { name: 'oathkeeperMaesterReady', component: 'oathkeeper', healthy: maesterOathkeeper },
    { name: 'oauth2ClientReconciled', component: 'hydra', healthy: maesterHydra },
    { name: 'oathkeeperRuleValidated', component: 'oathkeeper', healthy: maesterOathkeeper },
  ];
};

export const getOryMetricSignals = (config: OryIdentityStackConfig): OryMetricSignal[] => [
  { name: 'serviceMonitorEnabled', component: 'hydra', enabled: config.hydra?.serviceMonitor?.enabled === true },
  { name: 'serviceMonitorEnabled', component: 'kratos', enabled: config.kratos?.serviceMonitor?.enabled === true },
  { name: 'serviceMonitorEnabled', component: 'keto', enabled: config.keto?.serviceMonitor?.enabled === true },
  { name: 'serviceMonitorEnabled', component: 'oathkeeper', enabled: config.oathkeeper?.serviceMonitor?.enabled === true },
  { name: 'maesterMetricsConfigured', component: 'hydra', enabled: config.maester?.hydra?.serviceMonitor?.enabled === true },
  { name: 'maesterMetricsConfigured', component: 'oathkeeper', enabled: config.maester?.oathkeeper?.enabled === true },
];
