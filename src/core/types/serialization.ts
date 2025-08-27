/**
 * Serialization and Kro-related types
 */

import type { Type } from 'arktype';
import type { MagicAssignable } from './common.js';
import type { Enhanced } from './kubernetes.js';
import type { SchemaMagicProxy } from './references.js';
import type {
  AlchemyDeploymentOptions,
  DeploymentOperationStatus,
  DeploymentOptions,
  DeploymentResult,
  RollbackResult,
} from './resource-graph.js';

// Re-export alchemy Scope type for compatibility
export type { Scope } from 'alchemy';

// =============================================================================
// KRO SERIALIZATION & DEPENDENCY TYPES
// =============================================================================

export interface KroResourceGraphDefinition {
  apiVersion: 'kro.run/v1alpha1';
  kind: 'ResourceGraphDefinition';
  metadata: { name: string; namespace?: string };
  spec: {
    schema: KroSimpleSchema;
    resources: KroResourceTemplate[];
  };
}

export interface KroSimpleSchema {
  apiVersion: string;
  kind: string;
  spec: Record<string, string>;
  status?: Record<string, string>;
}

export interface KroFieldDefinition {
  type: string;
  markers?: string;
}

export interface KroResourceTemplate {
  id: string;
  template: unknown;
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
 * Helper type to decrement depth counter
 */
type Prev<T extends number> = T extends 10
  ? 9
  : T extends 9
    ? 8
    : T extends 8
      ? 7
      : T extends 7
        ? 6
        : T extends 6
          ? 5
          : T extends 5
            ? 4
            : T extends 4
              ? 3
              : T extends 3
                ? 2
                : T extends 2
                  ? 1
                  : T extends 1
                    ? 0
                    : never;

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

/**
 * Base type for values that are compatible with Kro schemas
 */
export type KroCompatibleValue<Depth extends number = 10> = Depth extends 0
  ? never
  :
      | string
      | number
      | boolean
      | string[]
      | number[]
      | boolean[]
      | string[][] // Nested arrays
      | number[][]
      | boolean[][]
      | Record<string, string> // Maps of basic types
      | Record<string, number>
      | Record<string, boolean>
      | Record<string, string[]> // Maps of arrays
      | Record<string, number[]>
      | Record<string, boolean[]>
      | Record<string, string>[] // Arrays of maps
      | Record<string, number>[]
      | Record<string, boolean>[]
      | Record<string, Record<string, string>> // Nested maps
      | Record<string, Record<string, number>>
      | Record<string, Record<string, boolean>>
      | KroCompatibleType<Prev<Depth>>; // Nested objects (with depth limit)

/**
 * Constraint type for TypeScript types that can be used with Kro schemas
 * This ensures only compatible types are used for spec and status, with proper nesting support up to 10 levels deep
 *
 * This is more flexible than a strict index signature to allow for specific interface definitions in tests
 */
export type KroCompatibleType<Depth extends number = 10> = Depth extends 0
  ? never
  : Record<string, KroCompatibleValue<Depth>>;

// =============================================================================
// SCHEMA PROXY & BUILDER FUNCTION TYPES
// =============================================================================

/**
 * The user-facing type for a schema proxy. It enables type-safe
 * access to the spec and status fields of the CRD being defined.
 *
 * TSpec and TStatus should be compatible with Kro's Simple Schema format.
 * We use a looser constraint to preserve specific field types from ArkType schemas.
 */
export type SchemaProxy<TSpec extends Record<string, any>, TStatus extends Record<string, any>> = {
  spec: SchemaMagicProxy<TSpec>;
  status: SchemaMagicProxy<TStatus>;
};

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

// Magic assignable type for status field mappings with recursive support
export type MagicAssignableShape<T> = {
  [K in keyof T]: T[K] extends object
    ? MagicAssignableShape<T[K]> // Recursively handle nested objects
    : MagicAssignable<T[K]>; // Apply MagicAssignable to primitive types
};

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

export interface SchemaDefinition<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> {
  apiVersion: string;
  kind: string;
  spec: Type<TSpec>;
  status: Type<TStatus>;
}

export interface ResourceGraphDefinition<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> {
  name: string;
  apiVersion?: string; // Optional, defaults to 'kro.run/v1alpha1'
  kind: string;
  spec: Type<TSpec>;
  status: Type<TStatus>;
}
