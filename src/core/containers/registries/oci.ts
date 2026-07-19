import { ContainerBuildError } from '../errors.js';
import { createDockerRegistrySession } from './docker-session.js';
import type { OciRegistryConfig, RegistryHandler, RegistrySession } from './types.js';

export function normalizeRegistryHost(value: string): string {
  const parsed = new URL(value.includes('://') ? value : `https://${value}`);
  if (
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new ContainerBuildError(`Invalid OCI registry origin: "${value}".`, 'INVALID_REGISTRY', [
      'Provide only a registry origin or host. Put the project in repositoryPrefix.',
    ]);
  }
  return parsed.host;
}

function normalizeRepositoryPrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(normalized)) {
    throw new ContainerBuildError(
      `Invalid OCI repository prefix: "${value}".`,
      'INVALID_REGISTRY_PREFIX'
    );
  }
  return normalized;
}

export class OciRegistryHandler implements RegistryHandler {
  readonly registryHost: string;
  readonly repositoryPrefix: string | undefined;

  constructor(private readonly config: OciRegistryConfig) {
    this.registryHost = normalizeRegistryHost(config.registry);
    this.repositoryPrefix = normalizeRepositoryPrefix(config.repositoryPrefix);
    const explicitProtocol = config.registry
      .match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]
      ?.toLowerCase();
    if (config.tls?.plainHttp && explicitProtocol === 'https') {
      throw new ContainerBuildError(
        'OCI registry cannot use plainHttp with an https:// registry origin.',
        'INVALID_REGISTRY_TLS'
      );
    }
    if (explicitProtocol === 'http' && !config.tls?.plainHttp) {
      throw new ContainerBuildError(
        'OCI registry with an http:// origin must explicitly enable tls.plainHttp.',
        'INVALID_REGISTRY_TLS',
        ['Use HTTPS, or acknowledge a development-only HTTP registry with tls.plainHttp.']
      );
    }
    if (
      config.tls?.plainHttp &&
      (config.tls.caCertificate || config.tls.caFile || config.tls.insecure)
    ) {
      throw new ContainerBuildError(
        'OCI plainHttp cannot be combined with HTTPS CA or insecure-TLS options.',
        'INVALID_REGISTRY_TLS'
      );
    }
  }

  async resolveImageUri(imageName: string, tag: string): Promise<string> {
    const path = this.repositoryPrefix ? `${this.repositoryPrefix}/${imageName}` : imageName;
    return `${this.registryHost}/${path}:${tag}`;
  }

  async prepare(
    _imageName: string,
    timeout: number,
    signal?: AbortSignal
  ): Promise<RegistrySession> {
    return createDockerRegistrySession({
      registryHost: this.registryHost,
      timeout,
      ...(this.config.credentialProvider
        ? { credentialProvider: this.config.credentialProvider }
        : {}),
      ...(this.config.dockerConfigPath ? { dockerConfigPath: this.config.dockerConfigPath } : {}),
      ...(this.config.tls ? { tls: this.config.tls } : {}),
      ...(signal ? { signal } : {}),
    });
  }
}

/** Create a generic OCI registry config with inferred discriminant. */
export function ociRegistry(config: Omit<OciRegistryConfig, 'type'>): OciRegistryConfig {
  return { type: 'oci', ...config };
}
