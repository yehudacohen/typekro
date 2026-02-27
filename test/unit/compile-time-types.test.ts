/**
 * Compile-time type tests for TypeKro's core type system.
 *
 * These tests verify that the type system works correctly at compile time.
 * They use @ts-expect-error to assert that certain invalid usages produce
 * type errors, and plain assignments to verify valid usages compile.
 *
 * If this file compiles, all type tests pass. If a @ts-expect-error line
 * does NOT produce an error, tsc will report "Unused '@ts-expect-error' directive."
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import type {
  ResourceConflictError,
  ResourceDeploymentError,
  ResourceReadinessTimeoutError,
  UnsupportedMediaTypeError,
} from '../../src/core/deployment/errors.js';
import type { CelEvaluationError } from '../../src/core/types/references.js';
import type {
  CelExpression,
  DeepKubernetesRef,
  Enhanced,
  KubernetesRef,
  MagicAssignable,
  MagicAssignableShape,
  MagicProxy,
  MagicValue,
  RefOrValue,
  SchemaProxy,
} from '../../src/index.js';
import {
  Cel,
  type CircularDependencyError,
  type CompositionExecutionError,
  type ContextRegistrationError,
  type ConversionError,
  type CRDInstanceError,
  type DeploymentTimeoutError,
  type KroSchemaValidationError,
  type KubernetesApiOperationError,
  type KubernetesClientError,
  type ResourceGraphFactoryError,
  type StatusHydrationError,
  type TypeKroError,
  type TypeKroReferenceError,
  toResourceGraph,
  type ValidationError,
} from '../../src/index.js';

// =============================================================================
// Test helpers — these functions exist only for type-level assertions.
// They are never called at runtime in a way that matters.
// =============================================================================

/** Assert that a value is assignable to type T */
function assertType<T>(_value: T): void {
  // compile-time only
}

/** Create a typed value for testing (never actually used at runtime) */
function phantom<T>(): T {
  return undefined as unknown as T;
}

/**
 * Block that compiles but never executes at runtime.
 * Use for type assertions that would throw if actually run
 * (e.g., property access on phantom values).
 */
const COMPILE_ONLY = false as boolean;

// =============================================================================
// 1. Enhanced<TSpec, TStatus> type tests
// =============================================================================

describe('Enhanced<TSpec, TStatus> compile-time types', () => {
  type TestSpec = { name: string; replicas: number; enabled: boolean };
  type TestStatus = { ready: boolean; url: string; count: number };

  test('spec and status are accessible with correct types', () => {
    if (COMPILE_ONLY) {
      const enhanced = phantom<Enhanced<TestSpec, TestStatus>>();

      // Spec fields are accessible (NonOptional removes undefined)
      assertType<string>(enhanced.spec.name);
      assertType<number>(enhanced.spec.replicas);
      assertType<boolean>(enhanced.spec.enabled);

      // Status fields are accessible
      assertType<boolean>(enhanced.status.ready);
      assertType<string>(enhanced.status.url);
      assertType<number>(enhanced.status.count);

      // apiVersion and kind are inherited from KubernetesResource
      assertType<string>(enhanced.apiVersion);
      assertType<string>(enhanced.kind);
    }

    expect(true).toBe(true); // Test exists for compile-time checking
  });

  test('Enhanced has readonly spec and status', () => {
    if (COMPILE_ONLY) {
      const enhanced = phantom<Enhanced<TestSpec, TestStatus>>();

      // @ts-expect-error — spec is readonly
      enhanced.spec = {} as any;

      // @ts-expect-error — status is readonly
      enhanced.status = {} as any;

      // @ts-expect-error — metadata is readonly
      enhanced.metadata = {} as any;
    }

    expect(true).toBe(true);
  });

  test('Enhanced metadata has MagicProxy V1ObjectMeta properties', () => {
    if (COMPILE_ONLY) {
      const enhanced = phantom<Enhanced<TestSpec, TestStatus>>();

      // Metadata fields should be accessible
      const _name: MagicAssignable<string | undefined> = enhanced.metadata.name;
      const _ns: MagicAssignable<string | undefined> = enhanced.metadata.namespace;
      void _name;
      void _ns;
    }

    expect(true).toBe(true);
  });
});

// =============================================================================
// 2. KubernetesRef<T> type tests
// =============================================================================

describe('KubernetesRef<T> compile-time types', () => {
  test('KubernetesRef is branded with resourceId and fieldPath', () => {
    if (COMPILE_ONLY) {
      const ref = phantom<KubernetesRef<string>>();

      assertType<true>(ref[KUBERNETES_REF_BRAND]);
      assertType<string>(ref.resourceId);
      assertType<string>(ref.fieldPath);
    }

    expect(true).toBe(true);
  });

  test('KubernetesRef preserves type parameter', () => {
    if (COMPILE_ONLY) {
      const strRef = phantom<KubernetesRef<string>>();
      const numRef = phantom<KubernetesRef<number>>();
      const boolRef = phantom<KubernetesRef<boolean>>();

      // _type preserves the phantom type
      assertType<string | undefined>(strRef._type);
      assertType<number | undefined>(numRef._type);
      assertType<boolean | undefined>(boolRef._type);
    }

    expect(true).toBe(true);
  });

  test('KubernetesRef with different type parameters are distinct', () => {
    const strRef = phantom<KubernetesRef<string>>();

    // @ts-expect-error — KubernetesRef<string> is not assignable to KubernetesRef<number>
    const _numRef: KubernetesRef<number> = strRef;
    void _numRef;

    expect(true).toBe(true);
  });
});

// =============================================================================
// 3. CelExpression<T> type tests
// =============================================================================

describe('CelExpression<T> compile-time types', () => {
  test('CelExpression is branded and has expression string', () => {
    if (COMPILE_ONLY) {
      const cel = phantom<CelExpression<string>>();

      assertType<true>(cel[CEL_EXPRESSION_BRAND]);
      assertType<string>(cel.expression);
      assertType<string | undefined>(cel._type);
    }

    expect(true).toBe(true);
  });

  test('CelExpression with different type parameters are distinct', () => {
    const strCel = phantom<CelExpression<string>>();

    // @ts-expect-error — CelExpression<string> is not assignable to CelExpression<number>
    const _numCel: CelExpression<number> = strCel;
    void _numCel;

    expect(true).toBe(true);
  });
});

// =============================================================================
// 4. RefOrValue<T> type tests
// =============================================================================

describe('RefOrValue<T> compile-time types', () => {
  test('RefOrValue accepts plain values', () => {
    const strVal: RefOrValue<string> = 'hello';
    const numVal: RefOrValue<number> = 42;
    const boolVal: RefOrValue<boolean> = true;
    void strVal;
    void numVal;
    void boolVal;

    expect(true).toBe(true);
  });

  test('RefOrValue accepts KubernetesRef', () => {
    const ref = phantom<KubernetesRef<string>>();
    const _val: RefOrValue<string> = ref;
    void _val;

    expect(true).toBe(true);
  });

  test('RefOrValue accepts CelExpression', () => {
    const cel = phantom<CelExpression<string>>();
    const _val: RefOrValue<string> = cel;
    void _val;

    expect(true).toBe(true);
  });

  test('RefOrValue rejects mismatched types', () => {
    // @ts-expect-error — number is not assignable to RefOrValue<string>
    const _val: RefOrValue<string> = 42;
    void _val;

    expect(true).toBe(true);
  });
});

// =============================================================================
// 5. MagicAssignable<T> type tests
// =============================================================================

describe('MagicAssignable<T> compile-time types', () => {
  test('MagicAssignable accepts plain values', () => {
    const _str: MagicAssignable<string> = 'hello';
    const _num: MagicAssignable<number> = 42;
    const _bool: MagicAssignable<boolean> = true;
    void _str;
    void _num;
    void _bool;

    expect(true).toBe(true);
  });

  test('MagicAssignable accepts undefined', () => {
    const _val: MagicAssignable<string> = undefined;
    void _val;

    expect(true).toBe(true);
  });

  test('MagicAssignable accepts CelExpression', () => {
    const cel = phantom<CelExpression<string>>();
    const _val: MagicAssignable<string> = cel;
    void _val;

    expect(true).toBe(true);
  });

  test('MagicAssignable accepts KubernetesRef', () => {
    const ref = phantom<KubernetesRef<string>>();
    const _val: MagicAssignable<string> = ref;
    void _val;

    expect(true).toBe(true);
  });

  test('MagicAssignable accepts KubernetesRef with undefined union', () => {
    const ref = phantom<KubernetesRef<string | undefined>>();
    const _val: MagicAssignable<string> = ref;
    void _val;

    expect(true).toBe(true);
  });
});

// =============================================================================
// 6. MagicValue<T> type tests
// =============================================================================

describe('MagicValue<T> compile-time types', () => {
  test('MagicValue<string> accepts string, KubernetesRef<string>, and CelExpression<string>', () => {
    const _plain: MagicValue<string> = 'hello';
    const _ref: MagicValue<string> = phantom<KubernetesRef<string>>();
    const _cel: MagicValue<string> = phantom<CelExpression<string>>();
    void _plain;
    void _ref;
    void _cel;

    expect(true).toBe(true);
  });

  test('MagicValue<number> accepts number, KubernetesRef<number>, and CelExpression<number>', () => {
    const _plain: MagicValue<number> = 42;
    const _ref: MagicValue<number> = phantom<KubernetesRef<number>>();
    const _cel: MagicValue<number> = phantom<CelExpression<number>>();
    void _plain;
    void _ref;
    void _cel;

    expect(true).toBe(true);
  });

  test('MagicValue<boolean> accepts boolean, KubernetesRef<boolean>, and CelExpression<boolean>', () => {
    const _plain: MagicValue<boolean> = true;
    const _ref: MagicValue<boolean> = phantom<KubernetesRef<boolean>>();
    const _cel: MagicValue<boolean> = phantom<CelExpression<boolean>>();
    void _plain;
    void _ref;
    void _cel;

    expect(true).toBe(true);
  });
});

// =============================================================================
// 7. MagicProxy<T> type tests
// =============================================================================

describe('MagicProxy<T> compile-time types', () => {
  test('MagicProxy preserves known property types', () => {
    if (COMPILE_ONLY) {
      type Obj = { name: string; count: number; active: boolean };
      const proxy = phantom<MagicProxy<Obj>>();

      // Properties are wrapped as MagicAssignable
      assertType<MagicAssignable<string>>(proxy.name);
      assertType<MagicAssignable<number>>(proxy.count);
      assertType<MagicAssignable<boolean>>(proxy.active);
    }

    expect(true).toBe(true);
  });

  test('MagicProxy allows string-indexed access', () => {
    if (COMPILE_ONLY) {
      type Obj = { name: string };
      const proxy = phantom<MagicProxy<Obj>>();

      // Index signature allows unknown properties
      const _unknown: MagicAssignable<any> = proxy['arbitrary'];
      void _unknown;
    }

    expect(true).toBe(true);
  });
});

// =============================================================================
// 8. DeepKubernetesRef<T> type tests
// =============================================================================

describe('DeepKubernetesRef<T> compile-time types', () => {
  test('DeepKubernetesRef wraps primitives with KubernetesRef union', () => {
    assertType<KubernetesRef<string> | string>(phantom<DeepKubernetesRef<string>>());
    assertType<KubernetesRef<number> | number>(phantom<DeepKubernetesRef<number>>());
    assertType<KubernetesRef<boolean> | boolean>(phantom<DeepKubernetesRef<boolean>>());

    expect(true).toBe(true);
  });

  test('DeepKubernetesRef recursively wraps object properties', () => {
    if (COMPILE_ONLY) {
      type Nested = { name: string; config: { port: number } };
      const deep = phantom<DeepKubernetesRef<Nested>>();

      // Nested properties are also deep-wrapped
      assertType<DeepKubernetesRef<string>>(deep.name);
      assertType<DeepKubernetesRef<{ port: number }>>(deep.config);
    }

    expect(true).toBe(true);
  });
});

// =============================================================================
// 9. Error hierarchy type tests
// =============================================================================

describe('Error hierarchy compile-time types', () => {
  test('all custom errors extend TypeKroError', () => {
    // Verify every error class is assignable to TypeKroError
    assertType<TypeKroError>(phantom<ValidationError>());
    assertType<TypeKroError>(phantom<ResourceGraphFactoryError>());
    assertType<TypeKroError>(phantom<CRDInstanceError>());
    assertType<TypeKroError>(phantom<KubernetesApiOperationError>());
    assertType<TypeKroError>(phantom<KubernetesClientError>());
    assertType<TypeKroError>(phantom<DeploymentTimeoutError>());
    assertType<TypeKroError>(phantom<CompositionExecutionError>());
    assertType<TypeKroError>(phantom<KroSchemaValidationError>());
    assertType<TypeKroError>(phantom<StatusHydrationError>());
    assertType<TypeKroError>(phantom<ConversionError>());
    assertType<TypeKroError>(phantom<CircularDependencyError>());
    assertType<TypeKroError>(phantom<TypeKroReferenceError>());
    assertType<TypeKroError>(phantom<ContextRegistrationError>());

    expect(true).toBe(true);
  });

  test('deployment error classes extend TypeKroError', () => {
    assertType<TypeKroError>(phantom<ResourceDeploymentError>());
    assertType<TypeKroError>(phantom<ResourceConflictError>());
    assertType<TypeKroError>(phantom<ResourceReadinessTimeoutError>());
    assertType<TypeKroError>(phantom<UnsupportedMediaTypeError>());

    expect(true).toBe(true);
  });

  test('CelEvaluationError extends TypeKroError', () => {
    assertType<TypeKroError>(phantom<CelEvaluationError>());

    expect(true).toBe(true);
  });

  test('all custom errors are also Error instances', () => {
    // TypeKroError extends Error, so all subclasses are Error instances too
    assertType<Error>(phantom<TypeKroError>());
    assertType<Error>(phantom<ValidationError>());
    assertType<Error>(phantom<DeploymentTimeoutError>());

    expect(true).toBe(true);
  });

  test('TypeKroError has code and context properties', () => {
    if (COMPILE_ONLY) {
      const err = phantom<TypeKroError>();
      assertType<string>(err.code);
      assertType<Record<string, unknown> | undefined>(err.context);
    }

    expect(true).toBe(true);
  });
});

// =============================================================================
// 10. toResourceGraph type inference tests
// =============================================================================

describe('toResourceGraph compile-time types', () => {
  test('schema proxy provides typed spec and status access', () => {
    // This test verifies that toResourceGraph compiles with correct type inference
    const graph = toResourceGraph(
      {
        name: 'test-app',
        apiVersion: 'v1alpha1',
        kind: 'TestApp',
        spec: type({ name: 'string', replicas: 'number' }),
        status: type({ ready: 'boolean', url: 'string' }),
      },
      (schema) => {
        // schema.spec should have the right fields
        const _name = schema.spec.name;
        const _replicas = schema.spec.replicas;
        void _name;
        void _replicas;

        return {};
      },
      (schema, _resources) => {
        // Status builder receives the schema
        return {
          ready: true,
          url: Cel.template('https://%s', schema.spec.name),
        };
      }
    );

    // graph should have toYaml and createFactory methods
    assertType<string>(graph.toYaml());
    assertType<string>(graph.name);

    expect(true).toBe(true);
  });

  test('status builder receives typed resources', () => {
    const graph = toResourceGraph(
      {
        name: 'test-app',
        apiVersion: 'v1alpha1',
        kind: 'TestApp',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (_schema) => {
        return {};
      },
      (_schema, _resources) => {
        // resources should be the exact shape returned by resourceBuilder
        return {
          ready: true,
        };
      }
    );

    expect(graph.name).toBe('test-app');
  });

  test('toResourceGraph rejects invalid name types', () => {
    if (COMPILE_ONLY) {
      toResourceGraph(
        {
          // @ts-expect-error — name must be a string, not a number
          name: 123,
          apiVersion: 'v1alpha1',
          kind: 'TestApp',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        () => ({}),
        () => ({ ready: true })
      );
    }

    expect(true).toBe(true);
  });
});

// =============================================================================
// 11. SchemaProxy type tests
// =============================================================================

describe('SchemaProxy compile-time types', () => {
  test('SchemaProxy has spec and status with SchemaMagicProxy types', () => {
    if (COMPILE_ONLY) {
      type Spec = { name: string; port: number };
      type Status = { ready: boolean };
      const schema = phantom<SchemaProxy<Spec, Status>>();

      // spec and status properties mirror the original types
      assertType<string>(schema.spec.name);
      assertType<number>(schema.spec.port);
      assertType<boolean>(schema.status.ready);
    }

    expect(true).toBe(true);
  });
});

// =============================================================================
// 12. MagicAssignableShape<T> type tests
// =============================================================================

describe('MagicAssignableShape<T> compile-time types', () => {
  test('MagicAssignableShape allows plain values and MagicAssignable for leaf fields', () => {
    type Status = { ready: boolean; url: string };
    type Shape = MagicAssignableShape<Status>;

    // Plain values should be assignable
    const _shape1: Shape = { ready: true, url: 'https://example.com' };

    // CelExpression should also be assignable for leaf fields
    const cel = phantom<CelExpression<boolean>>();
    const _shape2: Shape = { ready: cel, url: 'https://example.com' };
    void _shape1;
    void _shape2;

    expect(true).toBe(true);
  });

  test('MagicAssignableShape recursively handles nested objects', () => {
    type Status = { nested: { ready: boolean } };
    type Shape = MagicAssignableShape<Status>;

    const _shape: Shape = { nested: { ready: true } };
    void _shape;

    expect(true).toBe(true);
  });
});

// =============================================================================
// 13. Cel helper type tests
// =============================================================================

describe('Cel helper compile-time types', () => {
  test('Cel.expr returns CelExpression with type parameter', () => {
    const boolExpr = Cel.expr<boolean>`true`;
    assertType<CelExpression<boolean>>(boolExpr);

    const strExpr = Cel.expr<string>`'hello'`;
    assertType<CelExpression<string>>(strExpr);

    expect(true).toBe(true);
  });

  test('Cel.template returns CelExpression<string>', () => {
    const tmpl = Cel.template('https://%s', phantom<KubernetesRef<string>>());
    assertType<CelExpression<string>>(tmpl);

    expect(true).toBe(true);
  });
});
