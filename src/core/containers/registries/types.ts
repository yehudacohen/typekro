/** Container registry provider contracts and public build types. */

export interface OrbstackRegistryConfig {
  type: 'orbstack';
}

/**
 * ECR registry configuration.
 *
 * Credentials are resolved at execution time through the AWS SDK provider chain and are never
 * retained in a container declaration or emitted artifact.
 */
export interface EcrRegistryConfig {
  type: 'ecr';
  accountId?: string;
  region?: string;
  createRepository?: boolean;
  credentials?: import('@aws-sdk/credential-provider-node').DefaultProviderInit;
}

export interface GcrRegistryConfig {
  type: 'gcr';
  projectId: string;
}

export interface AcrRegistryConfig {
  type: 'acr';
  registryName: string;
}

/** Escape hatch for registry providers implemented outside TypeKro core. */
export interface CustomRegistryConfig {
  type: 'custom';
  handler: RegistryHandler;
}

/** A short-lived registry credential. Implementations must not log or persist these values. */
export interface OciRegistryCredential {
  readonly username: string;
  readonly password: string;
}

/** Resolve credentials only when a registry session is opened. */
export type OciRegistryCredentialProvider = (
  signal?: AbortSignal
) => Promise<OciRegistryCredential>;

export interface OciRegistryTlsConfig {
  /** PEM-encoded certificate authority. Public trust material, not a credential. */
  caCertificate?: string;
  /** Path to a certificate-authority file. */
  caFile?: string;
  /** Allow an HTTPS registry whose certificate cannot be verified. Development only. */
  insecure?: boolean;
  /** Use plain HTTP. Development only. */
  plainHttp?: boolean;
}

/** Generic OCI Distribution-compatible registry configuration. */
export interface OciRegistryConfig {
  type: 'oci';
  /** Registry origin or host, for example `https://registry.example.com` or `localhost:5000`. */
  registry: string;
  /** Repository prefix/project prepended to every image name. */
  repositoryPrefix?: string;
  /** Resolve a username/password only for the duration of the build. */
  credentialProvider?: OciRegistryCredentialProvider;
  /**
   * Existing Docker config.json to discover credentials from. Defaults to DOCKER_CONFIG or
   * `~/.docker/config.json`. The file is copied into an isolated temporary session.
   */
  dockerConfigPath?: string;
  tls?: OciRegistryTlsConfig;
}

/** Input accepted by the Harbor convenience helper. The resulting transport is generic OCI. */
export interface HarborRegistryConfig extends Omit<OciRegistryConfig, 'type' | 'repositoryPrefix'> {
  project: string;
}

export type RegistryConfig =
  | OrbstackRegistryConfig
  | EcrRegistryConfig
  | OciRegistryConfig
  | GcrRegistryConfig
  | AcrRegistryConfig
  | CustomRegistryConfig;

export type ContainerBuildProgress = 'auto' | 'plain' | 'tty' | 'rawjson';

export interface ContainerBuildOptions {
  context: string;
  dockerfile?: string;
  imageName: string;
  tag?: string;
  /**
   * How to handle a remote tag that already resolves in the registry.
   *
   * `adopt` skips the build and returns the registry-verified immutable
   * digest. It requires an explicit tag derived from the complete build input
   * and a registry that enforces immutability. TypeKro's built-in
   * `content-hash` is intentionally rejected because it does not cover build
   * arguments, targets, platforms, extra Docker arguments, or all filesystem
   * metadata. The default `replace` preserves ordinary mutable-tag behavior.
   */
  existingTagPolicy?: 'replace' | 'adopt';
  /** Build one target platform. Mutually exclusive with `platforms`. */
  platform?: string;
  /** Build and publish a multi-platform manifest with Buildx. */
  platforms?: readonly string[];
  buildArgs?: Record<string, string>;
  target?: string;
  quiet?: boolean;
  progress?: ContainerBuildProgress;
  timeout?: number;
  /** Cancel the build, authentication, push, and digest verification as one operation. */
  signal?: AbortSignal;
  extraDockerArgs?: string[];
  registry: RegistryConfig;
}

export interface ContainerBuildResult {
  /** Immutable digest URI for remote registries, otherwise the local tagged URI. */
  imageUri: string;
  /** Human-readable tagged URI retained for inspection and registry retention policies. */
  taggedImageUri: string;
  repository: string;
  tag: string;
  /** Registry-verified manifest digest. Omitted for non-pushed local images. */
  digest?: string;
  duration: number;
  pushed: boolean;
  platforms: readonly string[];
}

export interface RegistrySession {
  /** Whether the completed build must be pushed and digest-verified. */
  readonly remote: boolean;
  /** Process environment additions, normally an isolated DOCKER_CONFIG. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Optional BuildKit configuration for custom registry trust. */
  readonly buildkitConfigPath?: string;
  /** Remove temporary auth/trust material. Must be safe to call after partial setup. */
  cleanup(): Promise<void>;
}

/**
 * Registry extension contract. Core build orchestration is provider-neutral; handlers only resolve
 * image names and prepare a short-lived authenticated execution session.
 */
export interface RegistryHandler {
  resolveImageUri(imageName: string, tag: string): Promise<string>;
  prepare(imageName: string, timeout: number, signal?: AbortSignal): Promise<RegistrySession>;
}
