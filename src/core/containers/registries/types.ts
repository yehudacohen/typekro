/**
 * Container Registry Types
 *
 * Defines the registry configuration interface and the internal handler
 * contract. New registries (GCR, ACR, etc.) are added by:
 * 1. Adding a config variant to RegistryConfig
 * 2. Implementing RegistryHandler
 * 3. Registering in the resolver
 */

// ---------------------------------------------------------------------------
// Registry Configurations (user-facing)
// ---------------------------------------------------------------------------

export interface OrbstackRegistryConfig {
  type: 'orbstack';
}

/**
 * ECR registry configuration.
 *
 * Credential options are passed directly to the AWS SDK's
 * `fromNodeProviderChain`, which handles env vars, profiles,
 * SSO sessions, instance roles, web identity tokens, and role
 * assumption. Any option accepted by the SDK's DefaultProviderInit
 * can be passed via `credentials`.
 */
export interface EcrRegistryConfig {
  type: 'ecr';
  /** AWS account ID. Auto-detected from STS if omitted. */
  accountId?: string;
  /** AWS region. Falls back to AWS_REGION / AWS_DEFAULT_REGION env vars. */
  region?: string;
  /** Create the ECR repository if it doesn't exist (default: true). */
  createRepository?: boolean;
  /**
   * AWS credential options passed to `fromNodeProviderChain`.
   * Common options: `profile`, `roleArn`, `roleSessionName`,
   * `mfaCodeProvider`, `configFilepath`.
   * Omit to use the default credential chain (env vars, profiles, SSO, etc.).
   */
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

/** Discriminated union of all supported container registries. */
export type RegistryConfig =
  | OrbstackRegistryConfig
  | EcrRegistryConfig
  | GcrRegistryConfig
  | AcrRegistryConfig;

// ---------------------------------------------------------------------------
// Build Options & Result (user-facing)
// ---------------------------------------------------------------------------

export interface ContainerBuildOptions {
  /** Path to the build context directory (contains the Dockerfile). */
  context: string;
  /** Dockerfile path relative to context (default: 'Dockerfile'). */
  dockerfile?: string;
  /** Image name without registry prefix or tag (e.g., 'my-app'). */
  imageName: string;
  /** Tag: explicit string, 'content-hash' for SHA-based, or undefined for 'latest'. */
  tag?: string;
  /** Target platform (e.g., 'linux/amd64'). Omit for native platform. */
  platform?: string;
  /** Additional Docker build arguments. */
  buildArgs?: Record<string, string>;
  /** Docker build target for multi-stage builds. */
  target?: string;
  /** Suppress build output — only log on error. */
  quiet?: boolean;
  /** Build timeout in milliseconds (default: 300_000 = 5 minutes). */
  timeout?: number;
  /**
   * Extra Docker CLI arguments appended to the build command.
   * Escape hatch for --secret, --ssh, --cache-from, etc.
   */
  extraDockerArgs?: string[];
  /** Registry to push the built image to. */
  registry: RegistryConfig;
}

export interface ContainerBuildResult {
  /** Full image URI (e.g., '123456.dkr.ecr.us-east-1.amazonaws.com/app:sha-abc123'). */
  imageUri: string;
  /** The tag that was applied. */
  tag: string;
  /** Build duration in milliseconds. */
  duration: number;
  /** Whether the image was pushed to a remote registry. */
  pushed: boolean;
}

// ---------------------------------------------------------------------------
// Registry Handler (internal contract)
// ---------------------------------------------------------------------------

/** Internal interface that each registry implementation fulfills. */
export interface RegistryHandler {
  /** Compute the full image URI (registry prefix + name + tag). */
  resolveImageUri(imageName: string, tag: string): Promise<string>;
  /** Authenticate with the registry. No-op for local registries. */
  authenticate(): Promise<void>;
  /** Push the image to the registry. Returns true if pushed, false for local registries. */
  push(imageUri: string, imageName: string): Promise<boolean>;
}
