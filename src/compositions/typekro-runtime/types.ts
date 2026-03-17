import { type Type, type } from 'arktype';

export interface TypeKroRuntimeSpecType {
  namespace: string;
}

export interface TypeKroRuntimeStatusType {
  phase: 'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading';
  components: {
    fluxSystem: boolean;
    kroSystem: boolean;
  };
}

export const TypeKroRuntimeSpec: Type<TypeKroRuntimeSpecType> = type({
  namespace: 'string',
});

export const TypeKroRuntimeStatus: Type<TypeKroRuntimeStatusType> = type({
  phase: '"Pending" | "Installing" | "Ready" | "Failed" | "Upgrading"',
  components: {
    fluxSystem: 'boolean',
    kroSystem: 'boolean',
  },
});

/**
 * RBAC configuration for the TypeKro runtime bootstrap.
 *
 * - `'cluster-admin'` (default): Binds all Flux controllers to the built-in `cluster-admin`
 *   ClusterRole. This is the simplest option and works with any Helm chart, but grants
 *   unrestricted cluster access.
 *
 * - `'scoped'`: Creates a dedicated ClusterRole with the minimum permissions required by
 *   Flux controllers (Helm, Kustomize, Source, Notification, Image). This is more secure
 *   but may fail if a deployed Helm chart creates CRDs or cluster-scoped resources that
 *   require additional permissions not covered by the scoped role.
 *
 * - `{ clusterRoleRef: string }`: Binds Flux controllers to a user-provided ClusterRole.
 *   The ClusterRole must already exist in the cluster. Use this when you need precise
 *   control over permissions.
 */
export type RbacMode = 'cluster-admin' | 'scoped' | { clusterRoleRef: string };

export interface TypeKroRuntimeConfig {
  namespace?: string;
  fluxVersion?: string;
  kroVersion?: string;
  /**
   * RBAC mode for Flux controller permissions.
   *
   * @default 'cluster-admin'
   * @see {@link RbacMode} for details on each mode.
   */
  rbac?: RbacMode;
}
