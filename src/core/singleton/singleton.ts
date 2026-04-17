import { SINGLETON_HANDLE_BRAND } from '../constants/brands.js';
import { getCurrentCompositionContext } from '../composition/context.js';
import { getSingletonInstanceName } from '../deployment/shared-utilities.js';
import { externalRef } from '../references/external-refs.js';
import type {
  CallableComposition,
  NestedCompositionResource,
  SingletonDefinitionRecord,
  SingletonHandle,
  SingletonOwnedHandle,
  SingletonReferenceHandle,
} from '../types/deployment.js';
import type { KroCompatibleType } from '../types/serialization.js';
import { toCamelCase } from '../../utils/string.js';

interface SingletonCompositionMetadata {
  apiVersion?: string;
  kind?: string;
  name?: string;
  _definition?: {
    apiVersion?: string;
    kind?: string;
    name?: string;
  };
}

const singletonDefinitionsByComposition = new WeakMap<object, Map<string, SingletonDefinitionRecord>>();
export const DEFAULT_SINGLETON_NAMESPACE = 'typekro-singletons';

function getSingletonRegistryForComposition<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  composition: CallableComposition<TSpec, TStatus>,
): Map<string, SingletonDefinitionRecord<TSpec, TStatus>> {
  let registry = singletonDefinitionsByComposition.get(composition) as
    | Map<string, SingletonDefinitionRecord<TSpec, TStatus>>
    | undefined;
  if (!registry) {
    registry = new Map<string, SingletonDefinitionRecord<TSpec, TStatus>>();
    singletonDefinitionsByComposition.set(
      composition,
      registry as unknown as Map<string, SingletonDefinitionRecord>
    );
  }
  return registry;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}

function getSingletonFactoryIdentity<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  composition: CallableComposition<TSpec, TStatus>,
): string {
  const compositionRecord = composition as unknown as SingletonCompositionMetadata;
  const rawApiVersion = String(compositionRecord._definition?.apiVersion ?? compositionRecord.apiVersion ?? 'v1alpha1');
  const apiVersion = rawApiVersion.includes('/') ? rawApiVersion : `kro.run/${rawApiVersion}`;
  const kind = String(compositionRecord._definition?.kind ?? compositionRecord.kind ?? 'unknown');
  const name = String(compositionRecord._definition?.name ?? compositionRecord.name ?? 'unknown');
  return `${apiVersion}/${kind}:${name}`;
}

function getSingletonKey<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  composition: CallableComposition<TSpec, TStatus>,
  id: string,
): string {
  return `${getSingletonFactoryIdentity(composition)}#${id}`;
}

function getSingletonResourceId(key: string): string {
  return toCamelCase(`singleton-${key.replaceAll(/[^a-zA-Z0-9]+/g, '-')}`);
}

function attachSingletonIdentity<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  base: NestedCompositionResource<TSpec, TStatus> | SingletonReferenceHandle<TStatus>,
  id: string,
  key: string,
): SingletonHandle<TSpec, TStatus> {
  Object.defineProperty(base, SINGLETON_HANDLE_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(base, '__singletonId', {
    value: id,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(base, '__singletonKey', {
    value: key,
    enumerable: true,
    configurable: false,
    writable: false,
  });

  return base as SingletonHandle<TSpec, TStatus>;
}

function defineSingleton<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  composition: CallableComposition<TSpec, TStatus>,
  input: { id: string; spec: TSpec },
): SingletonHandle<TSpec, TStatus> {
  const key = getSingletonKey(composition, input.id);
  const specFingerprint = stableSerialize(input.spec);
  const context = getCurrentCompositionContext();
  const definitionRecord: SingletonDefinitionRecord<TSpec, TStatus> = {
    id: input.id,
    key,
    specFingerprint,
    registryNamespace: DEFAULT_SINGLETON_NAMESPACE,
    composition,
    spec: input.spec,
  };

  if (context?.singletonDefinitions) {
    const existingContextDef = context.singletonDefinitions.get(key);
    if (existingContextDef && existingContextDef.specFingerprint !== specFingerprint) {
      throw new Error(
        `Singleton config drift detected for ${key}. ` +
        'A singleton identity must not be defined with multiple specs.',
      );
    }
    context.singletonDefinitions.set(key, definitionRecord as SingletonDefinitionRecord);
  }

  if (context && !context.isReExecution) {
    return useSingleton(composition, input.id, DEFAULT_SINGLETON_NAMESPACE);
  }

  const singletonDefinitions = getSingletonRegistryForComposition(composition);
  const existing = singletonDefinitions.get(key);
  if (existing && existing.specFingerprint !== specFingerprint) {
    throw new Error(
      `Singleton config drift detected for ${key}. ` +
      'A singleton identity must not be defined with multiple specs.',
    );
  }

  singletonDefinitions.set(key, definitionRecord);

  return attachSingletonIdentity(composition(input.spec) as SingletonOwnedHandle<TSpec, TStatus>, input.id, key);
}

function useSingleton<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  composition: CallableComposition<TSpec, TStatus>,
  id: string,
  registryNamespace = DEFAULT_SINGLETON_NAMESPACE,
): SingletonReferenceHandle<TStatus> {
  const key = getSingletonKey(composition, id);
  const compositionRecord = composition as unknown as SingletonCompositionMetadata;
  const rawApiVersion = String(compositionRecord._definition?.apiVersion ?? compositionRecord.apiVersion ?? 'v1alpha1');
  const apiVersion = rawApiVersion.includes('/') ? rawApiVersion : `kro.run/${rawApiVersion}`;
  const kind = String(compositionRecord._definition?.kind ?? compositionRecord.kind ?? 'unknown');
  const statusRef = externalRef<TSpec, TStatus>({
    apiVersion,
    kind,
    metadata: { name: getSingletonInstanceName(id), namespace: registryNamespace },
    id: getSingletonResourceId(key),
  });

  const handle = {
    [SINGLETON_HANDLE_BRAND]: true as const,
    kind: 'singleton-reference' as const,
    status: statusRef.status,
  } as SingletonReferenceHandle<TStatus>;

  return attachSingletonIdentity(handle, id, key) as SingletonReferenceHandle<TStatus>;
}

type SingletonApi = typeof defineSingleton & {
  use: typeof useSingleton;
};

export const singleton: SingletonApi = Object.assign(defineSingleton, {
  use: useSingleton,
});
