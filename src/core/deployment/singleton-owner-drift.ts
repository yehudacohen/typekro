import { stableSerialize } from '../singleton/singleton.js';
import {
  diffCanonicalValues,
  formatCanonicalDrift,
  type CanonicalDriftDifference,
} from '../resources/live-comparison.js';
import { SINGLETON_SPEC_FINGERPRINT_ANNOTATION } from './resource-tagging.js';
import type { SingletonDefinitionRecord } from '../types/deployment.js';
import type { DeployedResource } from '../types/deployment.js';

export interface DeployedSingletonInstance {
  readonly metadata?: {
    readonly name?: unknown;
    readonly annotations?: Record<string, unknown> | undefined;
  };
  readonly spec?: unknown;
}

export type SingletonDriftVerdict =
  | { readonly drift: false }
  | {
      readonly drift: true;
      readonly reason: string;
      readonly differences?: readonly CanonicalDriftDifference[];
    };

/** Pure singleton drift decision shared by standalone and Alchemy-hosted execution. */
export function singletonDriftVerdict(
  expectedFingerprint: string,
  deployingSpec: unknown,
  live: DeployedSingletonInstance | undefined
): SingletonDriftVerdict {
  if (!live) return { drift: false };
  const actualValue = live.metadata?.annotations?.[SINGLETON_SPEC_FINGERPRINT_ANNOTATION];
  const actual = typeof actualValue === 'string' ? actualValue : undefined;
  if (actual === expectedFingerprint) return { drift: false };
  if (actual) {
    return {
      drift: true,
      reason: `existing fingerprint ${actual} does not match ${expectedFingerprint}`,
    };
  }
  if (stableSerialize(live.spec) === stableSerialize(deployingSpec)) return { drift: false };

  const differences = diffCanonicalValues(deployingSpec, live.spec, {
    includeValues: false,
    maxDifferences: 32,
  });
  return {
    drift: true,
    reason: `an existing unfingerprinted singleton owner has a different spec at ${formatCanonicalDrift(differences)}`,
    differences,
  };
}

export function assertNoDeployedSingletonSpecDrift(
  definition: SingletonDefinitionRecord,
  singletonInstanceName: string,
  instances: readonly DeployedSingletonInstance[]
): void {
  const existing = instances.find((instance) => instance.metadata?.name === singletonInstanceName);
  if (!existing) return;

  const expectedAnnotation = singletonSpecFingerprintAnnotationValue(definition.specFingerprint);
  const verdict = singletonDriftVerdict(expectedAnnotation, definition.spec, existing);
  if (!verdict.drift) return;

  throw new Error(
    `Singleton config drift detected for ${definition.key}. ` +
      `An existing singleton owner named ${singletonInstanceName} cannot be verified: ${verdict.reason}. ` +
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
