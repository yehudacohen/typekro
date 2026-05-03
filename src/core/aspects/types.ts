import type { TypeKroError } from '../errors.js';
import type { KroCompatibleType } from '../types/schema.js';

/** Kubernetes image pull policy values supported by workload override aspects. */
export type ImagePullPolicy = 'Always' | 'IfNotPresent' | 'Never';

/** Cardinality required after an aspect target and selector are evaluated. */
export type AspectCardinality = 'one-or-more' | 'zero-or-more' | 'exactly-one';

/** Public aspect surface identifiers. */
export type AspectSurfaceKind = 'metadata' | 'override';

/** Runtime mode in which aspect safety is evaluated. */
export type AspectMode = 'direct' | 'kro';

/** Supported aspect operation kinds. */
export type AspectOperationKind = 'replace' | 'merge' | 'append';

/** Object-form selector for narrowing resources matched by an aspect target. */
export interface AspectSelector {
  readonly slot?: string;
  readonly id?: string;
  readonly name?: string;
  readonly namespace?: string;
  readonly kind?: string;
  readonly labels?: Record<string, string>;
}

/** Replaces a curated field with the provided value. */
export interface ReplaceOperation<T> {
  readonly kind: 'replace';
  readonly value: T;
}

/** Merges keys into a concrete object field. */
export interface MergeOperation<T extends object> {
  readonly kind: 'merge';
  readonly value: Partial<T>;
}

/** Appends values into a concrete array field. */
export interface AppendOperation<TElement> {
  readonly kind: 'append';
  readonly value: readonly TElement[];
}

/** Any v1 aspect operation descriptor. */
export type AspectOperation<T> = ReplaceOperation<T> | MergeOperation<object> | AppendOperation<T>;

/** Resource-level metadata mutation surface. */
export interface MetadataAspectSurface {
  readonly kind: 'metadata';
  readonly labels?:
    | ReplaceOperation<Record<string, string>>
    | MergeOperation<Record<string, string>>;
  readonly annotations?:
    | ReplaceOperation<Record<string, string>>
    | MergeOperation<Record<string, string>>;
}

/** Writable resource schema advertised by aspect-capable resources. */
export interface ResourceSpecOverrideSchema<TSpec extends object = Record<string, unknown>> {
  readonly spec: TSpec;
}

/** Dotted writable field path rooted at `spec`; status and identity metadata are excluded. */
export type AspectFieldPath = 'spec' | `spec.${string}`;

/** Validation constraints enforced before an aspect mutates resources. */
export interface AspectValidationPolicy {
  readonly allowedRootField: 'spec';
  readonly deniedRootFields: readonly ('apiVersion' | 'kind' | 'metadata' | 'status')[];
  readonly deniedMetadataFields: readonly ('name' | 'namespace' | 'uid' | 'resourceVersion')[];
  readonly kroUnsafeOperations: readonly (
    | 'merge-reference-backed-composite'
    | 'append-reference-backed-composite'
  )[];
}

/** Operation descriptor accepted for a single writable schema field. */
export type AspectPatchValue<T> = T extends readonly (infer TElement)[]
  ? ReplaceOperation<T> | AppendOperation<TElement>
  : T extends object
    ? ReplaceOperation<T> | MergeOperation<T>
    : ReplaceOperation<T>;

/** Partial recursive patch shape derived from an advertised writable aspect schema. */
export type AspectOverridePatch<TSchema> = {
  readonly [K in keyof TSchema]?: TSchema[K] extends readonly unknown[]
    ? AspectPatchValue<TSchema[K]>
    : TSchema[K] extends object
      ? AspectPatchValue<TSchema[K]> | AspectOverridePatch<TSchema[K]>
      : AspectPatchValue<TSchema[K]>;
};

/** Override mutation surface derived from a target's writable aspect schema. */
export interface OverrideAspectSurface<TSchema extends object = ResourceSpecOverrideSchema> {
  readonly kind: 'override';
  readonly patch: AspectOverridePatch<TSchema>;
}

/** Any public aspect surface descriptor. */
export type AspectSurface =
  | MetadataAspectSurface
  | OverrideAspectSurface<ResourceSpecOverrideSchema>;

/** Callable factory target identity accepted by aspect.on(...). */
export type AspectFactoryTarget<
  TSurfaces extends AspectSurfaceKind = 'metadata',
  TOverrideSchema extends object = never,
> = AspectFactoryTargetFunction & AspectFactoryTargetBrand<TSurfaces, TOverrideSchema>;

/** Callable factory target that supports resource override aspects. */
export type ResourceAspectFactoryTarget<
  TOverrideSchema extends object = ResourceSpecOverrideSchema,
> = AspectFactoryTarget<'metadata' | 'override', TOverrideSchema>;

/** Callable factory target that supports the v1 override surface. */
export type WorkloadAspectFactoryTarget<
  TOverrideSchema extends object = ResourceSpecOverrideSchema,
> = ResourceAspectFactoryTarget<TOverrideSchema>;

/** Callable target identity only; aspect.on(...) must never invoke the factory. */
export type AspectFactoryTargetFunction = (...args: never[]) => object;

/** Optional compile-time marker for factories that advertise aspect surfaces. */
export interface AspectFactoryTargetBrand<
  TSurfaces extends AspectSurfaceKind,
  TOverrideSchema extends object,
> {
  readonly __typekroAspectTarget?: true;
  readonly __typekroAspectSurfaces?: TSurfaces;
  readonly __typekroAspectOverrideSchema?: TOverrideSchema;
}

/** Normalized internal factory target descriptor. */
export interface FactoryAspectTargetDescriptor {
  readonly kind: 'factory-target';
  readonly id: string;
  readonly surfaces: readonly AspectSurfaceKind[];
}

/** Public aspect target group descriptor. */
export interface AspectTargetGroup<
  TId extends 'allResources' | 'resources' | 'workloads' =
    | 'allResources'
    | 'resources'
    | 'workloads',
> {
  readonly kind: 'target-group';
  readonly id: TId;
}

/** Any public aspect target accepted by aspect.on(...); runtime metadata is authoritative. */
export type AspectTarget = AspectFactoryTarget<AspectSurfaceKind, object> | AspectTargetGroup;

/** Writable override schema advertised by a target where TypeScript can infer it. */
export type AspectOverrideSchemaForTarget<TTarget> = TTarget extends typeof workloads
  ? ResourceSpecOverrideSchema
  : TTarget extends typeof resources
    ? ResourceSpecOverrideSchema
    : TTarget extends AspectFactoryTarget<infer _TSurfaces, infer TOverrideSchema>
      ? TOverrideSchema
      : never;

/** Keys present on both writable schemas. */
export type CommonAspectSchemaKeys<TLeft, TRight> = Extract<keyof TLeft, keyof TRight>;

/** Compatible value shared by two writable schemas. */
export type CommonAspectSchemaValue<TLeft, TRight> = [TLeft] extends [TRight]
  ? TLeft
  : [TRight] extends [TLeft]
    ? TRight
    : TLeft extends object
      ? TRight extends object
        ? CommonAspectSchema<TLeft, TRight>
        : never
      : never;

/** Recursively common writable schema for two targets; target-specific fields are excluded. */
export type CommonAspectSchema<TLeft, TRight> = {
  readonly [K in CommonAspectSchemaKeys<TLeft, TRight> as CommonAspectSchemaValue<
    TLeft[K],
    TRight[K]
  > extends never
    ? never
    : K]: CommonAspectSchemaValue<TLeft[K], TRight[K]>;
};

/** Recursively common writable schema for a tuple of aspect targets. */
export type CommonAspectSchemaForTargets<TTargets extends readonly AspectTarget[]> =
  TTargets extends readonly [infer THead, infer TNext, ...infer TTail]
    ? THead extends AspectTarget
      ? TNext extends AspectTarget
        ? TTail extends readonly AspectTarget[]
          ? CommonAspectSchemaForTargets<
              readonly [
                AspectFactoryTarget<
                  'override',
                  CommonAspectSchema<
                    AspectOverrideSchemaForTarget<THead>,
                    AspectOverrideSchemaForTarget<TNext>
                  >
                >,
                ...TTail,
              ]
            >
          : CommonAspectSchema<
              AspectOverrideSchemaForTarget<THead>,
              AspectOverrideSchemaForTarget<TNext>
            >
        : never
      : never
    : TTargets extends readonly [infer TOnly]
      ? TOnly extends AspectTarget
        ? AspectOverrideSchemaForTarget<TOnly>
        : never
      : never;

/** Surface accepted for a target where compile-time narrowing is feasible. */
export type AspectSurfaceForTarget<TTarget> = TTarget extends typeof allResources
  ? MetadataAspectSurface
  : TTarget extends typeof resources
    ? OverrideAspectSurface<ResourceSpecOverrideSchema>
    : TTarget extends typeof workloads
      ? OverrideAspectSurface<ResourceSpecOverrideSchema>
      : TTarget extends ResourceAspectFactoryTarget<infer TOverrideSchema>
        ? MetadataAspectSurface | OverrideAspectSurface<TOverrideSchema>
        : TTarget extends AspectFactoryTarget<'metadata'>
          ? MetadataAspectSurface
          : never;

/** Surface kind advertised by a target where TypeScript can infer it. */
export type AspectSurfaceKindForTarget<TTarget> = TTarget extends typeof allResources
  ? 'metadata'
  : TTarget extends typeof resources
    ? 'override'
    : TTarget extends typeof workloads
      ? 'override'
      : TTarget extends AspectFactoryTarget<infer TSurfaces, infer _TOverrideSchema>
        ? TSurfaces
        : never;

/** Best-effort intersection of target surfaces for array targets. */
export type CommonAspectSurfaceKindForTargets<
  TTargets extends readonly AspectTarget[],
  TCommon extends AspectSurfaceKind = AspectSurfaceKind,
> = TTargets extends readonly [infer THead, ...infer TTail]
  ? THead extends AspectTarget
    ? TTail extends readonly AspectTarget[]
      ? CommonAspectSurfaceKindForTargets<
          TTail,
          Extract<TCommon, AspectSurfaceKindForTarget<THead>>
        >
      : Extract<TCommon, AspectSurfaceKindForTarget<THead>>
    : never
  : TCommon;

/** Compatible target arrays share at least one statically visible surface. */
export type CompatibleAspectTargets<TTargets extends readonly AspectTarget[]> =
  CommonAspectSurfaceKindForTargets<TTargets> extends never ? never : TTargets;

/** Surface union for a common surface-kind set. */
export type AspectSurfaceForCommonKinds<
  TKind extends AspectSurfaceKind,
  TTargets extends readonly AspectTarget[],
> =
  | (Extract<TKind, 'metadata'> extends never ? never : MetadataAspectSurface)
  | (Extract<TKind, 'override'> extends never
      ? never
      : OverrideAspectSurface<CommonAspectSchemaForTargets<TTargets>>);

/** Common surface for target arrays; runtime metadata remains authoritative when inference is broad. */
export type CommonAspectSurfaceForTargets<TTargets extends readonly AspectTarget[]> =
  AspectSurfaceForCommonKinds<CommonAspectSurfaceKindForTargets<TTargets>, TTargets>;

/** Immutable aspect definition returned by aspect.on(...). */
export interface AspectDefinition<
  TTarget = AspectTarget | readonly AspectTarget[],
  TSurface = AspectSurface,
> {
  readonly kind: 'aspect';
  readonly target: TTarget;
  readonly surface: TSurface;
  readonly selector?: AspectSelector;
  readonly cardinality: AspectCardinality;
  /** @throws AspectDefinitionError when the selector conflicts with an existing selector. */
  where(selector: AspectSelector): AspectDefinition<TTarget, TSurface>;
  /** @throws AspectDefinitionError when called after expectOne(). */
  optional(): AspectDefinition<TTarget, TSurface>;
  /** @throws AspectDefinitionError when called after optional(). */
  expectOne(): AspectDefinition<TTarget, TSurface>;
}

/** Public aspect builder. */
export interface AspectBuilder {
  /** @throws AspectDefinitionError when target metadata or surface compatibility is invalid. */
  on<TTarget extends AspectTarget>(
    target: TTarget,
    surface: AspectSurfaceForTarget<TTarget>
  ): AspectDefinition<TTarget, AspectSurfaceForTarget<TTarget>>;
  /** @throws AspectDefinitionError when target metadata or common surface compatibility is invalid. */
  on<const TTargets extends readonly AspectTarget[]>(
    targets: CompatibleAspectTargets<TTargets>,
    surface: CommonAspectSurfaceForTargets<TTargets>
  ): AspectDefinition<TTargets, CommonAspectSurfaceForTargets<TTargets>>;
}

/** Options for render-time aspect application. */
export interface ToYamlOptions {
  readonly aspects: readonly AspectDefinition[];
}

/** WeakMap-only metadata used for aspect matching. */
export interface ResourceAspectMetadata {
  readonly factoryTarget?: string;
  readonly targetGroups?: readonly string[];
  readonly surfaces?: readonly AspectSurfaceKind[];
  readonly slot?: string;
  readonly id?: string;
  readonly name?: string;
  readonly namespace?: string;
  readonly kind?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

/** Internal options shared by direct, Kro, and render-time application paths. */
export interface ApplyAspectsOptions {
  readonly mode: AspectMode;
  readonly aspects: readonly AspectDefinition[];
}

/** Summary for one aspect's target/selector matching result. */
export interface AspectMatchSummary {
  readonly aspectIndex: number;
  readonly target: string;
  readonly selector?: AspectSelector;
  readonly matchCount: number;
  readonly matchedResourceIds: readonly string[];
}

/** Result returned by the shared aspect application layer. */
export interface ApplyAspectsResult<TResources> {
  readonly resources: TResources;
  readonly matchSummary: readonly AspectMatchSummary[];
}

/** Context used when validating mode-specific aspect safety. */
export interface AspectSafetyContext {
  readonly mode: AspectMode;
  readonly resourceId?: string;
  readonly resourceKind?: string;
  readonly resourceName?: string;
  readonly surface: AspectSurfaceKind;
  readonly fieldPath: AspectFieldPath;
  readonly operation: AspectOperationKind;
}

/** Diagnostic policy for aspect errors and optional debug output. */
export interface AspectDiagnosticsPolicy {
  /** Successful application is quiet by default; no health, metric, or log stream is required. */
  readonly emitSuccessEvents: false;
  /** Error diagnostics may include resource identity, selector, mode, operation, and field path. */
  readonly allowedErrorFields: readonly (
    | 'aspectIndex'
    | 'target'
    | 'selector'
    | 'matchCount'
    | 'resourceId'
    | 'resourceKind'
    | 'resourceName'
    | 'mode'
    | 'surface'
    | 'operation'
    | 'fieldPath'
    | 'reason'
  )[];
  /** Error diagnostics must not include secret-bearing values or full manifests. */
  readonly redactedErrorFields: readonly (
    | 'operationValue'
    | 'resourceManifest'
    | 'envValue'
    | 'secretData'
    | 'configMapData'
    | 'serializedAspectPayload'
  )[];
}

/** Error thrown for invalid aspect definitions before resource application. */
export declare class AspectDefinitionError extends TypeKroError {
  readonly functionName:
    | 'aspect.on'
    | 'metadata'
    | 'override'
    | 'replace'
    | 'merge'
    | 'append'
    | 'slot';
  readonly reason: string;
}

/** Error thrown while applying aspects to matched resources. */
export declare class AspectApplicationError extends TypeKroError {
  readonly aspectIndex: number;
  readonly target: string;
  readonly selector?: AspectSelector;
  readonly matchCount?: number;
  readonly resourceId?: string;
  readonly resourceKind?: string;
  readonly resourceName?: string;
  readonly mode: AspectMode;
  readonly surface?: AspectSurfaceKind;
  readonly operation?: AspectOperationKind;
  readonly fieldPath?: string;
  readonly reason: string;
}

export declare const allResources: AspectTargetGroup<'allResources'>;
/**
 * All schema-capable resources.
 *
 * Design decision: broad `resources` targeting supersedes the earlier workload-only
 * target group so Service and future schema-bearing resources can receive typed
 * overrides without adding one target group per Kubernetes kind. The tradeoff is
 * that concrete factory targets still provide stronger type narrowing, while this
 * group relies on runtime advertised schemas or conservative current-spec schema
 * inference. Use `allResources` for metadata-only stack-wide mutation.
 */
export declare const resources: AspectTargetGroup<'resources'>;
/**
 * Workload-focused compatibility group for Deployment and StatefulSet-style overrides.
 *
 * Prefer `resources` when the intent is any schema-capable resource, or concrete
 * factory targets such as `simple.Deployment` when the intent is kind-specific
 * type narrowing.
 */
export declare const workloads: AspectTargetGroup<'workloads'>;
export declare const aspect: AspectBuilder;
/** @throws AspectDefinitionError when value is not valid for the selected surface field. */
export declare function replace<T>(value: T): ReplaceOperation<T>;
/** @throws AspectDefinitionError when value is not a concrete object merge patch. */
export declare function merge<T extends object>(value: Partial<T>): MergeOperation<T>;
/** @throws AspectDefinitionError when value is not a concrete array append payload. */
export declare function append<TElement>(value: readonly TElement[]): AppendOperation<TElement>;
/** @throws AspectDefinitionError when metadata fields contain unsupported operations. */
export declare function metadata(
  surface: Omit<MetadataAspectSurface, 'kind'>
): MetadataAspectSurface;
/** @throws AspectDefinitionError when override fields contain unsupported operations. */
export declare function override<TSchema extends object>(
  patch: AspectOverridePatch<TSchema>
): OverrideAspectSurface<TSchema>;
/** @throws AspectDefinitionError when the slot name is empty or already assigned incompatibly. */
export declare function slot<TResource extends object>(
  name: string,
  resource: TResource
): TResource;

declare module '../types/deployment.js' {
  interface PublicFactoryOptions {
    /** Ordered aspects applied before factory resources are rendered or deployed. */
    aspects?: readonly AspectDefinition[];
  }

  interface TypedResourceGraph<
    // biome-ignore lint/correctness/noUnusedVariables: name must match merged interface type parameter.
    TSpec extends KroCompatibleType = KroCompatibleType,
    // biome-ignore lint/correctness/noUnusedVariables: name must match merged interface type parameter.
    TStatus extends KroCompatibleType = KroCompatibleType,
  > {
    /** @throws AspectApplicationError when render-time aspects fail target, selector, schema, or Kro-safety validation. */
    toYaml(options: ToYamlOptions): string;
  }
}

declare module '../types/resource-graph.js' {
  interface ResourceGraph<
    // biome-ignore lint/correctness/noUnusedVariables: name must match merged interface type parameter.
    TSpec extends KroCompatibleType = KroCompatibleType,
    // biome-ignore lint/correctness/noUnusedVariables: name must match merged interface type parameter.
    TStatus extends KroCompatibleType = KroCompatibleType,
  > {
    /** @throws AspectApplicationError when render-time aspects fail target, selector, schema, or Kro-safety validation. */
    toYaml(options: ToYamlOptions): string;
  }
}
