/**
 * Serialization and Kro-related types
 */

import type { Type } from 'arktype';
import type { MagicAssignable } from './common.js';
import type {
  AlchemyDeploymentOptions,
  DeploymentOperationStatus,
  DeploymentOptions,
  DeploymentResult,
  RollbackResult,
} from './deployment.js';
import type { Enhanced } from './kubernetes.js';
import type { KroCompatibleType, Prev, SchemaProxy } from './schema.js';

// Re-export schema types for backward compatibility (originally defined here)
export type {
  InferType,
  KroCompatibleType,
  KroCompatibleValue,
  SchemaProxy,
  Scope,
} from './schema.js';

// =============================================================================
// KRO SERIALIZATION & DEPENDENCY TYPES
// =============================================================================

export interface KroResourceGraphDefinition {
  apiVersion: 'kro.run/v1alpha1';
  kind: 'ResourceGraphDefinition';
  metadata: { name: string; namespace?: string; annotations?: Record<string, string> };
  spec: {
    schema: KroSimpleSchema;
    resources: KroResourceTemplate[];
  };
}

export interface KroSimpleSchema {
  apiVersion: string;
  kind: string;
  /** Custom API group for the CRD (defaults to 'kro.run' in Kro) */
  group?: string;
  spec: Record<string, string>;
  status?: Record<string, string>;
}

export interface KroFieldDefinition {
  type: string;
  markers?: string;
}

/**
 * Kro v0.8.x externalRef definition — references a pre-existing resource
 * that is not managed by Kro but can be referenced in expressions.
 */
export interface KroExternalRef {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
  };
}

/**
 * Kro v0.8.x forEach dimension — one variable mapping per dimension.
 * Each entry is `{ variableName: "CEL expression yielding a list" }`.
 */
export type KroForEachDimension = Record<string, string>;

export interface KroResourceTemplate {
  id: string;
  /** The Kubernetes resource template. Mutually exclusive with externalRef. */
  template?: unknown;
  /** External reference to a pre-existing resource. Mutually exclusive with template. */
  externalRef?: KroExternalRef;
  /** CEL boolean expressions — all must be true for this resource to be created. */
  includeWhen?: string[];
  /** CEL boolean expressions — all must be true for this resource to be considered ready. */
  readyWhen?: string[];
  /** Collection dimensions — each dimension maps a variable to a CEL list expression. */
  forEach?: KroForEachDimension[];
}

// =============================================================================
// KRO SIMPLE SCHEMA CONSTRAINTS
// =============================================================================

/**
 * Valid Kro Simple Schema basic field types
 * Based on: https://kro.run/docs/concepts/simple-schema/
 */
export type KroSchemaBasicType = 'string' | 'integer' | 'boolean' | 'float';

/**
 * Recursive type for nested Kro schema structures with depth limit
 * This models how Kro handles nested objects through custom types
 */
type KroNestedType<Depth extends number = 10> = Depth extends 0
  ? never
  : {
      [K in string]:
        | KroSchemaBasicType
        | `[]${KroSchemaBasicType}`
        | `map[string]${KroSchemaBasicType}`
        | KroNestedType<Prev<Depth>>
        | `[]${string}` // Arrays of custom types
        | `map[string]${string}`; // Maps of custom types
    };

/**
 * Valid Kro Simple Schema field types with proper nesting support
 * This accurately models Kro's type system including nested objects
 */
export type KroSchemaFieldType =
  | KroSchemaBasicType // Basic types: string, integer, boolean, float
  | `[]${KroSchemaBasicType}` // Arrays of basic types: []string, []integer, etc.
  | `[][]${KroSchemaBasicType}` // Nested arrays: [][]string (limited depth)
  | `[][][]${KroSchemaBasicType}` // Triple nested arrays: [][][]string
  | `map[string]${KroSchemaBasicType}` // Maps of basic types: map[string]string, etc.
  | `map[string][]${KroSchemaBasicType}` // Maps of arrays: map[string][]string
  | `[]map[string]${KroSchemaBasicType}` // Arrays of maps: []map[string]string
  | `map[string]map[string]${KroSchemaBasicType}` // Nested maps: map[string]map[string]string
  | string; // Custom type names (defined in types section)

/**
 * Represents a complete Kro schema type definition that can include custom types
 */
export interface KroSchemaTypeDefinition {
  /**
   * Basic spec and status fields using simple field types
   */
  spec?: Record<string, KroSchemaFieldType | KroSchemaField>;
  status?: Record<string, KroSchemaFieldType | KroSchemaField>;

  /**
   * Custom type definitions for nested objects
   * These enable complex nested structures while maintaining Kro compatibility
   */
  types?: Record<string, KroNestedType>;
}

/**
 * A Kro Simple Schema field definition with validation markers
 */
export interface KroSchemaField {
  type: KroSchemaFieldType;
  required?: boolean;
  default?: string | number | boolean;
  description?: string;
  enum?: string;
  minimum?: number;
  maximum?: number;
}

// =============================================================================
// SCHEMA PROXY & BUILDER FUNCTION TYPES
// =============================================================================

/**
 * A typed version of KroResourceGraphDefinition that includes type information
 * for the spec and status schemas.
 *
 * TSpec and TStatus must be compatible with Kro's Simple Schema format.
 */
export interface TypedKroResourceGraphDefinition<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> extends Omit<KroResourceGraphDefinition, 'spec'> {
  spec: {
    schema: KroSimpleSchema & {
      _typedSpec?: TSpec;
      _typedStatus?: TStatus;
    };
    resources: KroResourceTemplate[];
  };
}

/**
 * Base interface for resource graphs with deployment capabilities
 */
export interface ResourceGraphWithDeployment {
  /**
   * Deploy the resource graph to a Kubernetes cluster
   */
  deploy(options?: DeploymentOptions): Promise<DeploymentResult>;

  /**
   * Deploy the resource graph through alchemy's resource management system
   */
  deployWithAlchemy(scope: any, options?: AlchemyDeploymentOptions): Promise<DeploymentResult>;

  /**
   * Get the deployment status of this resource graph
   */
  getStatus(): Promise<DeploymentOperationStatus>;

  /**
   * Rollback the deployment of this resource graph
   */
  rollback(): Promise<RollbackResult>;

  /**
   * Perform a dry run deployment to validate the resource graph
   */
  toDryRun(options?: DeploymentOptions): Promise<DeploymentResult>;

  /**
   * Generates the ResourceGraphDefinition YAML string.
   */
  toYaml(): string;
}

/**
 * The enhanced return type for toResourceGraph. This is the factory object
 * that holds the definition, schema, and utility methods.
 *
 * TSpec and TStatus must be compatible with Kro's Simple Schema format.
 */
export interface TypedResourceGraphFactory<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> extends ResourceGraphWithDeployment {
  /**
   * Creates a typed instance of the CRD defined by this ResourceGraphDefinition.
   */
  getInstance(spec: TSpec): Enhanced<TSpec, TStatus>;

  /**
   * A proxy object for creating type-safe references to the CRD's own schema.
   */
  schema: SchemaProxy<TSpec, TStatus>;

  /**
   * The underlying ResourceGraphDefinition object.
   */
  definition: TypedKroResourceGraphDefinition<TSpec, TStatus>;
}

/**
 * Factory interface for imperative compositions
 * Provides the same interface as toResourceGraph result for compatibility
 */
export interface CompositionFactory<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> {
  /**
   * Convert the composition to a TypedResourceGraph
   * This provides compatibility with the existing toResourceGraph API
   */
  toResourceGraph(): import('./deployment.js').TypedResourceGraph<TSpec, TStatus>;
}

// =============================================================================
// SERIALIZATION CONTEXT AND OPTIONS
// =============================================================================

export interface SerializationOptions {
  namespace?: string;
  indent?: number;
  lineWidth?: number;
  noRefs?: boolean;
  /** When true, adds kro.run/allow-breaking-changes annotation to RGD metadata */
  allowBreakingChanges?: boolean;
}

export interface SerializationContext {
  celPrefix: string;
  namespace?: string;
  resourceIdStrategy: 'deterministic' | 'random';
}

export interface ResourceDependency {
  from: string;
  to: string;
  field: string;
  required: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Magic assignable type for status field mappings with recursive support.
 *
 * This allows status builders to return either:
 * 1. Plain objects with static values (e.g., `{ ready: true, phase: 'Ready' }`)
 * 2. Objects with MagicAssignable values (e.g., `{ ready: someRef.status.ready }`)
 * 3. A mix of both
 *
 * TypeScript enforces that only keys defined in the status schema are returned,
 * catching typos and extra properties at compile time.
 */
export type MagicAssignableShape<T> = T extends object
  ? {
      [K in keyof T]: T[K] extends object
        ? MagicAssignableShape<T[K]> // Recursively handle nested objects
        : T[K] | MagicAssignable<T[K]>; // Accept both plain values and MagicAssignable
    }
  : T;

export type ResourceBuilder<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType> = (
  schema: SchemaProxy<TSpec, TStatus>
) => Record<string, Enhanced<any, any>>; // Make the return type more specific

// Type that preserves Enhanced resources exactly as they are
// Enhanced resources already have the correct MagicProxy types for spec and status
export type StatusBuilderResources<TResources extends Record<string, Enhanced<any, any>>> =
  TResources;

// The StatusBuilder type itself can be simplified, as the key logic will move to the toResourceGraph function.
export type StatusBuilder<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  TResources extends Record<string, Enhanced<any, any>> = Record<string, Enhanced<any, any>>, // Keep any for compatibility
> = (
  schema: SchemaProxy<TSpec, TStatus>,
  resources: TResources // Use that generic here
) => MagicAssignableShape<TStatus>;

/**
 * Internal schema definition used for schema proxy creation and Kro schema generation.
 *
 * Most users should use {@link ResourceGraphDefinition} instead, which is the
 * public-facing configuration object for `toResourceGraph()`.
 *
 * @internal
 */
export interface SchemaDefinition<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> {
  apiVersion: string;
  kind: string;
  spec: Type<TSpec>;
  status: Type<TStatus>;
}

/**
 * Configuration for defining a typed Kro ResourceGraphDefinition.
 *
 * This is the primary configuration object passed to `toResourceGraph()`.
 * It describes the custom resource's identity, spec schema, and status schema.
 *
 * @example
 * ```ts
 * const myApp = toResourceGraph(
 *   {
 *     name: 'my-webapp',
 *     kind: 'WebApp',
 *     apiVersion: 'v1alpha1',
 *     group: 'apps.example.com',
 *     spec: type({ name: 'string', replicas: 'number' }),
 *     status: type({ ready: 'boolean', url: 'string' }),
 *   },
 *   (schema) => ({ ... }),
 *   (schema, resources) => ({ ... }),
 * );
 * ```
 */
export interface ResourceGraphDefinition<TSpec extends KroCompatibleType, TStatus> {
  /** Kubernetes-compatible name for this RGD. Must follow DNS subdomain rules (lowercase, hyphens). */
  name: string;
  /**
   * Full apiVersion string for the generated CRD, including group and version.
   * If a `group` is also provided, this should be just the version suffix.
   *
   * @default 'v1alpha1'
   * @example 'v1alpha1'
   * @example 'example.com/v1alpha1'
   */
  apiVersion?: string;
  /** The Kind for the generated CRD. Must be PascalCase (e.g. `'WebApp'`). */
  kind: string;
  /**
   * Custom API group for the CRD.
   *
   * @default 'kro.run' (in Kro v0.8.x)
   * @example 'apps.example.com'
   */
  group?: string;
  /** ArkType schema defining the spec fields that users provide when creating an instance. */
  spec: Type<TSpec>;
  /** ArkType schema defining the status fields that the composition populates. */
  status: Type<TStatus>;
}
