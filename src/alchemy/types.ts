/**
 * Alchemy Integration Types
 *
 * This module provides type definitions for alchemy integration
 * with TypeKro resources.
 */

import type { ResourceLike } from 'alchemy/Resource';
import type {
  KubeConfigCredentialBindings,
  KubernetesClientConfig,
} from '../core/kubernetes/client-provider.js';
import type { ArtifactOutputUse, ArtifactRequirement } from '../core/planning/types.js';
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

/** Kubeconfig user fields safe to persist before operation-host binding resolution. */
type SerializableKubeConfigUser = Omit<
  NonNullable<KubernetesClientConfig['user']>,
  'token' | 'certData' | 'keyData'
>;

/** Durable cluster connection state accepted by the Alchemy provider boundary. */
export type SerializableKubeConfigOptions = Omit<KubernetesClientConfig, 'user'> & {
  user?: SerializableKubeConfigUser;
  credentialBindings?: KubeConfigCredentialBindings;
};

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
   * Canonical encoded per-resource artifact operation for direct fan-out.
   * Alchemy persists this record and the provider decodes it to restore
   * structured references, readiness, scope, and apply semantics without
   * scanning flattened manifest strings or recovering WeakMap metadata.
   */
  artifactExecutionRecord?: string;

  /**
   * Host-native sensitive inputs keyed by bindings in a direct execution record
   * or KRO artifact bundle. New declarations supply Effect Redacted values here.
   * This envelope is not part of either canonical artifact and is unwrapped only
   * while materializing the Kubernetes apply operation.
   */
  sensitiveBindings?: Readonly<Record<string, unknown>>;

  /** Artifact declarations and uses needed to materialize this operation. */
  artifactRequirements?: readonly ArtifactRequirement[];
  artifactOutputUses?: readonly ArtifactOutputUse[];

  /** Resolved host-provider outputs. Sensitive uses must remain Effect Redacted until apply. */
  artifactOutputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;

  /** Canonical complete KRO outer bundle used by new KRO declarations. */
  kroArtifactBundle?: string;

  /** Operation within {@link kroArtifactBundle} represented by this declaration. */
  kroArtifactOperationId?: string;

  /**
   * Serializable kubeConfig options used to reconnect after rehydration. Durable state contains
   * only a default/file source, re-derived auth configuration, or named host credential bindings.
   * Inline static credentials are rejected before declarations are created and bindings resolve
   * only inside the provider operation. See {@link extractSerializableKubeConfigOptions}.
   */
  kubeConfigOptions?: SerializableKubeConfigOptions;

  /** Optional preconfigured deployer. Runtime-only; do not rely on this surviving Alchemy rehydration. */
  deployer?: TypeKroDeployer;

  /** Serializable metadata used to preserve finalizer-safe KRO teardown after Alchemy rehydration. */
  kroDeletion?: KroDeletionOptions;

  /**
   * When true, this resource is SHARED, retained infrastructure: `delete` skips
   * tearing it down (it drops only the state entry) so one stack's destroy/prune
   * never removes an object another stack still depends on. Used for the KRO
   * instance's control-plane Namespace, which is shared by every stack targeting
   * the same workload namespace. Persisted to output so a state-driven delete
   * (no live `news`) still honors it.
   */
  retain?: boolean;

  /**
   * When true, this resource is a typekro-HOISTED workload Namespace whose teardown is
   * EMPTY-GATED (findings #3 + #4): on delete, the namespace is removed ONLY if it is
   * empty (no non-default resources) and RETAINED if another stack/user still has
   * resources inside it. Replaces the old retain-by-name-equality distinction between
   * the instance's own namespace and a shared one — runtime emptiness is the truth for
   * both. Persisted to output so a state-driven delete (no live `news`) still gates.
   */
  namespaceEmptyGate?: boolean;

  /**
   * The RGD that owns this hoisted Namespace (finding #4). When set alongside
   * {@link namespaceEmptyGate}, the empty-gated delete removes the namespace ONLY if it
   * carries the matching `typekro.io/created-by-rgd` ownership annotation — an
   * adopted/undeclared namespace is never deleted. Persisted to output.
   */
  namespaceOwnerRgd?: string;

  /**
   * CRD coordinates for the ALCHEMY pre-hoist safety check (finding #7). When set
   * alongside {@link namespaceEmptyGate}, the deploy hook enumerates EVERY existing
   * instance of this shared RGD (via the generated CRD) and checks each one's namespace
   * for pre-hoist KRO ApplySet ownership — not just the incoming namespace — so an
   * upgrade cannot let KRO's prune delete another instance's namespace unchecked. The
   * `group`/`version`/`kind` identify the generated CRD; the plural is discovered live.
   */
  namespacePreHoistQuery?: { group: string; version: string; kind: string };

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
  /** External provider requirements consumed by this declaration. */
  readonly artifactRequirements?: readonly ArtifactRequirement[];
  /** Exact outputs used by this declaration, including sensitivity taint. */
  readonly artifactOutputUses?: readonly ArtifactOutputUse[];
}

/** An external Alchemy resource that satisfies one declared artifact requirement. */
export interface AlchemyArtifactBinding {
  readonly resource: ResourceLike;
  readonly outputs: Readonly<Record<string, unknown>>;
}

export interface MaterializeAlchemyResourcesOptions {
  readonly artifacts?: Readonly<Record<string, AlchemyArtifactBinding>>;
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
  /** Canonical artifact operation persisted for state-driven reconciliation. */
  artifactExecutionRecord?: string;
  /** Canonical KRO bundle persisted for state-driven reconciliation. */
  kroArtifactBundle?: string;
  /** Operation represented by this persisted state entry. */
  kroArtifactOperationId?: string;

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
  /** Mirrors {@link TypeKroResourceProps.retain}: a retained resource is never deleted on teardown. */
  retain?: boolean;
  /** Mirrors {@link TypeKroResourceProps.namespaceEmptyGate}: empty-gated Namespace teardown. */
  namespaceEmptyGate?: boolean;
  /** Mirrors {@link TypeKroResourceProps.namespaceOwnerRgd}: ownership record for the empty-gate. */
  namespaceOwnerRgd?: string;

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
