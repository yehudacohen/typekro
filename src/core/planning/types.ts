import type { AnyAspectDefinition } from '../aspects/types.js';
import type { KubernetesResource } from '../types/kubernetes.js';

/** Version of the experimental semantic planning DTOs. */
export const SEMANTIC_PLAN_VERSION = 1 as const;

/** Stable JSON-compatible primitive. */
export type PlanPrimitive = string | number | boolean | null;

/** Source location attached to a planning diagnostic when available. */
export interface PlanSourceLocation {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

/** Structured diagnostic returned by inspection, planning, and canonicalization. */
export interface PlanDiagnostic {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly path?: string;
  readonly location?: PlanSourceLocation;
  readonly details?: Readonly<Record<string, PlanPrimitive>>;
}

/** Reference captured by portable expression IR. */
export interface ExpressionReferenceIR {
  readonly source: 'spec' | 'resource';
  readonly resourceId?: string;
  readonly fieldPath: string;
}

/**
 * Canonical expression accepted by the Gate B compatibility frontend.
 *
 * Natural TypeScript, computed expressions, and explicit CEL all lower to this
 * representation before direct evaluation or KRO emission. Raw CEL remains
 * explicitly target-constrained.
 */
export interface ExpressionIR {
  readonly version: 1;
  readonly language: 'portable-cel' | 'raw-cel';
  readonly expression: string;
  readonly references: readonly ExpressionReferenceIR[];
  readonly sensitivity: 'public' | 'sensitive';
  readonly sourceLocation?: PlanSourceLocation;
}

export interface PlanLiteralValue {
  readonly kind: 'literal';
  readonly value: PlanPrimitive;
}

export interface PlanArrayValue {
  readonly kind: 'array';
  readonly items: readonly PlanValue[];
}

export interface PlanObjectEntry {
  readonly key: string;
  readonly value: PlanValue;
}

export interface PlanObjectValue {
  readonly kind: 'object';
  readonly entries: readonly PlanObjectEntry[];
}

export interface PlanReferenceValue {
  readonly kind: 'reference';
  readonly source: 'spec' | 'resource';
  readonly resourceId?: string;
  readonly fieldPath: string;
  /** Absence is a valid value and omits the containing materialized field. */
  readonly optional?: true;
  /** The producer is a flattened composition boundary, not a Kubernetes child. */
  readonly nestedComposition?: true;
}

export interface PlanExpressionValue {
  readonly kind: 'expression';
  readonly expression: ExpressionIR;
}

export type PlanTemplateSegment =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'expression'; readonly expression: ExpressionIR }
  | {
      readonly kind: 'reference';
      readonly source: 'spec' | 'resource';
      readonly resourceId?: string;
      readonly fieldPath: string;
      /** Absence omits the complete containing template value. */
      readonly optional?: true;
      /** The producer is a flattened composition boundary, not a Kubernetes child. */
      readonly nestedComposition?: true;
    };

/** String template with references preserved as typed segments. */
export interface PlanTemplateValue {
  readonly kind: 'template';
  readonly segments: readonly PlanTemplateSegment[];
}

export interface PlanOmittedValue {
  readonly kind: 'omitted';
}

export interface SensitiveValueRef {
  readonly kind: 'sensitive-binding';
  readonly binding: string;
  readonly version?: string;
}

/**
 * A symbolic or derived value whose materialized result is sensitive.
 *
 * The wrapped value must itself be safe to serialize. In particular, this is
 * used for spec/resource references and portable expressions that feed a
 * Kubernetes Secret; it is never a container for inline plaintext bytes.
 */
export interface PlanSensitiveValue {
  readonly kind: 'sensitive-value';
  readonly value: PlanValue;
}

export interface ExternalInputRef {
  readonly kind: 'external-input';
  readonly name: string;
}

export interface ArtifactOutputRef {
  readonly kind: 'artifact-output';
  readonly requirementId: string;
  readonly output: string;
}

/** Canonical, unambiguous value tree used by semantic plans. */
export type PlanValue =
  | PlanLiteralValue
  | PlanArrayValue
  | PlanObjectValue
  | PlanReferenceValue
  | PlanExpressionValue
  | PlanTemplateValue
  | PlanOmittedValue
  | SensitiveValueRef
  | PlanSensitiveValue
  | ExternalInputRef
  | ArtifactOutputRef;

/** Result of lowering a runtime authoring value into canonical plan form. */
export interface PlanValueLoweringResult {
  readonly value: PlanValue;
  readonly diagnostics: readonly PlanDiagnostic[];
  readonly sensitivity: 'public' | 'sensitive';
}

export interface SchemaPropertyIR {
  readonly name: string;
  readonly required: boolean;
  readonly schema: SchemaNodeIR;
  readonly defaultValue?: PlanValue;
}

/** Canonical constraint values supported by the portable schema profile. */
export type SchemaConstraintValue = PlanPrimitive | readonly PlanPrimitive[];

export type SchemaNodeIR =
  | {
      readonly kind: 'primitive';
      readonly type: 'string' | 'number' | 'boolean' | 'null' | 'unknown';
      readonly constraints?: Readonly<Record<string, SchemaConstraintValue>>;
    }
  | { readonly kind: 'literal'; readonly value: PlanPrimitive }
  | { readonly kind: 'array'; readonly items: SchemaNodeIR }
  | { readonly kind: 'object'; readonly properties: readonly SchemaPropertyIR[] }
  | { readonly kind: 'union'; readonly variants: readonly SchemaNodeIR[] }
  | { readonly kind: 'unsupported'; readonly description: string; readonly raw: PlanValue };

/** Versioned canonical schema representation derived from ArkType JSON. */
export interface SchemaIR {
  readonly version: 1;
  readonly root: SchemaNodeIR;
  readonly digest: string;
  readonly diagnostics: readonly PlanDiagnostic[];
}

export type CompositionIdentity =
  | {
      readonly name: string;
      readonly apiVersion: string;
      readonly kind: string;
      readonly stability: 'stable';
      readonly revision:
        | { readonly kind: 'version'; readonly value: string }
        | { readonly kind: 'bundle-digest'; readonly value: string };
      readonly diagnosticSourceDigest?: string;
    }
  | {
      readonly name: string;
      readonly apiVersion: string;
      readonly kind: string;
      readonly stability: 'preview-unstable';
      readonly diagnosticSourceDigest: string;
    };

export interface CapabilityRequirement {
  readonly id: string;
  readonly version: number;
  /** Deployment representation required by this capability. */
  readonly target?: 'direct' | 'kro';
  /** Execution host required to satisfy this capability. */
  readonly host?: 'standalone' | 'alchemy';
  /** Output form required to satisfy this capability. */
  readonly output?: 'live' | 'static';
  readonly nodeId?: string;
}

export interface StatusProjection {
  readonly path: string;
  readonly source: 'live-resource' | 'desired-spec' | 'static' | 'derived' | 'client-only';
  readonly mode: 'auto' | 'native' | 'relay' | 'client-only';
  readonly persistedPath?: string;
  readonly value?: PlanValue;
}

export interface StatusContract {
  readonly persistedSchema: SchemaIR;
  readonly hydratedSchema: SchemaIR;
  readonly projections: readonly StatusProjection[];
}

export interface AspectManifestEntry {
  readonly id: string;
  readonly revision: string;
  readonly configuration: PlanValue;
  readonly order: number;
}

export interface OrdinaryInputBinding {
  readonly kind: 'ordinary';
  readonly value: unknown;
}

export interface SensitiveInputBinding {
  readonly kind: 'sensitive';
  readonly binding: string;
  readonly version?: string;
}

export interface ArtifactInputBinding {
  readonly kind: 'artifact';
  readonly requirement: ArtifactRequirement;
}

export type DeclaredInputBinding =
  | OrdinaryInputBinding
  | SensitiveInputBinding
  | ArtifactInputBinding;

export type DeclaredInputManifestEntry =
  | { readonly name: string; readonly kind: 'ordinary'; readonly value: PlanValue }
  | {
      readonly name: string;
      readonly kind: 'sensitive';
      readonly binding: string;
      readonly version?: string;
    }
  | { readonly name: string; readonly kind: 'artifact'; readonly requirement: ArtifactRequirement };

export interface ArtifactRequirement {
  readonly kind: string;
  readonly id: string;
  readonly descriptor: PlanValue;
  readonly outputs: readonly string[];
}

export interface RepresentationRequirement {
  readonly target: 'direct' | 'kro';
  readonly kind: string;
  readonly extension: string;
  readonly version: number;
  readonly inputs: PlanValue;
  readonly sourceNodeId?: string;
  readonly factoryName?: string;
}

export interface CanonicalizerManifestEntry {
  readonly id: string;
  readonly revision: string;
  readonly stage: 'desired';
  /** Factory registration whose resource caused this canonicalizer to run. */
  readonly factoryName?: string;
}

export interface PlanOptions {
  readonly aspects?: readonly AnyAspectDefinition[];
  readonly inputs?: Readonly<Record<string, DeclaredInputBinding>>;
  readonly strict?: boolean;
}

export interface CompositionInspection {
  readonly version: 1;
  readonly composition: CompositionIdentity;
  readonly specSchema: SchemaIR;
  readonly status: StatusContract;
  readonly potentialCapabilities: readonly CapabilityRequirement[];
  readonly diagnostics: readonly PlanDiagnostic[];
}

export interface LogicalInstanceIdentity {
  readonly composition: string;
  readonly name: PlanValue;
}

export interface KubernetesIdentity {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: PlanValue;
  readonly namespace?: PlanValue;
  readonly scope: 'cluster' | 'namespaced';
}

export interface UnusedEvidence {
  readonly provider: string;
  readonly version: number;
  readonly inputs: PlanValue;
}

export interface LifecyclePolicy {
  readonly creation: 'create' | 'adopt' | 'require-existing';
  readonly management: 'authoritative' | 'cooperative' | 'reference-only';
  readonly deletion: 'delete' | 'retain' | 'delete-when-unused';
  readonly instancing:
    | { readonly kind: 'per-instance' }
    | { readonly kind: 'per-scope'; readonly key: PlanValue }
    | { readonly kind: 'per-cluster' };
  readonly sharing: 'exclusive' | 'shareable';
  readonly unusedEvidence?: UnusedEvidence;
}

/** Serializable identity for the client-side strategy used to evaluate readiness. */
export interface RuntimeReadinessClassification {
  readonly reason:
    | 'ambient-clock'
    | 'ambient-state'
    | 'host-callback'
    | 'opaque-code'
    | 'unclassified-evaluator';
  readonly description?: string;
}

export type ReadinessStrategyIdentity =
  | {
      readonly kind: 'registered';
      readonly id: string;
      readonly revision: string;
      readonly configuration?: PlanValue;
    }
  | {
      readonly kind: 'runtime-binding';
      readonly binding: string;
      readonly version: 1;
      /**
       * Why this evaluator cannot be reconstructed from canonical artifact data.
       * Optional only for decoding persisted experimental records created before
       * runtime readiness classification was introduced.
       */
      readonly classification?: RuntimeReadinessClassification;
    };

export interface PlanTemplateOverride {
  readonly propertyPath: string;
  readonly value: PlanValue;
}

/** One analyzer-proven collection dimension shared by direct and KRO lowering. */
export interface PlanIterationDimension {
  /** Stable source-level iterator variable used by portable collection expressions. */
  readonly variable: string;
  /** Portable expression that evaluates to the collection for this dimension. */
  readonly collection: PlanValue;
  /** Canonical schema-proxy path whose `$item` sentinel is bound by this dimension. */
  readonly itemPath: string;
}

export interface PlanNode {
  readonly id: string;
  readonly type: 'kubernetes-resource' | 'compatibility-closure';
  readonly identity?: KubernetesIdentity;
  readonly desired?: PlanValue;
  readonly lifecycle: LifecyclePolicy;
  readonly activation: readonly PlanValue[];
  readonly readiness: readonly PlanValue[];
  readonly readinessStrategy?: ReadinessStrategyIdentity;
  /** Analyzer-proven collection dimensions retained for both target compilers. */
  readonly iteration?: readonly PlanIterationDimension[];
  /** Analyzer-produced property replacements applied after template lowering. */
  readonly templateOverrides?: readonly PlanTemplateOverride[];
  readonly requiredCapabilities: readonly CapabilityRequirement[];
}

export type PlanEdge =
  | {
      readonly kind: 'output';
      readonly producer: string;
      readonly consumer: string;
      readonly output: string;
    }
  | {
      readonly kind: 'existence' | 'ready';
      readonly prerequisite: string;
      readonly dependent: string;
    }
  | { readonly kind: 'ownership'; readonly owner: string; readonly child: string }
  | { readonly kind: 'delete-after'; readonly resource: string; readonly blocker: string };

export interface DesiredStatePlan {
  readonly version: 1;
  readonly composition: CompositionIdentity;
  readonly schemas: {
    readonly irVersion: 1;
    readonly spec: SchemaIR;
    readonly specDigest: string;
    readonly persistedStatusDigest: string;
    readonly hydratedStatusDigest: string;
  };
  readonly status: StatusContract;
  readonly instance: LogicalInstanceIdentity;
  readonly spec: PlanValue;
  readonly nodes: readonly PlanNode[];
  readonly edges: readonly PlanEdge[];
  readonly outputs: Readonly<Record<string, PlanValue>>;
  readonly inputs: readonly DeclaredInputManifestEntry[];
  readonly aspects: readonly AspectManifestEntry[];
  readonly representationRequirements: readonly RepresentationRequirement[];
  readonly provenance: {
    readonly canonicalizers: readonly CanonicalizerManifestEntry[];
  };
  readonly requiredCapabilities: readonly CapabilityRequirement[];
  readonly durability: {
    readonly cacheEligible: boolean;
    readonly provenanceEligible: boolean;
    readonly reasons: readonly PlanDiagnostic[];
  };
  readonly inputDigest: string;
  readonly aspectDigest: string;
  readonly semanticContentDigest: string;
  readonly planIdentityDigest: string;
  readonly diagnostics: readonly PlanDiagnostic[];
}

/** Internal capture shared by inspection and planning. */
export interface CapturedCompositionIR {
  readonly version: 1;
  readonly definition: {
    readonly name: string;
    readonly apiVersion: string;
    readonly kind: string;
    readonly group?: string;
    readonly revision?: string;
    readonly specSchema: { readonly json?: unknown };
    readonly statusSchema: { readonly json?: unknown };
  };
  readonly resources: Readonly<Record<string, KubernetesResource>>;
  readonly statusMappings: Readonly<Record<string, unknown>>;
  /** Flattened nested-composition outputs used to classify virtual status references. */
  readonly nestedStatusMappings: Readonly<Record<string, string>>;
  readonly compatibilityClosures: readonly string[];
  readonly potentialCapabilities: readonly CapabilityRequirement[];
  readonly canonicalizers: readonly CanonicalizerManifestEntry[];
}
