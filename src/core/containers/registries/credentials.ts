import { Buffer } from 'node:buffer';

import {
  createKubernetesClientProvider,
  type KubernetesClientConfig,
} from '../../kubernetes/client-provider.js';
import { ContainerBuildError } from '../errors.js';
import type { OciRegistryCredential, OciRegistryCredentialProvider } from './types.js';

export interface KubernetesSecretRegistryCredentialOptions {
  namespace: string;
  name: string;
  /** Registry host used when resolving a kubernetes.io/dockerconfigjson entry. */
  registry?: string;
  usernameKey?: string;
  passwordKey?: string;
  dockerConfigJsonKey?: string;
  context?: string;
  kubeconfigPath?: string;
  /** Optional embedding/test seam. Production defaults to the selected Kubernetes client. */
  secretReader?: KubernetesRegistrySecretReader;
}

export type KubernetesRegistrySecretReader = (request: {
  readonly namespace: string;
  readonly name: string;
  readonly context?: string;
  readonly kubeconfigPath?: string;
}) => Promise<Readonly<Record<string, string>>>;

function decodeSecretValue(value: string | undefined, key: string): string {
  if (!value) {
    throw new ContainerBuildError(
      `Registry credential Secret is missing key "${key}".`,
      'REGISTRY_SECRET_INVALID',
      ['Verify the Secret name, namespace, and configured key names.']
    );
  }
  return Buffer.from(value, 'base64').toString('utf8');
}

function registryHost(value: string): string {
  const withScheme = value.includes('://') ? value : `https://${value}`;
  return new URL(withScheme).host;
}

function credentialFromDockerConfig(
  encodedConfig: string,
  registry: string | undefined
): OciRegistryCredential {
  const decoded = Buffer.from(encodedConfig, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded) as {
    auths?: Record<string, { auth?: string; username?: string; password?: string }>;
  };
  const entries = Object.entries(parsed.auths ?? {});
  const selected = registry
    ? entries.find(([name]) => registryHost(name) === registryHost(registry))
    : entries.length === 1
      ? entries[0]
      : undefined;
  if (!selected) {
    throw new ContainerBuildError(
      'Docker config Secret does not contain an unambiguous credential for the registry.',
      'REGISTRY_SECRET_INVALID',
      ['Set the registry option or use explicit usernameKey and passwordKey values.']
    );
  }
  const entry = selected[1];
  if (entry.username && entry.password) return entry as OciRegistryCredential;
  const auth = entry.auth ? Buffer.from(entry.auth, 'base64').toString('utf8') : '';
  const separator = auth.indexOf(':');
  if (separator <= 0) {
    throw new ContainerBuildError(
      'Docker config Secret credential is missing username/password material.',
      'REGISTRY_SECRET_INVALID'
    );
  }
  return { username: auth.slice(0, separator), password: auth.slice(separator + 1) };
}

/**
 * Resolve an OCI credential from a selected Kubernetes Secret at execution time.
 *
 * The returned closure retains only Secret coordinates; decoded values exist only during the
 * registry session and are never written to TypeKro state or generated resources.
 */
export function kubernetesSecretRegistryCredentials(
  options: KubernetesSecretRegistryCredentialOptions
): OciRegistryCredentialProvider {
  return async (signal) => {
    if (signal?.aborted) throw ContainerBuildError.cancelled();
    const request = {
      namespace: options.namespace,
      name: options.name,
      ...(options.context ? { context: options.context } : {}),
      ...(options.kubeconfigPath ? { kubeconfigPath: options.kubeconfigPath } : {}),
    };
    const data = options.secretReader
      ? await options.secretReader(request)
      : await readKubernetesSecret(request);
    if (signal?.aborted) throw ContainerBuildError.cancelled();
    const dockerConfigKey = options.dockerConfigJsonKey ?? '.dockerconfigjson';
    if (data[dockerConfigKey]) {
      return credentialFromDockerConfig(data[dockerConfigKey], options.registry);
    }
    const usernameKey = options.usernameKey ?? 'username';
    const passwordKey = options.passwordKey ?? 'password';
    return {
      username: decodeSecretValue(data[usernameKey], usernameKey),
      password: decodeSecretValue(data[passwordKey], passwordKey),
    };
  };
}

async function readKubernetesSecret(request: {
  readonly namespace: string;
  readonly name: string;
  readonly context?: string;
  readonly kubeconfigPath?: string;
}): Promise<Readonly<Record<string, string>>> {
  const config: KubernetesClientConfig = {
    ...(request.context ? { context: request.context } : {}),
    ...(request.kubeconfigPath ? { kubeconfigPath: request.kubeconfigPath } : {}),
  };
  const provider = createKubernetesClientProvider(config);
  const secret = await provider.getCoreV1Api().readNamespacedSecret({
    namespace: request.namespace,
    name: request.name,
  });
  return secret.data ?? {};
}
