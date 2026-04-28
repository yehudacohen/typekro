/**
 * External reference support for Kro Factory Pattern
 *
 * This module provides functionality to create external references to CRD instances
 * for composition between ResourceGraphDefinitions.
 *
 * Supports two calling conventions:
 * 1. Positional: externalRef(apiVersion, kind, instanceName, namespace?)
 * 2. Object-form: externalRef({ apiVersion, kind, metadata: { name, namespace? } })
 */

import { getCurrentCompositionContext } from '../composition/context.js';
import { getResourceId } from '../metadata/index.js';
import { createResource } from '../proxy/create-resource.js';
import { registerFactory } from '../resources/factory-registry.js';
import type { Enhanced, KubernetesResource } from '../types.js';

// Self-register so the composition analyzer recognizes `externalRef(...)` calls
// in the AST. The kind/apiVersion are placeholders — externalRef creates resources
// of user-specified kinds, but we need the factoryName 'externalRef' in the registry.
registerFactory({
  factoryName: 'externalRef',
  kind: 'ExternalRef',
  apiVersion: 'typekro/v1',
});

/**
 * Object-form configuration for creating an external reference.
 * Mirrors the Kro v0.8.x externalRef spec structure.
 */
export interface ExternalRefConfig {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
  };
  /** Explicit resource ID for composition tracking. Required when name is dynamic. */
  id?: string;
}

/**
 * Create external reference to a pre-existing resource that is not managed by Kro.
 *
 * When called inside a `kubernetesComposition` callback, the external reference is
 * automatically registered with the composition context so it appears in the Kro YAML
 * as an `externalRef` entry.
 *
 * @example Object form (Kro v0.8.x style):
 * ```typescript
 * const config = externalRef({
 *   apiVersion: 'v1',
 *   kind: 'ConfigMap',
 *   metadata: { name: 'platform-config', namespace: 'platform-system' },
 * });
 * ```
 *
 * @example Positional form (legacy):
 * ```typescript
 * const database = externalRef('v1alpha1', 'Database', 'production-db');
 * ```
 */
export function externalRef<TSpec extends object, TStatus extends object>(
  config: ExternalRefConfig
): Enhanced<TSpec, TStatus>;
export function externalRef<TSpec extends object, TStatus extends object>(
  apiVersion: string,
  kind: string,
  instanceName: string,
  namespace?: string
): Enhanced<TSpec, TStatus>;
export function externalRef<TSpec extends object, TStatus extends object>(
  configOrApiVersion: ExternalRefConfig | string,
  kind?: string,
  instanceName?: string,
  namespace?: string
): Enhanced<TSpec, TStatus> {
  let apiVersion: string;
  let resolvedKind: string;
  let resolvedName: string;
  let resolvedNamespace: string | undefined;

  if (typeof configOrApiVersion === 'object') {
    // Object-form: externalRef({ apiVersion, kind, metadata: { name, namespace } })
    apiVersion = configOrApiVersion.apiVersion;
    resolvedKind = configOrApiVersion.kind;
    resolvedName = configOrApiVersion.metadata.name;
    resolvedNamespace = configOrApiVersion.metadata.namespace;
  } else {
    // Positional form: externalRef(apiVersion, kind, instanceName, namespace?)
    apiVersion = configOrApiVersion;
    if (!kind || !instanceName) {
      throw new Error('externalRef positional form requires kind and instanceName');
    }
    resolvedKind = kind;
    resolvedName = instanceName;
    resolvedNamespace = namespace;
  }

  // Extract id from object-form config
  const resolvedId = typeof configOrApiVersion === 'object' ? configOrApiVersion.id : undefined;

  // Create a KubernetesResource marked as external reference
  const resource: KubernetesResource<TSpec, TStatus> = {
    apiVersion,
    kind: resolvedKind,
    metadata: {
      name: resolvedName,
      ...(resolvedNamespace && { namespace: resolvedNamespace }),
    },
    spec: {} as TSpec,
    status: {} as TStatus,
    // Mark this as an external reference for serialization
    __externalRef: true,
    ...(resolvedId && { id: resolvedId }),
  };

  // Use existing createResource function to get Enhanced proxy
  // (createResource skips context registration for __externalRef resources)
  const enhanced = createResource<TSpec, TStatus>(resource);

  // Explicitly register with composition context so externalRef appears in Kro YAML.
  // This only happens when called directly from user code inside kubernetesComposition.
  // Cross-composition auto-refs (from core.ts Proxy get trap) go through
  // createExternalRefWithoutRegistration() instead.
  const context = getCurrentCompositionContext();
  if (context) {
    const resourceId = getResourceId(enhanced);
    if (resourceId) {
      context.addResource(resourceId, enhanced as Enhanced<unknown, unknown>);
    }
  }

  return enhanced;
}

/**
 * Create an external reference WITHOUT registering in the composition context.
 * Used by the cross-composition magic proxy to create references to resources
 * in other compositions without polluting the current composition's resource list.
 *
 * @internal
 */
export function createExternalRefWithoutRegistration<TSpec extends object, TStatus extends object>(
  apiVersion: string,
  kind: string,
  instanceName: string,
  namespace?: string
): Enhanced<TSpec, TStatus> {
  const resource: KubernetesResource<TSpec, TStatus> = {
    apiVersion,
    kind,
    metadata: {
      name: instanceName,
      ...(namespace && { namespace }),
    },
    spec: {} as TSpec,
    status: {} as TStatus,
    __externalRef: true,
  };

  // createResource skips context registration for __externalRef resources
  return createResource(resource);
}
