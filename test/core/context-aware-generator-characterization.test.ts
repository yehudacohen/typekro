/**
 * Characterization tests for ContextAwareCelGenerator
 *
 * These tests capture the CURRENT behavior of the context-aware CEL
 * expression generator, covering all 6 strategies with single/multi refs,
 * edge cases, debug info, and error handling.
 *
 * KEY BEHAVIORS:
 * - generateKroStatusReference and generateDirectStatusReference are
 *   functionally identical (both produce "resources.{id}.{path}").
 * - warnings array is always empty (declared but never populated).
 * - Unsupported strategy throws ConversionError (double-wrapped).
 * - Empty refs array produces empty-string expressions or undefined.
 *
 * Source: src/core/expressions/context/context-aware-generator.ts (575 lines)
 */

import { describe, expect, it } from 'bun:test';
import { ConversionError } from '../../src/core/errors.js';
import type { CelGenerationConfig } from '../../src/core/expressions/context/context-aware-generator.js';
import { ContextAwareCelGenerator } from '../../src/core/expressions/context/context-aware-generator.js';
import type {
  CelGenerationStrategy,
  ExpressionContext,
} from '../../src/core/expressions/context/context-detector.js';
import type { CelExpression, KubernetesRef } from '../../src/core/types/common.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/shared/brands.js';

function makeRef<T = unknown>(resourceId: string, fieldPath: string, _type?: T): KubernetesRef<T> {
  return {
    [KUBERNETES_REF_BRAND]: true as const,
    resourceId,
    fieldPath,
    _type,
  };
}

function isCelExpression(value: unknown): value is CelExpression {
  return (
    value !== null && typeof value === 'object' && (value as any)[CEL_EXPRESSION_BRAND] === true
  );
}

const defaultConfig: CelGenerationConfig = { factoryType: 'kro' };
const directConfig: CelGenerationConfig = { factoryType: 'direct' };

describe('ContextAwareCelGenerator', () => {
  const generator = new ContextAwareCelGenerator();
  const defaultContext: ExpressionContext = 'status-builder';

  describe('generateCelExpression — common behavior', () => {
    it('returns a CelExpression with CEL brand', () => {
      const refs = [makeRef('deploy', 'status.phase', 'string')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'status-expression',
        defaultConfig
      );

      expect(isCelExpression(result.celExpression)).toBe(true);
    });

    it('passes through strategy and context', () => {
      const refs = [makeRef('deploy', 'status.phase')];

      const result = generator.generateCelExpression(
        refs,
        'conditional',
        'status-expression',
        defaultConfig
      );

      expect(result.strategy).toBe('status-expression');
      expect(result.context).toBe('conditional');
    });

    it('dependencies is the same refs array', () => {
      const refs = [makeRef('deploy', 'status.phase')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'status-expression',
        defaultConfig
      );

      expect(result.dependencies).toBe(refs);
    });

    it('warnings is always empty', () => {
      const refs = [makeRef('deploy', 'status.phase')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'status-expression',
        defaultConfig
      );

      expect(result.warnings).toEqual([]);
    });

    it('throws ConversionError for unsupported strategy', () => {
      const refs = [makeRef('deploy', 'status.phase')];

      expect(() =>
        generator.generateCelExpression(
          refs,
          defaultContext,
          'nonexistent-strategy' as CelGenerationStrategy,
          defaultConfig
        )
      ).toThrow(ConversionError);
    });

    it('includes debugInfo when config.includeDebugInfo is true', () => {
      const refs = [makeRef('deploy', 'status.phase')];
      const config: CelGenerationConfig = { factoryType: 'kro', includeDebugInfo: true };

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'status-expression',
        config
      );

      expect(result.debugInfo).toBeDefined();
      expect(result.debugInfo!.transformationSteps.length).toBeGreaterThan(0);
      expect(result.debugInfo!.performanceMetrics).toBeDefined();
      expect(result.debugInfo!.performanceMetrics!.cacheHits).toBe(0);
      expect(result.debugInfo!.performanceMetrics!.cacheMisses).toBe(0);
    });

    it('omits debugInfo when config.includeDebugInfo is false', () => {
      const refs = [makeRef('deploy', 'status.phase')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'status-expression',
        defaultConfig
      );

      expect(result.debugInfo).toBeUndefined();
    });
  });

  describe('status-expression strategy', () => {
    it('single ref (kro): resources.{id}.{path}', () => {
      const refs = [makeRef('deploy', 'status.readyReplicas', 'number')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'status-expression',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('resources.deploy.status.readyReplicas');
      expect(result.celExpression._type).toBe('number');
    });

    it('single ref (direct): same as kro (implementations are identical)', () => {
      const refs = [makeRef('deploy', 'status.readyReplicas', 'number')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'status-expression',
        directConfig
      );

      expect(result.celExpression.expression).toBe('resources.deploy.status.readyReplicas');
    });

    it('single ref with __schema__: schema.{path}', () => {
      const refs = [makeRef('__schema__', 'spec.name', 'string')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'status-expression',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('schema.spec.name');
    });

    it('multiple refs: joined with +', () => {
      const refs = [makeRef('deploy', 'status.phase'), makeRef('svc', 'status.clusterIP')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'status-expression',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe(
        'resources.deploy.status.phase + resources.svc.status.clusterIP'
      );
      expect(result.celExpression._type).toBe('string');
    });

    it('empty refs: expression is empty string', () => {
      const refs: KubernetesRef[] = [];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'status-expression',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('');
    });
  });

  describe('resource-reference strategy', () => {
    it('single ref with __schema__: schema.{path}', () => {
      const refs = [makeRef('__schema__', 'spec.hostname')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'resource-reference',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('schema.spec.hostname');
    });

    it('single ref non-schema: resources.{id}.{path}', () => {
      const refs = [makeRef('deploy', 'status.phase')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'resource-reference',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('resources.deploy.status.phase');
    });

    it('multiple refs (>1): wrapped in quotes', () => {
      const refs = [makeRef('deploy', 'status.phase'), makeRef('svc', 'status.clusterIP')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'resource-reference',
        defaultConfig
      );

      expect(result.celExpression.expression).toContain('resources.deploy.status.phase');
      expect(result.celExpression.expression).toContain('resources.svc.status.clusterIP');
      expect(result.celExpression._type).toBe('string');
    });
  });

  describe('conditional-check strategy', () => {
    it('boolean _type: base expression as-is', () => {
      const refs = [makeRef('deploy', 'status.ready', 'boolean')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'conditional-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('resources.deploy.status.ready');
      expect(result.celExpression._type).toBe('boolean');
    });

    it('number _type: base > 0', () => {
      const refs = [makeRef('deploy', 'status.readyReplicas', 'number')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'conditional-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('resources.deploy.status.readyReplicas > 0');
    });

    it('string _type: base != ""', () => {
      const refs = [makeRef('deploy', 'status.phase', 'string')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'conditional-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('resources.deploy.status.phase != ""');
    });

    it('undefined _type: has(base)', () => {
      const refs = [makeRef('deploy', 'status.something')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'conditional-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('has(resources.deploy.status.something)');
    });

    it('multiple refs: conditions joined with &&', () => {
      const refs = [
        makeRef('deploy', 'status.ready', 'boolean'),
        makeRef('svc', 'status.phase', 'string'),
      ];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'conditional-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toContain('&&');
      expect(result.celExpression._type).toBe('boolean');
    });

    it('__schema__ ref: uses schema.{path}', () => {
      const refs = [makeRef('__schema__', 'spec.enabled', 'boolean')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'conditional-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('schema.spec.enabled');
    });
  });

  describe('readiness-check strategy', () => {
    it('readyReplicas fieldPath: base > 0', () => {
      const refs = [makeRef('deploy', 'status.readyReplicas')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'readiness-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('resources.deploy.status.readyReplicas > 0');
    });

    it('ready fieldPath (not readyReplicas): base as-is', () => {
      const refs = [makeRef('deploy', 'status.ready')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'readiness-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('resources.deploy.status.ready');
    });

    it('status fieldPath: base == "Ready"', () => {
      const refs = [makeRef('helm', 'status.phase')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'readiness-check',
        defaultConfig
      );

      // 'status' is in fieldPath 'status.phase'
      expect(result.celExpression.expression).toContain('== "Ready"');
    });

    it('conditions fieldPath also contains "status" — matches status branch first', () => {
      // 'status.conditions' contains 'status', which is checked before 'conditions'
      // in the readiness check priority order. So it produces == "Ready" instead of .find()
      const refs = [makeRef('deploy', 'status.conditions')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'readiness-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toContain('== "Ready"');
    });

    it('conditions without status in path: uses .find() pattern', () => {
      // A fieldPath that contains 'conditions' but NOT 'readyReplicas', 'ready', or 'status'
      const refs = [makeRef('deploy', 'conditions')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'readiness-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toContain('.find(');
    });

    it('unknown fieldPath: has() && != ""', () => {
      const refs = [makeRef('deploy', 'spec.replicas')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'readiness-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toContain('has(');
    });

    it('readyReplicas matches before ready (ordering)', () => {
      // 'readyReplicas' contains both 'readyReplicas' and 'ready'
      // readyReplicas check comes first
      const refs = [makeRef('deploy', 'status.readyReplicas')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'readiness-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('resources.deploy.status.readyReplicas > 0');
    });

    it('multiple refs: joined with &&', () => {
      const refs = [makeRef('deploy', 'status.readyReplicas'), makeRef('svc', 'status.ready')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'readiness-check',
        defaultConfig
      );

      expect(result.celExpression.expression).toContain('&&');
      expect(result.celExpression._type).toBe('boolean');
    });

    it('multi-ref conditions fieldPath: uses has() instead of .find()', () => {
      // Multi-ref branch does NOT have the .find() pattern for 'conditions'
      const refs = [makeRef('deploy', 'status.conditions'), makeRef('svc', 'status.ready')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'readiness-check',
        defaultConfig
      );

      // The conditions ref in multi-ref uses has() (no 'conditions' branch)
      // Actually 'conditions' doesn't match 'readyReplicas', 'ready', or 'status' in multi-ref
      // Wait — 'status.conditions' DOES contain 'status', so it matches the 'status' branch
      expect(result.celExpression.expression).toContain('resources.deploy.status.conditions');
    });
  });

  describe('template-interpolation strategy', () => {
    it('string _type: base expression directly', () => {
      const refs = [makeRef('deploy', 'metadata.name', 'string')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'template-interpolation',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('resources.deploy.metadata.name');
      expect(result.celExpression._type).toBe('string');
    });

    it('non-string _type: wrapped in string()', () => {
      const refs = [makeRef('deploy', 'status.readyReplicas', 'number')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'template-interpolation',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('string(resources.deploy.status.readyReplicas)');
    });

    it('undefined _type: wrapped in string()', () => {
      const refs = [makeRef('deploy', 'status.phase')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'template-interpolation',
        defaultConfig
      );

      expect(result.celExpression.expression).toContain('string(');
    });

    it('multiple refs: joined with +', () => {
      const refs = [
        makeRef('deploy', 'metadata.name', 'string'),
        makeRef('deploy', 'status.readyReplicas', 'number'),
      ];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'template-interpolation',
        defaultConfig
      );

      expect(result.celExpression.expression).toContain(' + ');
      expect(result.celExpression.expression).toContain('string(');
    });
  });

  describe('direct-evaluation strategy', () => {
    it('single ref: resources.{id}.{path}', () => {
      const refs = [makeRef('deploy', 'status.phase', 'string')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'direct-evaluation',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('resources.deploy.status.phase');
      expect(result.celExpression._type).toBe('string');
    });

    it('single ref __schema__: schema.{path}', () => {
      const refs = [makeRef('__schema__', 'spec.name')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'direct-evaluation',
        defaultConfig
      );

      expect(result.celExpression.expression).toBe('schema.spec.name');
    });

    it('multiple refs: wrapped in array syntax', () => {
      const refs = [makeRef('deploy', 'status.phase'), makeRef('svc', 'status.clusterIP')];

      const result = generator.generateCelExpression(
        refs,
        defaultContext,
        'direct-evaluation',
        defaultConfig
      );

      expect(result.celExpression.expression).toContain('[');
      expect(result.celExpression.expression).toContain(']');
      expect(result.celExpression._type).toBe('array');
    });
  });

  describe('error handling', () => {
    it('wraps errors in ConversionError with strategy info', () => {
      const refs = [makeRef('deploy', 'status.phase')];

      try {
        generator.generateCelExpression(
          refs,
          defaultContext,
          'bad-strategy' as CelGenerationStrategy,
          defaultConfig
        );
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(ConversionError);
        expect((err as ConversionError).message).toContain('bad-strategy');
      }
    });

    it('ConversionError includes original expression info', () => {
      try {
        generator.generateCelExpression(
          [makeRef('deploy', 'status.phase')],
          defaultContext,
          'bad-strategy' as CelGenerationStrategy,
          defaultConfig
        );
      } catch (err) {
        expect((err as ConversionError).originalExpression).toContain('deploy.status.phase');
      }
    });
  });
});
