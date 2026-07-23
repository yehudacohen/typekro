/**
 * Shared Deployment Utilities
 *
 * This module provides common utilities used across all deployment modes
 * to eliminate code duplication and ensure consistent behavior.
 */

import type { KubeConfig } from '@kubernetes/client-node';
import type { SerializableKubeConfigOptions } from '../../alchemy/types.js';
import { ResourceGraphFactoryError, TypeKroError, ValidationError } from '../errors.js';
import type {
  DurableKubeConfigOptions,
  KubeConfigCredentialBindings,
  KubernetesClientConfig,
} from '../kubernetes/client-provider.js';
import type { DeploymentOptions, FactoryOptions } from '../types/deployment.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { KroCompatibleType, SchemaDefinition } from '../types/serialization.js';

/**
 * Serialize a live `KubeConfig` into the cloneable {@link SerializableKubeConfigOptions} that an
 * alchemy resource persists in state and uses to reconnect to the cluster after rehydration (the
 * ambient kubeconfig isn't available on a later reconcile). Captures the current cluster + user,
 * including `exec`/`authProvider` blocks (e.g. `aws eks get-token`).
 *
 * Static credentials never cross this boundary as plaintext. Durable hosts must either re-read a
 * default/file kubeconfig or receive named environment bindings for every detected credential.
 */
export function extractSerializableKubeConfigOptions(
  kc: KubeConfig | undefined,
  options: {
    readonly skipTLSVerifyOverride?: boolean;
    readonly persistence?: DurableKubeConfigOptions;
  } = {}
): SerializableKubeConfigOptions {
  const cluster = kc?.getCurrentCluster();
  const user = kc && typeof kc.getCurrentUser === 'function' ? kc.getCurrentUser() : undefined;
  const context = kc && typeof kc.getCurrentContext === 'function' ? kc.getCurrentContext() : undefined;
  const finalSkipTLS =
    options.skipTLSVerifyOverride === true ? true : (cluster?.skipTLSVerify ?? false);

  if (options.persistence?.source) {
    const source = options.persistence.source;
    if (Object.keys(options.persistence.credentialBindings ?? {}).length > 0) {
      throw new TypeKroError(
        'Durable kubeconfig must use either a re-readable source or credential bindings, not both.',
        'KUBECONFIG_DURABLE_SOURCE_INVALID',
        { sourceKind: source.kind }
      );
    }
    if (source.kind === 'file' && source.path.trim().length === 0) {
      throw new TypeKroError(
        'Durable kubeconfig file source must provide a non-empty path.',
        'KUBECONFIG_DURABLE_SOURCE_INVALID',
        { sourceKind: source.kind }
      );
    }
    return {
      loadFromDefault: true,
      ...(source.kind === 'file' ? { kubeconfigPath: source.path } : {}),
      ...(context ? { context } : {}),
      skipTLSVerify: finalSkipTLS,
    };
  }

  if (!kc) {
    throw new TypeKroError(
      'A concrete kubeconfig is required unless durable state uses a default or file source.',
      'KUBECONFIG_DURABLE_SOURCE_REQUIRED'
    );
  }

  const serialized = {
    skipTLSVerify: finalSkipTLS,
    ...(cluster?.server && { server: cluster.server }),
    ...(context && { context }),
    ...(cluster && {
      cluster: {
        name: cluster.name,
        server: cluster.server,
        skipTLSVerify: finalSkipTLS,
        ...(cluster.caData && { caData: cluster.caData }),
        ...(cluster.caFile && { caFile: cluster.caFile }),
      },
    }),
    ...(user && {
      user: {
        name: user.name,
        ...(user.token && { token: user.token }),
        ...(user.certData && { certData: user.certData }),
        ...(user.certFile && { certFile: user.certFile }),
        ...(user.keyData && { keyData: user.keyData }),
        ...(user.keyFile && { keyFile: user.keyFile }),
        ...((user as { exec?: object }).exec ? { exec: (user as { exec?: object }).exec } : {}),
        ...((user as { authProvider?: object }).authProvider
          ? { authProvider: (user as { authProvider?: object }).authProvider }
          : {}),
      },
    }),
  } as SerializableKubeConfigOptions;

  return bindSerializableKubeConfigCredentials(
    serialized,
    options.persistence?.credentialBindings ?? {}
  );
}

const SENSITIVE_CREDENTIAL_KEY =
  /(?:token|secret|password|credential|private[-_]?key|client[-_]?key|cert(?:ificate)?[-_]?data|key[-_]?data)$/i;
const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|CLIENT_KEY|ACCESS_KEY|CERT(?:IFICATE)?(?:_DATA)?|KEY_DATA)(?:_|$)/;
const SENSITIVE_EXEC_ARGUMENT =
  /^--?(?:token|password|client-secret|client-key|private-key|access-key|credentials?)(?:=|$)/i;

function pointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/')) {
    throw new TypeKroError(
      `Kubeconfig credential binding path must be a JSON pointer: ${pointer}`,
      'KUBECONFIG_CREDENTIAL_BINDING_INVALID',
      { path: pointer }
    );
  }
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function collectSensitiveCredentialPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    const paths = value.flatMap((entry, index) =>
      collectSensitiveCredentialPaths(entry, `${path}/${index}`)
    );
    if (path.endsWith('/exec/args')) {
      for (let index = 0; index < value.length; index++) {
        const argument = value[index];
        if (typeof argument !== 'string' || !SENSITIVE_EXEC_ARGUMENT.test(argument)) continue;
        if (argument.includes('=')) paths.push(`${path}/${index}`);
        else if (index + 1 < value.length) paths.push(`${path}/${index + 1}`);
      }
    }
    return [...new Set(paths)];
  }
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  return Object.entries(record).flatMap(([key, child]) => {
    const childPath = `${path}/${pointerSegment(key)}`;
    const envValue =
      key === 'value' && typeof record.name === 'string' && SENSITIVE_ENV_NAME.test(record.name);
    const sensitiveKey = SENSITIVE_CREDENTIAL_KEY.test(key);
    if ((envValue || sensitiveKey) && child !== undefined && child !== null) {
      return [childPath];
    }
    return collectSensitiveCredentialPaths(child, childPath);
  });
}

function deletePointer(root: Record<string, unknown>, pointer: string): void {
  const parts = pointerParts(pointer);
  const key = parts.pop();
  if (key === undefined) return;
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return;
    current = (current as Record<string, unknown>)[part];
  }
  if (current && typeof current === 'object') {
    if (Array.isArray(current)) delete current[Number(key)];
    else delete (current as Record<string, unknown>)[key];
  }
}

function setPointer(root: Record<string, unknown>, pointer: string, value: string): void {
  const parts = pointerParts(pointer);
  const key = parts.pop();
  if (key === undefined) return;
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object') {
      throw new TypeKroError(
        `Kubeconfig credential binding path does not exist: ${pointer}`,
        'KUBECONFIG_CREDENTIAL_BINDING_INVALID',
        { path: pointer }
      );
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (!current || typeof current !== 'object') {
    throw new TypeKroError(
      `Kubeconfig credential binding path does not exist: ${pointer}`,
      'KUBECONFIG_CREDENTIAL_BINDING_INVALID',
      { path: pointer }
    );
  }
  (current as Record<string, unknown>)[key] = value;
}

function validateCredentialBinding(
  path: string,
  binding: KubeConfigCredentialBindings[string]
): void {
  pointerParts(path);
  if (binding.kind !== 'environment' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.name)) {
    throw new TypeKroError(
      `Kubeconfig credential binding for ${path} must name a valid environment variable.`,
      'KUBECONFIG_CREDENTIAL_BINDING_INVALID',
      { path, bindingKind: binding.kind }
    );
  }
}

/** Remove detected credentials and retain only host binding identities. */
export function bindSerializableKubeConfigCredentials(
  config: SerializableKubeConfigOptions,
  bindings: KubeConfigCredentialBindings
): SerializableKubeConfigOptions {
  const safe = cloneConfig(config) as SerializableKubeConfigOptions & Record<string, unknown>;
  delete safe.credentialBindings;
  const sensitivePaths = collectSensitiveCredentialPaths(safe.user, '/user');
  const missing = sensitivePaths.filter((path) => bindings[path] === undefined);
  if (missing.length > 0) {
    throw new TypeKroError(
      `Durable kubeconfig contains static credentials without host bindings: ${missing.join(', ')}.`,
      'KUBECONFIG_STATIC_CREDENTIALS_UNBOUND',
      { paths: missing }
    );
  }

  const unused = Object.keys(bindings).filter((path) => !sensitivePaths.includes(path));
  if (unused.length > 0) {
    throw new TypeKroError(
      `Kubeconfig credential bindings do not match detected credential fields: ${unused.join(', ')}.`,
      'KUBECONFIG_CREDENTIAL_BINDING_UNUSED',
      { paths: unused }
    );
  }

  const selectedBindings: Record<
    string,
    NonNullable<KubeConfigCredentialBindings[string]>
  > = {};
  for (const path of sensitivePaths) {
    const binding = bindings[path];
    if (binding === undefined) {
      throw new TypeKroError(
        `Durable kubeconfig contains a static credential without a host binding: ${path}.`,
        'KUBECONFIG_STATIC_CREDENTIALS_UNBOUND',
        { paths: [path] }
      );
    }
    validateCredentialBinding(path, binding);
    selectedBindings[path] = binding;
    deletePointer(safe, path);
  }
  return {
    ...safe,
    ...(sensitivePaths.length > 0
      ? {
          credentialBindings: selectedBindings,
        }
      : {}),
  };
}

/** Resolve durable kubeconfig bindings inside the operation host. */
export function materializeSerializableKubeConfigOptions(
  config: SerializableKubeConfigOptions
): KubernetesClientConfig {
  const materialized = cloneConfig(config) as SerializableKubeConfigOptions &
    Record<string, unknown>;
  const bindings = materialized.credentialBindings ?? {};
  delete materialized.credentialBindings;

  const inline = collectSensitiveCredentialPaths(materialized.user, '/user');
  if (inline.length > 0) {
    throw new TypeKroError(
      `Durable kubeconfig options contain inline credential material: ${inline.join(', ')}.`,
      'KUBECONFIG_INLINE_CREDENTIALS_FORBIDDEN',
      { paths: inline }
    );
  }

  for (const [path, binding] of Object.entries(bindings)) {
    validateCredentialBinding(path, binding);
    const value = process.env[binding.name];
    if (value === undefined) {
      throw new TypeKroError(
        `Kubeconfig credential binding ${path} could not resolve environment variable ${binding.name}.`,
        'KUBECONFIG_CREDENTIAL_BINDING_UNRESOLVED',
        { path, environmentVariable: binding.name }
      );
    }
    setPointer(materialized, path, value);
  }

  return materialized as KubernetesClientConfig;
}

/**
 * Common spec validation logic used by all factories.
 *
 * @param spec - The spec to validate
 * @param schemaDefinition - The schema definition to validate against
 * @param context - Optional context for more informative error messages
 * @param context.kind - The Kubernetes kind (e.g. 'WebApp')
 * @param context.name - The resource name (e.g. 'my-webapp')
 */
export function validateSpec<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  spec: TSpec,
  schemaDefinition: SchemaDefinition<TSpec, TStatus>,
  context?: { kind?: string; name?: string }
): void {
  const validationResult = schemaDefinition.spec(spec) as unknown;
  const validationMessage =
    validationResult instanceof Error
      ? validationResult.message
      : validationResult &&
          typeof validationResult === 'object' &&
          (validationResult as { ' arkKind'?: unknown })[' arkKind'] === 'errors'
        ? ((validationResult as { summary?: string; message?: string }).message ??
          (validationResult as { summary?: string; message?: string }).summary ??
          String(validationResult))
        : null;

  if (validationMessage) {
    throw new ValidationError(
      `Invalid spec: ${validationMessage}`,
      context?.kind ?? 'Unknown',
      context?.name ?? 'unknown',
      'spec',
      context ? ['Check the spec against the schema definition'] : undefined
    );
  }
}

/**
 * Generate deployment options from factory options
 */
export function createDeploymentOptions(
  factoryOptions: FactoryOptions,
  namespace: string,
  mode: 'direct' | 'kro' | 'alchemy' = 'direct'
): DeploymentOptions {
  return {
    mode,
    namespace,
    ...(factoryOptions.timeout && { timeout: factoryOptions.timeout }),
    waitForReady: factoryOptions.waitForReady ?? true,
    hydrateStatus: factoryOptions.hydrateStatus ?? true,
    ...(factoryOptions.retryPolicy && { retryPolicy: factoryOptions.retryPolicy }),
    ...(factoryOptions.progressCallback && { progressCallback: factoryOptions.progressCallback }),
    ...(factoryOptions.eventMonitoring && { eventMonitoring: factoryOptions.eventMonitoring }),
    ...(factoryOptions.debugLogging && { debugLogging: factoryOptions.debugLogging }),
    ...(factoryOptions.autoFix && { autoFix: factoryOptions.autoFix }),
  };
}

/**
 * Generate instance name from spec by checking common name fields.
 *
 * @param spec - The spec object to extract a name from
 * @param fallbackPrefix - Optional prefix for the fallback name (default: 'instance')
 * @returns The extracted or generated instance name
 */
export function generateInstanceName<TSpec>(spec: TSpec, fallbackPrefix = 'instance'): string {
  // Try to extract name from spec - check common name fields
  if (typeof spec === 'object' && spec !== null) {
    const specObj = spec as Record<string, unknown>;

    // Check for common name fields in order of preference
    for (const nameField of ['name', 'appName', 'serviceName', 'resourceName']) {
      if (nameField in specObj && specObj[nameField]) {
        return String(specObj[nameField]);
      }
    }
  }

  // Generate a unique name
  return `${fallbackPrefix}-${Date.now()}`;
}

/**
 * Singleton owner boundaries must use the stable singleton id as the CR name.
 * This keeps owner creation and singleton.use() references aligned even when
 * the singleton spec contains a user-facing `name` field with a different value.
 */
export function getSingletonInstanceName(id: string): string {
  if (!id || typeof id !== 'string') {
    throw new ValidationError(
      `Invalid singleton id: ${JSON.stringify(id)}. Singleton ids must be non-empty strings.`,
      'Singleton',
      String(id),
      'id',
      ['Provide a non-empty singleton id']
    );
  }

  const normalized = id
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  if (!normalized) {
    throw new ValidationError(
      `Invalid singleton id: ${JSON.stringify(id)}. Singleton ids must contain at least one alphanumeric character.`,
      'Singleton',
      id,
      'id',
      ['Use letters or numbers in the singleton id']
    );
  }

  return convertToKubernetesName(normalized);
}

/**
 * Create Enhanced proxy metadata
 */
export function createEnhancedMetadata(
  instanceName: string,
  namespace: string,
  factoryName: string,
  mode: 'direct' | 'kro'
): Enhanced<unknown, unknown>['metadata'] {
  return {
    name: instanceName,
    namespace,
    labels: {
      'typekro.io/factory': factoryName,
      'typekro.io/mode': mode,
    },
    annotations: {
      'typekro.io/deployed-at': new Date().toISOString(),
    },
  } as unknown as Enhanced<unknown, unknown>['metadata'];
}

/**
 * Common error handling for deployment failures
 */
export function handleDeploymentError(error: unknown, context: string): never {
  if (error instanceof Error) {
    throw new ResourceGraphFactoryError(
      `${context}: ${error.message}`,
      context,
      'deployment',
      error
    );
  }
  throw new ResourceGraphFactoryError(`${context}: ${String(error)}`, context, 'deployment');
}

/**
 * Convert a camelCase or PascalCase name to a valid Kubernetes resource name (kebab-case).
 *
 * Validates the result against Kubernetes naming rules:
 * - Lowercase alphanumeric characters or '-'
 * - Must start and end with an alphanumeric character
 * - Maximum 253 characters
 *
 * @param name - The name to convert (e.g. 'myWebApp' → 'my-web-app')
 * @returns A valid Kubernetes resource name in kebab-case
 * @throws ValidationError if the input is empty or the result is not a valid Kubernetes name
 */
export function convertToKubernetesName(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new ValidationError(
      `Invalid resource name: ${JSON.stringify(name)}. Name must be a non-empty string.`,
      'KubernetesResource',
      String(name),
      'name',
      ['Provide a non-empty string for the resource name']
    );
  }

  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new ValidationError(
      'Invalid resource name: Name cannot be empty or whitespace-only.',
      'KubernetesResource',
      name,
      'name',
      ['Provide a non-whitespace resource name']
    );
  }

  // Convert to kebab-case and validate result
  const kubernetesName = trimmedName
    .replace(/([a-z])([A-Z])/g, '$1-$2') // Insert dash before capital letters
    .toLowerCase();

  // Validate Kubernetes naming conventions
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(kubernetesName)) {
    throw new ValidationError(
      `Invalid resource name: "${name}" converts to "${kubernetesName}" which is not a valid Kubernetes resource name. Names must consist of lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character.`,
      'KubernetesResource',
      name,
      'name',
      [
        'Use lowercase alphanumeric characters and hyphens only',
        'Must start and end with an alphanumeric character',
      ]
    );
  }

  if (kubernetesName.length > 253) {
    throw new ValidationError(
      `Invalid resource name: "${name}" converts to "${kubernetesName}" which exceeds the 253 character limit for Kubernetes resource names.`,
      'KubernetesResource',
      name,
      'name',
      ['Shorten the resource name to stay under 253 characters']
    );
  }

  return kubernetesName;
}

/**
 * Pluralize a Kubernetes Kind name following standard English pluralization rules.
 *
 * This is used to construct CRD resource names (e.g. `webapps.kro.run` from kind `WebApp`).
 * The function lowercases the kind before pluralizing.
 *
 * @param kind - The Kubernetes Kind to pluralize (e.g. 'Deployment' → 'deployments')
 * @returns The pluralized, lowercased kind name
 */
export function pluralizeKind(kind: string): string {
  const lowerKind = kind.toLowerCase();

  // Handle common English pluralization rules that Kubernetes follows
  if (
    lowerKind.endsWith('s') ||
    lowerKind.endsWith('sh') ||
    lowerKind.endsWith('ch') ||
    lowerKind.endsWith('x') ||
    lowerKind.endsWith('z')
  ) {
    return `${lowerKind}es`;
  } else if (lowerKind.endsWith('o')) {
    return `${lowerKind}es`;
  } else if (
    lowerKind.endsWith('y') &&
    lowerKind.length > 1 &&
    !'aeiou'.includes(lowerKind[lowerKind.length - 2] || '')
  ) {
    return `${lowerKind.slice(0, -1)}ies`;
  } else if (lowerKind.endsWith('f')) {
    return `${lowerKind.slice(0, -1)}ves`;
  } else if (lowerKind.endsWith('fe')) {
    return `${lowerKind.slice(0, -2)}ves`;
  } else {
    return `${lowerKind}s`;
  }
}
