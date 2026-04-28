/**
 * Type Inference Types and Error Classes
 *
 * This module contains all type definitions, interfaces, and error classes
 * used by the CEL type inference engine.
 */

import { TypeKroError } from '../../errors.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';
import type { TypeInfo } from './type-safety.js';

/**
 * CEL expression type inference result
 */
export interface CelTypeInferenceResult {
  /** Inferred result type of the CEL expression */
  resultType: TypeInfo;

  /** Whether the type inference was successful */
  success: boolean;

  /** Type inference errors */
  errors: TypeInferenceError[];

  /** Type inference warnings */
  warnings: TypeInferenceWarning[];

  /** Confidence level of the inference (0-1) */
  confidence: number;

  /** Additional type information */
  metadata: TypeInferenceMetadata;
}

/**
 * Type inference error
 */
export class TypeInferenceError extends TypeKroError {
  constructor(
    message: string,
    public readonly celExpression: string,
    public readonly location?: { start: number; end: number }
  ) {
    super(message, 'TYPE_INFERENCE_ERROR', {
      celExpression,
      location,
    });
    this.name = 'TypeInferenceError';
  }

  static forUnknownFunction(
    celExpression: string,
    functionName: string,
    location?: { start: number; end: number }
  ): TypeInferenceError {
    return new TypeInferenceError(`Unknown CEL function: ${functionName}`, celExpression, location);
  }

  static forIncompatibleOperands(
    celExpression: string,
    operator: string,
    leftType: TypeInfo,
    rightType: TypeInfo,
    location?: { start: number; end: number }
  ): TypeInferenceError {
    return new TypeInferenceError(
      `Incompatible operands for operator '${operator}': ${leftType.typeName} and ${rightType.typeName}`,
      celExpression,
      location
    );
  }

  static forUnresolvableReference(
    celExpression: string,
    reference: string,
    location?: { start: number; end: number }
  ): TypeInferenceError {
    return new TypeInferenceError(
      `Cannot resolve reference: ${reference}`,
      celExpression,
      location
    );
  }
}

/**
 * Type inference warning
 */
export class TypeInferenceWarning {
  constructor(
    public readonly message: string,
    public readonly celExpression: string,
    public readonly location?: { start: number; end: number }
  ) {}

  static forPotentialNullDereference(
    celExpression: string,
    reference: string,
    location?: { start: number; end: number }
  ): TypeInferenceWarning {
    return new TypeInferenceWarning(
      `Potential null dereference: ${reference}`,
      celExpression,
      location
    );
  }

  static forImplicitTypeConversion(
    celExpression: string,
    fromType: string,
    toType: string,
    location?: { start: number; end: number }
  ): TypeInferenceWarning {
    return new TypeInferenceWarning(
      `Implicit type conversion from ${fromType} to ${toType}`,
      celExpression,
      location
    );
  }
}

/**
 * Type inference metadata
 */
export interface TypeInferenceMetadata {
  /** CEL functions used in the expression */
  functionsUsed: string[];

  /** Resource references found in the expression */
  resourceReferences: string[];

  /** Schema references found in the expression */
  schemaReferences: string[];

  /** Whether the expression uses optional chaining */
  usesOptionalChaining: boolean;

  /** Whether the expression can return null */
  canReturnNull: boolean;

  /** Complexity score of the expression (0-10) */
  complexityScore: number;
}

/**
 * Type inference context
 */
export interface TypeInferenceContext {
  /** Available resources for type lookup */
  availableResources: Record<string, Enhanced<unknown, unknown>>;

  /** Schema proxy for schema type lookup */
  schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>>;

  /** Factory type affects available functions */
  factoryType: 'direct' | 'kro';
}

/**
 * Expression analysis result
 */
export interface ExpressionAnalysisResult {
  type: TypeInfo;
  errors: TypeInferenceError[];
  warnings: TypeInferenceWarning[];
  confidence: number;
  metadata: TypeInferenceMetadata;
}

/**
 * CEL function signature
 */
export interface CelFunctionSignature {
  parameters: TypeInfo[];
  returnType: TypeInfo;
}

/**
 * CEL operator signature
 */
export interface CelOperatorSignature {
  leftType: TypeInfo;
  rightType: TypeInfo;
  returnType: TypeInfo;
}
