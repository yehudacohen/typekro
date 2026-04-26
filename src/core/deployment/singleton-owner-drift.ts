import { stableSerialize } from '../singleton/singleton.js';
import { SINGLETON_SPEC_FINGERPRINT_ANNOTATION } from './resource-tagging.js';
import type { SingletonDefinitionRecord } from '../types/deployment.js';
import type { DeployedResource } from '../types/deployment.js';

interface DeployedSingletonInstance {
  readonly metadata?: {
    readonly name?: unknown;
    readonly annotations?: Record<string, unknown> | undefined;
  };
  readonly spec?: unknown;
}

export function assertNoDeployedSingletonSpecDrift(
  definition: SingletonDefinitionRecord,
  singletonInstanceName: string,
  instances: readonly DeployedSingletonInstance[]
): void {
  const existing = instances.find((instance) => instance.metadata?.name === singletonInstanceName);
  if (!existing) return;

  const expectedAnnotation = singletonSpecFingerprintAnnotationValue(definition.specFingerprint);
  const actualAnnotationValue = existing.metadata?.annotations?.[SINGLETON_SPEC_FINGERPRINT_ANNOTATION];
  const actualAnnotation = typeof actualAnnotationValue === 'string' ? actualAnnotationValue : undefined;
  if (actualAnnotation === expectedAnnotation) return;
  if (actualAnnotation) {
    throw new Error(
      `Singleton config drift detected for ${definition.key}. ` +
        `An existing singleton owner named ${singletonInstanceName} cannot be verified: ` +
        `fingerprint ${actualAnnotation} does not match ${expectedAnnotation}. ` +
        'A singleton identity must not be deployed with multiple specs.'
    );
  }

  const existingFingerprint = stableSerialize(existing.spec);
  if (existingFingerprint === definition.specFingerprint) return;

  throw new Error(
    `Singleton config drift detected for ${definition.key}. ` +
      `An existing singleton owner named ${singletonInstanceName} has a different spec. ` +
      'A singleton identity must not be deployed with multiple specs.'
  );
}

export function singletonSpecFingerprintAnnotationValue(specFingerprint: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < specFingerprint.length; i++) {
    hash ^= BigInt(specFingerprint.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `fnv64:${hash.toString(16).padStart(16, '0')}`;
}

export function assertNoDiscoveredSingletonSpecDrift(
  definition: SingletonDefinitionRecord,
  singletonInstanceName: string,
  resources: readonly DeployedResource[]
): { hasLegacyUnfingerprintedResources: boolean } {
  if (resources.length === 0) return { hasLegacyUnfingerprintedResources: false };

  const expected = singletonSpecFingerprintAnnotationValue(definition.specFingerprint);
  let hasLegacyUnfingerprintedResources = false;
  for (const resource of resources) {
    const actual = resource.manifest.metadata?.annotations?.[SINGLETON_SPEC_FINGERPRINT_ANNOTATION];
    if (actual === expected) continue;
    if (!actual) {
      hasLegacyUnfingerprintedResources = true;
      continue;
    }

    throw new Error(
      `Singleton config drift detected for ${definition.key}. ` +
        `An existing singleton owner named ${singletonInstanceName} cannot be verified: ` +
        `fingerprint ${actual} does not match ${expected}. ` +
        'A singleton identity must not be deployed with multiple specs.'
    );
  }

  return { hasLegacyUnfingerprintedResources };
}
