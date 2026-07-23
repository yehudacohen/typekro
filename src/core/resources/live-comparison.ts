import { TypeKroError } from '../errors.js';
import { getMetadataField } from '../metadata/index.js';
import { canonicalDigest, canonicalStringify } from '../planning/canonical.js';
import type { KubernetesResource } from '../types/kubernetes.js';
import {
  getFactoryRegistration,
  getFactoryRegistrationsForGVK,
  type FactoryRegistration,
  type ResourceComparisonSide,
} from './factory-registry.js';

export interface ComparisonCanonicalizerEvidence {
  readonly id: string;
  readonly revision: string;
  readonly stage: 'desired' | 'live-comparison';
  readonly factoryName: string;
}

export type CanonicalDriftKind =
  | 'missing-live-value'
  | 'unexpected-live-value'
  | 'type-mismatch'
  | 'value-mismatch';

export interface CanonicalDriftValueEvidence {
  readonly type: 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'undefined';
  readonly digest?: string;
  readonly preview?: string;
  readonly redacted?: true;
}

export interface CanonicalDriftDifference {
  readonly path: string;
  readonly kind: CanonicalDriftKind;
  readonly desired?: CanonicalDriftValueEvidence;
  readonly live?: CanonicalDriftValueEvidence;
}

export interface CanonicalValueDiffOptions {
  /** Ignore object fields that exist only in the live value, as SSA-style ownership does. */
  readonly ignoreAdditionalLiveFields?: boolean;
  /** Include bounded JSON previews. Digests and types are always emitted for non-redacted values. */
  readonly includeValues?: boolean;
  /** Redact values at sensitive paths. Redacted values expose neither a preview nor a digest. */
  readonly redact?: (path: string, side: ResourceComparisonSide, value: unknown) => boolean;
  /** Bound diagnostic size while retaining deterministic traversal order. */
  readonly maxDifferences?: number;
}

export interface KubernetesResourceComparisonOptions extends CanonicalValueDiffOptions {
  /** Exact factory provenance when more than one factory can produce the desired GVK. */
  readonly factoryName?: string;
}

export interface CanonicalResourceComparison {
  readonly equal: boolean;
  readonly identity: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly name?: string;
    readonly namespace?: string;
  };
  readonly differences: readonly CanonicalDriftDifference[];
  readonly canonicalizers: readonly ComparisonCanonicalizerEvidence[];
}

const METADATA_NOISE_FIELDS = [
  'creationTimestamp',
  'deletionGracePeriodSeconds',
  'deletionTimestamp',
  'generation',
  'managedFields',
  'resourceVersion',
  'selfLink',
  'uid',
] as const;

function jsonClone<T>(value: T, context: string): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (error) {
    throw new TypeKroError(
      `Unable to clone ${context} for canonical comparison.`,
      'RESOURCE_COMPARISON_CLONE_FAILED',
      { context, cause: error instanceof Error ? error.message : String(error) }
    );
  }
}

function sameGvk(registration: FactoryRegistration, resource: KubernetesResource): boolean {
  return (
    registration.apiVersion.toLowerCase() === resource.apiVersion.toLowerCase() &&
    registration.kind.toLowerCase() === resource.kind.toLowerCase()
  );
}

function comparisonRegistration(
  resource: KubernetesResource,
  explicitFactoryName?: string
): FactoryRegistration | undefined {
  const factoryName = explicitFactoryName ?? getMetadataField(resource as object, 'factoryName');
  if (factoryName) {
    const registration = getFactoryRegistration(factoryName);
    if (!registration) {
      throw new TypeKroError(
        `Factory provenance ${factoryName} is not registered for canonical comparison.`,
        'RESOURCE_COMPARISON_FACTORY_UNKNOWN',
        {
          factoryName,
          resourceApiVersion: resource.apiVersion,
          resourceKind: resource.kind,
        }
      );
    }
    if (!sameGvk(registration, resource)) {
      throw new TypeKroError(
        `Factory provenance ${factoryName} does not produce ${resource.apiVersion}/${resource.kind}.`,
        'RESOURCE_COMPARISON_FACTORY_MISMATCH',
        {
          factoryName,
          resourceApiVersion: resource.apiVersion,
          resourceKind: resource.kind,
          factoryApiVersion: registration.apiVersion,
          factoryKind: registration.kind,
        }
      );
    }
    return registration;
  }

  const registrations = getFactoryRegistrationsForGVK(resource.apiVersion, resource.kind);
  if (registrations.length <= 1) return registrations[0];
  if (
    registrations.some(
      (registration) =>
        registration.desiredCanonicalizer !== undefined ||
        registration.liveCanonicalizer !== undefined
    )
  ) {
    throw new TypeKroError(
      `Canonical comparison for ${resource.apiVersion}/${resource.kind} is ambiguous because multiple factories are registered.`,
      'RESOURCE_COMPARISON_FACTORY_AMBIGUOUS',
      {
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        factories: registrations.map((registration) => registration.factoryName).sort(),
      }
    );
  }
  return undefined;
}

function applyDeterministicCanonicalizer(
  resource: KubernetesResource,
  context: string,
  canonicalize: (input: KubernetesResource) => KubernetesResource
): KubernetesResource {
  const first = canonicalize(jsonClone(resource, `${context} input`));
  const second = canonicalize(jsonClone(resource, `${context} input`));
  if (canonicalStringify(first) !== canonicalStringify(second)) {
    throw new TypeKroError(
      `${context} produced different outputs for identical inputs.`,
      'RESOURCE_COMPARISON_CANONICALIZER_NONDETERMINISTIC',
      { context }
    );
  }
  return first;
}

function stripOperationalMapEntries(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key]) => !key.startsWith('typekro.io/')
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stripKubernetesComparisonNoise(resource: KubernetesResource): KubernetesResource {
  const canonical = jsonClone(resource, 'Kubernetes resource');
  delete (canonical as KubernetesResource & { id?: unknown; scope?: unknown }).id;
  delete (canonical as KubernetesResource & { id?: unknown; scope?: unknown }).scope;
  delete canonical.status;

  if (canonical.metadata) {
    const metadata = { ...canonical.metadata } as Record<string, unknown>;
    for (const field of METADATA_NOISE_FIELDS) delete metadata[field];

    const labels = stripOperationalMapEntries(metadata.labels);
    const annotations = stripOperationalMapEntries(metadata.annotations);
    if (labels) metadata.labels = labels;
    else delete metadata.labels;
    if (annotations) metadata.annotations = annotations;
    else delete metadata.annotations;
    if (Array.isArray(metadata.finalizers) && metadata.finalizers.length === 0) {
      delete metadata.finalizers;
    }
    if (Array.isArray(metadata.ownerReferences) && metadata.ownerReferences.length === 0) {
      delete metadata.ownerReferences;
    }
    canonical.metadata = metadata;
  }

  return canonical;
}

/** Canonicalize one resource for a desired/live comparison without changing semantic plan data. */
export function canonicalizeResourceForComparison(
  resource: KubernetesResource,
  side: ResourceComparisonSide,
  options: Pick<KubernetesResourceComparisonOptions, 'factoryName'> = {}
): {
  readonly resource: KubernetesResource;
  readonly canonicalizers: readonly ComparisonCanonicalizerEvidence[];
} {
  const registration = comparisonRegistration(resource, options.factoryName);
  const evidence: ComparisonCanonicalizerEvidence[] = [];
  let current = jsonClone(resource, `${side} resource`);

  if (side === 'desired' && registration?.desiredCanonicalizer) {
    const canonicalizer = registration.desiredCanonicalizer;
    current = applyDeterministicCanonicalizer(
      current,
      `Desired canonicalizer ${canonicalizer.id}@${canonicalizer.revision}`,
      canonicalizer.canonicalize
    );
    evidence.push({
      id: canonicalizer.id,
      revision: canonicalizer.revision,
      stage: 'desired',
      factoryName: registration.factoryName,
    });
  }

  if (registration?.liveCanonicalizer) {
    const canonicalizer = registration.liveCanonicalizer;
    current = applyDeterministicCanonicalizer(
      current,
      `Live comparison canonicalizer ${canonicalizer.id}@${canonicalizer.revision} (${side})`,
      (input) => canonicalizer.canonicalize(input, side)
    );
    evidence.push({
      id: canonicalizer.id,
      revision: canonicalizer.revision,
      stage: 'live-comparison',
      factoryName: registration.factoryName,
    });
  }

  return { resource: stripKubernetesComparisonNoise(current), canonicalizers: evidence };
}

function valueType(value: unknown): CanonicalDriftValueEvidence['type'] {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as CanonicalDriftValueEvidence['type'];
}

function boundedPreview(value: unknown): string {
  const encoded = canonicalStringify(value);
  return encoded.length <= 240 ? encoded : `${encoded.slice(0, 237)}...`;
}

function valueEvidence(
  value: unknown,
  path: string,
  side: ResourceComparisonSide,
  options: CanonicalValueDiffOptions
): CanonicalDriftValueEvidence {
  if (options.redact?.(path, side, value)) return { type: valueType(value), redacted: true };
  if (value === undefined) return { type: 'undefined' };
  return {
    type: valueType(value),
    digest: canonicalDigest(value),
    ...(options.includeValues ? { preview: boundedPreview(value) } : {}),
  };
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Produce deterministic exact-path differences between two canonical values. */
export function diffCanonicalValues(
  desired: unknown,
  live: unknown,
  options: CanonicalValueDiffOptions = {}
): readonly CanonicalDriftDifference[] {
  const differences: CanonicalDriftDifference[] = [];
  const maximum = options.maxDifferences ?? 100;

  const visit = (expected: unknown, actual: unknown, path: string): void => {
    if (differences.length >= maximum || Object.is(expected, actual)) return;

    if (Array.isArray(expected) && Array.isArray(actual)) {
      const commonLength = Math.min(expected.length, actual.length);
      for (let index = 0; index < commonLength; index++) {
        visit(expected[index], actual[index], `${path}[${index}]`);
      }
      for (
        let index = commonLength;
        index < expected.length && differences.length < maximum;
        index++
      ) {
        differences.push({
          path: `${path}[${index}]`,
          kind: 'missing-live-value',
          desired: valueEvidence(expected[index], `${path}[${index}]`, 'desired', options),
        });
      }
      for (
        let index = commonLength;
        index < actual.length && differences.length < maximum;
        index++
      ) {
        differences.push({
          path: `${path}[${index}]`,
          kind: 'unexpected-live-value',
          live: valueEvidence(actual[index], `${path}[${index}]`, 'live', options),
        });
      }
      return;
    }

    if (isRecord(expected) && isRecord(actual)) {
      for (const key of Object.keys(expected).sort()) {
        const nextPath = childPath(path, key);
        if (!Object.hasOwn(actual, key)) {
          differences.push({
            path: nextPath,
            kind: 'missing-live-value',
            desired: valueEvidence(expected[key], nextPath, 'desired', options),
          });
        } else {
          visit(expected[key], actual[key], nextPath);
        }
        if (differences.length >= maximum) return;
      }
      if (!options.ignoreAdditionalLiveFields) {
        for (const key of Object.keys(actual).sort()) {
          if (Object.hasOwn(expected, key)) continue;
          const nextPath = childPath(path, key);
          differences.push({
            path: nextPath,
            kind: 'unexpected-live-value',
            live: valueEvidence(actual[key], nextPath, 'live', options),
          });
          if (differences.length >= maximum) return;
        }
      }
      return;
    }

    const expectedType = valueType(expected);
    const actualType = valueType(actual);
    differences.push({
      path,
      kind: expectedType === actualType ? 'value-mismatch' : 'type-mismatch',
      desired: valueEvidence(expected, path, 'desired', options),
      live: valueEvidence(actual, path, 'live', options),
    });
  };

  visit(desired, live, '$');
  return differences;
}

function secretDataPath(path: string): boolean {
  return (
    path === '$.data' ||
    path.startsWith('$.data.') ||
    path.startsWith('$.data[') ||
    path === '$.stringData' ||
    path.startsWith('$.stringData.') ||
    path.startsWith('$.stringData[')
  );
}

/** Compare desired intent with live Kubernetes state after factory-owned normalization. */
export function compareKubernetesResources(
  desired: KubernetesResource,
  live: KubernetesResource,
  options: KubernetesResourceComparisonOptions = {}
): CanonicalResourceComparison {
  const desiredResult = canonicalizeResourceForComparison(desired, 'desired', options);
  const factoryName = options.factoryName ?? getMetadataField(desired as object, 'factoryName');
  // Kubernetes GET responses include GVK, but adapters and test doubles sometimes return only
  // the object body. The request target already establishes this identity, so fill only missing
  // envelope fields while preserving an explicit mismatch for comparison diagnostics.
  const comparableLive: KubernetesResource = {
    ...live,
    apiVersion: live.apiVersion || desired.apiVersion,
    kind: live.kind || desired.kind,
  };
  const liveResult = canonicalizeResourceForComparison(comparableLive, 'live', {
    ...(factoryName ? { factoryName } : {}),
  });
  const redact =
    options.redact ??
    (desired.kind === 'Secret' || comparableLive.kind === 'Secret'
      ? (path: string) => secretDataPath(path)
      : undefined);
  const differences = diffCanonicalValues(desiredResult.resource, liveResult.resource, {
    ...options,
    ignoreAdditionalLiveFields: options.ignoreAdditionalLiveFields ?? true,
    ...(redact ? { redact } : {}),
  });
  const canonicalizers = [...desiredResult.canonicalizers, ...liveResult.canonicalizers].filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.id === entry.id &&
          candidate.revision === entry.revision &&
          candidate.stage === entry.stage &&
          candidate.factoryName === entry.factoryName
      ) === index
  );
  return {
    equal: differences.length === 0,
    identity: {
      apiVersion: desired.apiVersion,
      kind: desired.kind,
      ...(desired.metadata?.name ? { name: desired.metadata.name } : {}),
      ...(desired.metadata?.namespace ? { namespace: desired.metadata.namespace } : {}),
    },
    differences,
    canonicalizers,
  };
}

/** Format bounded, value-safe drift evidence for logs and domain errors. */
export function formatCanonicalDrift(
  differences: readonly CanonicalDriftDifference[],
  maximum = 8
): string {
  if (differences.length === 0) return 'no drift';
  const visible = differences
    .slice(0, maximum)
    .map((difference) => `${difference.path} (${difference.kind})`)
    .join(', ');
  const remaining = differences.length - Math.min(differences.length, maximum);
  return remaining > 0 ? `${visible}, and ${remaining} more` : visible;
}
