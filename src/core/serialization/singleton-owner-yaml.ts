import { getSingletonInstanceName } from '../deployment/shared-utilities.js';
import { createResource } from '../proxy/create-resource.js';
import { getSingletonResourceId } from '../singleton/singleton.js';
import type { SingletonDefinitionRecord } from '../types/deployment.js';
import type { KubernetesResource } from '../types/index.js';

function sanitizeSingletonResourceId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9]+(.)?/g, (_match, ch?: string) =>
    ch ? ch.toUpperCase() : ''
  );
  if (!sanitized) {
    return 'Id';
  }
  return sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
}

function shortDeterministicSuffix(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).padStart(7, '0').slice(-7);
}

function buildSingletonYamlResourceId(prefix: string, rawValue: string): string {
  const suffix = shortDeterministicSuffix(rawValue);
  const maxLength = 63;
  const maxBaseLength = Math.max(1, maxLength - prefix.length - suffix.length);
  const base = sanitizeSingletonResourceId(rawValue).slice(0, maxBaseLength);
  return `${prefix}${base}${suffix}`;
}

export function materializeSingletonOwnerResourcesForKroYaml(
  resourcesWithKeys: Record<string, KubernetesResource<unknown, unknown>>,
  singletonDefinitions?: SingletonDefinitionRecord[]
): void {
  if (!singletonDefinitions || singletonDefinitions.length === 0) return;

  const emittedNamespaces = new Set<string>();
  const emittedOwnerKeys = new Set<string>();

  for (const definition of singletonDefinitions) {
    if (!emittedNamespaces.has(definition.registryNamespace)) {
      const namespaceId = buildSingletonYamlResourceId(
        'singletonNamespace',
        definition.registryNamespace
      );
      if (!(namespaceId in resourcesWithKeys)) {
        resourcesWithKeys[namespaceId] = createResource(
          {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: { name: definition.registryNamespace },
            spec: {},
            id: namespaceId,
          },
          { scope: 'cluster' }
        );
      }
      emittedNamespaces.add(definition.registryNamespace);
    }

    if (emittedOwnerKeys.has(definition.key)) continue;

    const compositionRecord = definition.composition as unknown as {
      _definition?: { apiVersion?: string; kind?: string };
      apiVersion?: string;
      kind?: string;
    };
    const rawApiVersion = String(
      compositionRecord._definition?.apiVersion ?? compositionRecord.apiVersion ?? 'v1alpha1'
    );
    const apiVersion = rawApiVersion.includes('/') ? rawApiVersion : `kro.run/${rawApiVersion}`;
    const kind = String(compositionRecord._definition?.kind ?? compositionRecord.kind ?? 'Unknown');
    const ownerId = getSingletonResourceId(definition.key);
    const existingOwner = resourcesWithKeys[ownerId] as (KubernetesResource<unknown, unknown> & {
      __externalRef?: boolean;
    }) | undefined;

    if (!existingOwner || existingOwner.__externalRef === true) {
      resourcesWithKeys[ownerId] = createResource(
        {
          apiVersion,
          kind,
          metadata: {
            name: getSingletonInstanceName(definition.id),
            namespace: definition.registryNamespace,
          },
          spec: definition.spec,
          id: ownerId,
        },
        { scope: 'namespaced' }
      );
    }

    emittedOwnerKeys.add(definition.key);
  }
}
