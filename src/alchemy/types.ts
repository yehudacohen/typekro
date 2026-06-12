/**
 * Alchemy Integration Types
 *
 * This module provides type definitions for alchemy integration
 * with TypeKro resources.
 */

import type { KubernetesClientConfig } from '../core/kubernetes/client-provider.js';
import type { DeployedResource, DeploymentOptions } from '../core/types/deployment.js';
import type { Enhanced } from '../core/types/kubernetes.js';
import type { KroDeletionOptions } from './kro-delete.js';

/**
 * Centralized deployment interface that abstracts deployment logic
 */
export interface TypeKroDeployer {
  /**
   * Deploy a TypeKro resource to Kubernetes. `seedResources` (direct mode) supplies the live state
   * of resources deployed elsewhere (e.g. sibling alchemy resources) so this resource's
   * cross-resource references/CEL resolve without redeploying them.
   */
  deploy<T extends Enhanced<any, any>>(
    resource: T,
    options: DeploymentOptions,
    seedResources?: DeployedResource[]
  ): Promise<T>;

  /**
   * Delete a TypeKro resource from Kubernetes
   */
  delete<T extends Enhanced<any, any>>(resource: T, options: DeploymentOptions): Promise<void>;

  /** Dispose any underlying clients owned by this deployer. */
  dispose?(): Promise<void>;
}

/**
 * Serializable kubeConfig options that can be passed through Alchemy
 * This is now a re-export of the centralized KubernetesClientConfig
 */
export type SerializableKubeConfigOptions = KubernetesClientConfig;

/**
 * Properties for creating or updating a TypeKro resource through alchemy
 */
export interface TypeKroResourceProps<T extends Enhanced<any, any>> {
  /**
   * The TypeKro Enhanced resource to deploy
   */
  resource: T;

  /**
   * The namespace to deploy the resource to
   */
  namespace: string;

  /**
   * The deployment strategy to use
   */
  deploymentStrategy: 'direct' | 'kro';

  /**
   * The resource's logical id within its composition graph (e.g. `webappDeployment`) — the id
   * sibling resources' `KubernetesRef`s point at. Surfaced on the output so dependents can seed
   * reference resolution against this resource's live state. Set by `toAlchemyResources`.
   */
  resourceId?: string;

  /**
   * Serializable kubeConfig options used to reach the cluster (and to reconnect on a rehydrated
   * delete). Echoed onto the output so a state-driven delete works.
   *
   * ⚠️ SECURITY: alchemy persists props + output to its state store, so these options are written
   * to state. If they carry static secrets — `user.token` / `user.certData` / `user.keyData` — those
   * land in state (e.g. plaintext for the local/HTTP stores). Prefer re-derived auth (`user.exec`
   * such as `aws eks get-token`, or `authProvider`), which is a command spec rather than a secret,
   * and use a secured state backend. See {@link extractSerializableKubeConfigOptions}.
   */
  kubeConfigOptions?: SerializableKubeConfigOptions;

  /** Optional preconfigured deployer. Runtime-only; do not rely on this surviving Alchemy rehydration. */
  deployer?: TypeKroDeployer;

  /** Serializable metadata used to preserve finalizer-safe KRO teardown after Alchemy rehydration. */
  kroDeletion?: KroDeletionOptions;

  /**
   * Resolved outputs of the resources this one depends on. Two jobs:
   *
   *  1. **Ordering** — because each entry traces back (via an alchemy `Output`) to another
   *     resource, alchemy deploys those first. KRO uses this so the CR instance waits for its
   *     RGD's CRD; direct mode uses it to honor the composition's dependency graph.
   *  2. **Reference resolution (direct mode)** — each entry's `deployedResource` is the live
   *     dependency, so the reconcile can resolve this resource's cross-resource `KubernetesRef`s
   *     against already-deployed siblings before applying the (now concrete) single manifest.
   *
   * Populated by {@link AlchemyResourceDeclaration} + the `materializeAlchemyResources` helper,
   * not by hand. By the time `reconcile` runs, alchemy has resolved these to concrete values.
   */
  dependencies?: TypeKroResource<Enhanced<unknown, unknown>>[];

  /**
   * Optional deployment options
   */
  options?: Partial<Omit<DeploymentOptions, 'mode' | 'namespace'>>;
}

/**
 * A single declarative alchemy v2 resource to instantiate: a stable `id` plus the
 * `props` to pass to `KroResource`. Produced by a factory's `toAlchemyResources(spec)`
 * (the v2 analog of the removed imperative `deployWithAlchemy`) so callers can fan a
 * KRO factory out into its independent state entries (the RGD + each CR instance):
 *
 * ```ts
 * for (const { id, props } of await factory.toAlchemyResources(spec)) {
 *   yield* KroResource(id, props);
 * }
 * ```
 */
export interface AlchemyResourceDeclaration {
  readonly id: string;
  readonly props: TypeKroResourceProps<Enhanced<unknown, unknown>>;
  /**
   * Ids of the other declarations (in the same array) this one must deploy after. The
   * declarations are returned topologically sorted, and `materializeAlchemyResources` turns
   * these into alchemy `Output` dependencies (ordering + direct-mode reference resolution).
   */
  readonly dependsOn: readonly string[];
}

/**
 * Alchemy resource state structure
 */
export interface AlchemyResourceState {
  kind?: string;
  resource?: Enhanced<unknown, unknown> | undefined;
  ready?: boolean;
  [key: string]: unknown;
}

/**
 * Output returned after TypeKro resource deployment through alchemy.
 *
 * Under alchemy v2 a resource's output is a plain, serializable shape (the value
 * `reconcile` returns and alchemy persists to state) — not an extension of a
 * framework `Resource` type as it was under v1.
 */
export interface TypeKroResource<T extends Enhanced<any, any>> {
  /**
   * The original TypeKro resource
   */
  resource: T;

  /**
   * The resource's logical composition-graph id (mirrors {@link TypeKroResourceProps.resourceId}).
   * Lets a dependent reconcile match this resource against its `KubernetesRef`s when seeding
   * direct-mode reference resolution. Undefined for resources not produced via `toAlchemyResources`.
   */
  resourceId?: string;

  /**
   * The namespace the resource was deployed to
   */
  namespace: string;

  /**
   * Persisted delete-time metadata: how the resource was deployed + how to reach/tear it down.
   * Echoed from the props so a state-driven `delete` (no live `news`) can reconstruct them.
   * ⚠️ SECURITY: `kubeConfigOptions` is persisted to alchemy state — see the note on
   * {@link TypeKroResourceProps.kubeConfigOptions}.
   */
  deploymentStrategy?: 'direct' | 'kro';
  kubeConfigOptions?: SerializableKubeConfigOptions;
  kroDeletion?: KroDeletionOptions;

  /**
   * The deployed resource with live status from the cluster
   */
  deployedResource: T;

  /**
   * Whether the resource is ready and available
   */
  ready: boolean;

  /**
   * Deployment timestamp
   */
  deployedAt: number;
}
