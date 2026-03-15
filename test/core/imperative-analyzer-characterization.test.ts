/**
 * Characterization tests for analyzeImperativeComposition
 *
 * These tests capture the CURRENT behavior of the imperative composition
 * analyzer, including AST parsing, resource reference detection, and error
 * handling.
 *
 * KEY BEHAVIOR: Only arrow functions with explicit `return` work.
 * Arrow functions with implicit return `() => ({...})` fail with
 * "No return statement found" because acorn parses them as
 * ExpressionStatement, not ReturnStatement.
 *
 * Source: src/core/expressions/composition/imperative-analyzer.ts (557 lines)
 */

import { describe, expect, it } from 'bun:test';
import { analyzeImperativeComposition } from '../../src/core/expressions/composition/imperative-analyzer.js';
import type { CelExpression } from '../../src/core/types/common.js';
import { CEL_EXPRESSION_BRAND } from '../../src/shared/brands.js';

function isCelExpr(value: unknown): value is CelExpression {
  return (
    value !== null &&
    typeof value === 'object' &&
    CEL_EXPRESSION_BRAND in (value as Record<symbol, unknown>) &&
    (value as Record<symbol, unknown>)[CEL_EXPRESSION_BRAND] === true
  );
}

describe('analyzeImperativeComposition', () => {
  describe('static values (arrow with explicit return)', () => {
    it('extracts string literal values', () => {
      // Must use explicit return — implicit return arrows fail
      const fn = () => {
        return { version: '1.0' };
      };

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      expect(result.statusMappings.version).toBe('1.0');
      expect(result.hasJavaScriptExpressions).toBe(false);
      expect(result.errors).toHaveLength(0);
    });

    it('extracts number literal values', () => {
      const fn = () => {
        return { count: 42 };
      };

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      expect(result.statusMappings.count).toBe(42);
    });

    it('boolean true becomes null (Bun minifies true→!0, UnaryExpression not handled)', () => {
      // Bun transforms `true` to `!0` which is a UnaryExpression.
      // evaluateStaticExpression has no case for UnaryExpression → returns null.
      const fn = () => {
        return { enabled: true };
      };

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      // Quirk: true becomes null due to Bun minification
      expect(result.statusMappings.enabled).toBeNull();
    });

    it('boolean false also becomes null (Bun minifies false→!1)', () => {
      const fn = () => {
        return { disabled: false };
      };

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      expect(result.statusMappings.disabled).toBeNull();
    });

    it('extracts null literal values', () => {
      const fn = () => {
        return { nothing: null };
      };

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      expect(result.statusMappings.nothing).toBeNull();
    });
  });

  describe('implicit return arrows fail', () => {
    it('implicit-return arrow functions fail with no return statement error', () => {
      // Arrow functions with implicit return: () => ({...})
      // acorn parses as ExpressionStatement, not ReturnStatement
      const fn = () => ({
        version: '1.0',
      });

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('return statement');
      expect(result.statusMappings).toEqual({});
    });

    it('implicit-return with resource refs also fails', () => {
      const fn = (_schema: unknown, resources: Record<string, unknown>) => ({
        phase: (resources as any).helm.status.phase,
      });

      const result = analyzeImperativeComposition(
        fn as (...args: unknown[]) => unknown,
        {},
        { factoryType: 'kro' }
      );

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.statusMappings).toEqual({});
    });
  });

  describe('resource references (arrow with explicit return)', () => {
    it('converts status field references to CelExpression', () => {
      const fn = (_schema: unknown, resources: Record<string, any>) => {
        return { phase: resources.helm.status.phase };
      };

      const result = analyzeImperativeComposition(
        fn as (...args: unknown[]) => unknown,
        {},
        { factoryType: 'kro' }
      );

      expect(result.hasJavaScriptExpressions).toBe(true);
      expect(isCelExpr(result.statusMappings.phase)).toBe(true);
      expect((result.statusMappings.phase as CelExpression).expression).toContain(
        'resources.helm.status.phase'
      );
    });

    it('converts metadata field references to CelExpression', () => {
      const fn = (_schema: unknown, resources: Record<string, any>) => {
        return { name: resources.deployment.metadata.name };
      };

      const result = analyzeImperativeComposition(
        fn as (...args: unknown[]) => unknown,
        {},
        { factoryType: 'kro' }
      );

      expect(isCelExpr(result.statusMappings.name)).toBe(true);
      expect((result.statusMappings.name as CelExpression).expression).toContain(
        'resources.deployment.metadata.name'
      );
    });

    it('converts spec field references to CelExpression', () => {
      const fn = (_schema: unknown, resources: Record<string, any>) => {
        return { replicas: resources.deployment.spec.replicas };
      };

      const result = analyzeImperativeComposition(
        fn as (...args: unknown[]) => unknown,
        {},
        { factoryType: 'kro' }
      );

      expect(isCelExpr(result.statusMappings.replicas)).toBe(true);
      expect((result.statusMappings.replicas as CelExpression).expression).toContain(
        'resources.deployment.spec.replicas'
      );
    });
  });

  describe('nested objects', () => {
    it('handles nested object structures', () => {
      const fn = (_schema: unknown, resources: Record<string, any>) => {
        return {
          connection: {
            host: resources.db.status.endpoint,
            port: 5432,
          },
        };
      };

      const result = analyzeImperativeComposition(
        fn as (...args: unknown[]) => unknown,
        {},
        { factoryType: 'kro' }
      );

      const connection = result.statusMappings.connection as Record<string, unknown>;
      expect(connection).toBeDefined();
      expect(isCelExpr(connection.host)).toBe(true);
      expect(connection.port).toBe(5432);
    });
  });

  describe('__KUBERNETES_REF_ placeholders in string literals', () => {
    it('__KUBERNETES_REF_ placeholders in strings are NOT converted — stay as raw strings', () => {
      // The analyzer only converts resource.x.y MemberExpression AST nodes.
      // String literals containing __KUBERNETES_REF_ are kept as-is.
      const fn = () => {
        return { endpoint: '__KUBERNETES_REF_nginx_status.loadBalancer.ip__' };
      };

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      // The placeholder stays as a raw string, NOT converted to CEL
      expect(result.statusMappings.endpoint).toBe(
        '__KUBERNETES_REF_nginx_status.loadBalancer.ip__'
      );
      expect(isCelExpr(result.statusMappings.endpoint)).toBe(false);
    });

    it('__schema__ placeholders in strings also stay as raw strings', () => {
      const fn = () => {
        return { name: '__KUBERNETES_REF___schema___spec.hostname__' };
      };

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      expect(result.statusMappings.name).toBe('__KUBERNETES_REF___schema___spec.hostname__');
      expect(isCelExpr(result.statusMappings.name)).toBe(false);
    });
  });

  describe('error handling', () => {
    it('returns error for unparseable function source', () => {
      const fn = { toString: () => '???invalid{{{' } as any;

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.statusMappings).toEqual({});
      expect(result.hasJavaScriptExpressions).toBe(false);
    });

    it('extracts all valid static properties from explicit return', () => {
      const fn = () => {
        return { good: 'value', alsoGood: 42 };
      };

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      expect(result.statusMappings.good).toBe('value');
      expect(result.statusMappings.alsoGood).toBe(42);
    });
  });

  describe('factoryType parameter', () => {
    it('works with kro factory type (explicit return)', () => {
      const fn = () => {
        return { value: 'test' };
      };

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      expect(result.errors).toHaveLength(0);
    });

    it('works with direct factory type (explicit return)', () => {
      const fn = () => {
        return { value: 'test' };
      };

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'direct' });

      expect(result.errors).toHaveLength(0);
    });

    it('implicit return arrows fail regardless of factory type', () => {
      const fn = () => ({ value: 'test' });

      const kroResult = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });
      const directResult = analyzeImperativeComposition(fn, {}, { factoryType: 'direct' });

      expect(kroResult.errors.length).toBeGreaterThan(0);
      expect(directResult.errors.length).toBeGreaterThan(0);
    });
  });

  describe('empty/edge cases', () => {
    it('handles empty return object', () => {
      const fn = () => {
        return {};
      };

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      expect(result.statusMappings).toEqual({});
      expect(result.hasJavaScriptExpressions).toBe(false);
      expect(result.errors).toHaveLength(0);
    });

    it('resources parameter can be empty object with explicit return', () => {
      const fn = () => {
        return { value: 'test' };
      };

      const result = analyzeImperativeComposition(fn, {}, { factoryType: 'kro' });

      expect(result.errors).toHaveLength(0);
      expect(result.statusMappings.value).toBe('test');
    });

    it('mixed static and resource refs in same return', () => {
      const fn = (_schema: unknown, resources: Record<string, any>) => {
        return {
          staticVal: 'hello',
          dynamicVal: resources.svc.status.clusterIP,
        };
      };

      const result = analyzeImperativeComposition(
        fn as (...args: unknown[]) => unknown,
        {},
        { factoryType: 'kro' }
      );

      expect(result.statusMappings.staticVal).toBe('hello');
      expect(isCelExpr(result.statusMappings.dynamicVal)).toBe(true);
      expect(result.hasJavaScriptExpressions).toBe(true);
    });
  });
});
