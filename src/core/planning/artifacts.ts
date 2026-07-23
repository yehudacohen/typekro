import type {
  CapabilityRequirement,
  KubernetesIdentity,
  LifecyclePolicy,
  PlanDiagnostic,
  PlanEdge,
  PlanIterationDimension,
  PlanValue,
  ReadinessStrategyIdentity,
  SchemaIR,
  StatusProjection,
  PlanTemplateOverride,
} from './types.js';

/** Version of the experimental compiled artifact DTOs. */
export const ARTIFACT_PLAN_VERSION = 1 as const;
export const DIRECT_ARTIFACT_EXECUTION_RECORD_VERSION = 1 as const;
export const KRO_ARTIFACT_BUNDLE_VERSION = 1 as const;

/** API-server write behavior selected by a target compiler for one artifact. */
export type ArtifactApplyPolicy =
  | {
      readonly strategy: 'create-or-patch';
      readonly patchType?: 'merge' | 'strategic';
      readonly existingResource: 'warn' | 'fail' | 'patch' | 'replace';
      readonly immutableFieldPolicy: 'fail' | 'recreate';
    }
  | {
      readonly strategy: 'server-side-apply';
      readonly fieldManager: string;
      readonly fieldConflictPolicy: 'fail' | 'force-owned-fields';
      readonly immutableFieldPolicy: 'fail' | 'recreate';
    }
  | { readonly strategy: 'create-only' }
  | { readonly strategy: 'replace' };

export interface ArtifactCompilerIdentity {
  readonly id: 'typekro.direct' | 'typekro.kro';
  readonly version: number;
}

export interface ArtifactReadinessContract {
  readonly activation: readonly PlanValue[];
  readonly readyWhen: readonly PlanValue[];
  readonly strategy?: ReadinessStrategyIdentity;
}

interface ArtifactResourceBase {
  readonly id: string;
  readonly sourceNodeId?: string;
  readonly identity?: KubernetesIdentity;
  readonly desired?: PlanValue;
  readonly lifecycle: LifecyclePolicy;
  readonly readiness: ArtifactReadinessContract;
  readonly iteration?: readonly PlanIterationDimension[];
  readonly templateOverrides?: readonly PlanTemplateOverride[];
  readonly requiredCapabilities: readonly CapabilityRequirement[];
}

export interface DirectApplicationArtifact extends ArtifactResourceBase {
  readonly role: 'application-resource';
  readonly apply: ArtifactApplyPolicy;
}

export interface DirectExternalReferenceArtifact extends ArtifactResourceBase {
  readonly role: 'external-reference';
  readonly apply?: never;
}

export interface DirectCompatibilityClosureArtifact extends ArtifactResourceBase {
  readonly role: 'compatibility-closure';
  readonly apply?: never;
}

export interface DirectSupportingArtifact extends ArtifactResourceBase {
  readonly role: 'singleton-owner' | 'direct-prerequisite';
  readonly apply: ArtifactApplyPolicy;
}

export type DirectKubernetesArtifactResource =
  | DirectApplicationArtifact
  | DirectExternalReferenceArtifact
  | DirectCompatibilityClosureArtifact
  | DirectSupportingArtifact;

/** A child template reconciled by KRO. It deliberately has no TypeKro apply policy. */
export interface KroGraphChildArtifact extends ArtifactResourceBase {
  readonly role: 'kro-graph-child' | 'kro-external-reference';
  readonly apply?: never;
}

export interface KroGraphDefinitionIR {
  readonly version: 1;
  readonly name: string;
  readonly root: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly specSchema: SchemaIR;
    readonly persistedStatusSchema: SchemaIR;
  };
  readonly children: readonly KroGraphChildArtifact[];
  readonly edges: readonly PlanEdge[];
  readonly statusProjections: readonly StatusProjection[];
}

/** A prerequisite or ownership artifact installed directly by TypeKro. */
export interface KroSupportingArtifact extends ArtifactResourceBase {
  readonly role: 'kro-prerequisite' | 'hoisted-namespace' | 'singleton-owner';
  readonly apply: ArtifactApplyPolicy;
}

/** The RGD operation carries explicit graph IR rather than private compiler state. */
export interface KroResourceGraphDefinitionArtifact extends ArtifactResourceBase {
  readonly role: 'resource-graph-definition';
  readonly graph: KroGraphDefinitionIR;
  readonly apply: ArtifactApplyPolicy;
}

export interface KroInstanceArtifact extends ArtifactResourceBase {
  readonly role: 'instance';
  readonly desired: PlanValue;
  readonly apply: ArtifactApplyPolicy;
}

export type KroArtifactResource =
  | KroGraphChildArtifact
  | KroSupportingArtifact
  | KroResourceGraphDefinitionArtifact
  | KroInstanceArtifact;

interface ArtifactPlanBase<TResource> {
  readonly version: 1;
  readonly compiler: ArtifactCompilerIdentity;
  readonly planIdentityDigest: string;
  readonly compiledArtifactDigest: string;
  readonly resources: readonly TResource[];
  readonly edges: readonly PlanEdge[];
  readonly requiredCapabilities: readonly CapabilityRequirement[];
  readonly diagnostics: readonly PlanDiagnostic[];
}

export interface DirectKubernetesArtifactPlan
  extends ArtifactPlanBase<DirectKubernetesArtifactResource> {
  readonly target: 'direct';
}

/**
 * Canonical per-resource slice used by fan-out execution hosts such as Alchemy.
 * The artifact is concretized for one instance while preserving structured
 * references and the original plan/compiler identity.
 */
export interface DirectArtifactExecutionRecord {
  readonly version: 1;
  readonly target: 'direct';
  readonly planIdentityDigest: string;
  readonly compiledArtifactDigest: string;
  readonly artifact: DirectKubernetesArtifactResource;
  readonly dependencies: readonly string[];
  readonly executionDigest: string;
}

export interface KroArtifactPlan extends ArtifactPlanBase<KroArtifactResource> {
  readonly target: 'kro';
}

export type KroExecutableArtifact =
  | KroSupportingArtifact
  | KroResourceGraphDefinitionArtifact
  | KroInstanceArtifact;

/** Physical role of one directly applied operation in a complete KRO bundle. */
export type KroArtifactBundleOperationRole =
  | 'kro-prerequisite'
  | 'hoisted-namespace'
  | 'singleton-owner-rgd'
  | 'singleton-owner-instance'
  | 'resource-graph-definition'
  | 'instance';

export interface KroArtifactBundleOperationSource {
  readonly memberId: string;
  readonly planIdentityDigest: string;
  readonly compiledArtifactDigest: string;
}

/**
 * One canonical, host-independent outer KRO operation.
 *
 * Graph children remain inside the RGD artifact and are reconciled by KRO. Only
 * resources TypeKro applies directly become bundle operations.
 */
export interface KroArtifactBundleOperation {
  readonly id: string;
  readonly role: KroArtifactBundleOperationRole;
  /** Every compiled member that contributes this shared physical operation. */
  readonly sources: readonly KroArtifactBundleOperationSource[];
  readonly artifact: KroExecutableArtifact;
  /** Concrete Kubernetes manifest encoded as a canonical PlanValue. */
  readonly manifest: PlanValue;
  /** Incoming operation ids, already resolved across nested singleton plans. */
  readonly dependencies: readonly string[];
}

/** Complete physical KRO bundle consumed by every execution host/output form. */
export interface KroArtifactBundle {
  readonly version: 1;
  readonly target: 'kro';
  readonly root: {
    readonly memberId: string;
    readonly rgdOperationId: string;
    readonly instanceOperationId?: string;
  };
  /** Host/output requirements retained even when they do not become Kubernetes operations. */
  readonly requiredCapabilities: readonly CapabilityRequirement[];
  readonly operations: readonly KroArtifactBundleOperation[];
  readonly bundleDigest: string;
}

export type ArtifactPlan = DirectKubernetesArtifactPlan | KroArtifactPlan;

export interface DirectArtifactCompilerOptions {
  readonly applyPolicy?: ArtifactApplyPolicy;
  readonly strict?: boolean;
}

/** Host-independent supporting operation supplied to the KRO representation compiler. */
export interface KroSupportingArtifactCompilerInput {
  readonly id: string;
  readonly role: KroSupportingArtifact['role'];
  readonly desired: PlanValue;
  readonly identity?: KubernetesIdentity;
  readonly lifecycle: LifecyclePolicy;
  readonly readiness?: ArtifactReadinessContract;
  readonly requiredCapabilities?: readonly CapabilityRequirement[];
  readonly apply?: ArtifactApplyPolicy;
}

export interface KroArtifactCompilerOptions {
  readonly outerApplyPolicy?: ArtifactApplyPolicy;
  /** Physical RGD name selected by the factory representation. */
  readonly rgdName?: string;
  /**
   * Physical custom-resource placement and lifecycle metadata.
   *
   * These values are compiler inputs rather than semantic-plan fields because
   * the factory namespace and instance namespace are representation choices,
   * not application spec semantics.
   */
  readonly instance?: {
    readonly name: PlanValue;
    readonly namespace?: PlanValue;
    /** Concrete API version selected for the generated custom resource. */
    readonly apiVersion?: string;
    readonly kind?: string;
    /** Concrete or otherwise explicitly materializable CR spec. */
    readonly spec?: PlanValue;
    readonly labels?: PlanValue;
    readonly annotations?: PlanValue;
  };
  /** Directly managed resources that surround the KRO graph itself. */
  readonly supportingArtifacts?: readonly KroSupportingArtifactCompilerInput[];
  /** Additional typed ordering edges between outer and supporting artifacts. */
  readonly outerEdges?: readonly PlanEdge[];
  readonly strict?: boolean;
}
