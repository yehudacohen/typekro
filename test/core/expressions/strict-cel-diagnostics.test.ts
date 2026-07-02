/**
 * Strict CEL diagnostics — loud failures at the JS→CEL analysis boundary.
 *
 * By default, when the analyzer cannot prove an emitted CEL expression
 * type-checks (e.g. a member expression references a resource that is not
 * part of the resource graph), it emits the expression anyway and surfaces
 * the problem as a warning. The failure then only shows up when KRO marks
 * the ResourceGraphDefinition Inactive on a live cluster.
 *
 * In strict mode the conversion throws at analysis/serialization time with
 * the offending expression instead. Strictness is enabled via:
 *   1. `strictCelDiagnostics: true` on the AnalysisContext,
 *   2. the `strictCelDiagnostics` factory option (enforced when the kro
 *      factory serializes the RGD), or
 *   3. the `TYPEKRO_STRICT_CEL=1` environment variable (global default).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { ConversionError, UnknownResourceError } from '../../../src/core/errors.js';
import {
  type AnalysisContext,
  JavaScriptToCelAnalyzer,
} from '../../../src/core/expressions/analysis/analyzer.js';
import { SourceMapBuilder } from '../../../src/core/expressions/analysis/source-map.js';
import { Cel, simple, toResourceGraph } from '../../../src/index.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;

function restoreStrictEnv(): void {
  if (ORIGINAL_STRICT_ENV === undefined) {
    delete process.env.TYPEKRO_STRICT_CEL;
  } else {
    process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
  }
}

describe('Strict CEL diagnostics', () => {
  let analyzer: JavaScriptToCelAnalyzer;

  function makeContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
    return {
      type: 'status',
      availableReferences: { deployment: {} as never },
      factoryType: 'kro',
      sourceMap: new SourceMapBuilder(),
      dependencies: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    analyzer = new JavaScriptToCelAnalyzer();
    delete process.env.TYPEKRO_STRICT_CEL;
  });

  afterEach(() => {
    restoreStrictEnv();
  });

  describe('default (lenient) mode', () => {
    it('emits placeholder CEL for an unknown-resource member expression without throwing', () => {
      const result = analyzer.analyzeExpression('unknowndeployment.status.ready', makeContext());

      expect(result.valid).toBe(true);
      expect(result.celExpression?.expression).toBe('resources.unknowndeployment.status.ready');
    });

    it('surfaces the unknown resource as a resource_validation warning on the result', () => {
      const result = analyzer.analyzeExpression('unknowndeployment.status.ready', makeContext());

      const warningMessages = result.warnings.map((w) => w.message).join('\n');
      expect(warningMessages).toContain('unknowndeployment');
      expect(result.warnings.some((w) => w.type === 'resource_validation')).toBe(true);
    });
  });

  describe('strict mode via AnalysisContext.strictCelDiagnostics', () => {
    it('throws a ConversionError naming the offending expression', () => {
      const ctx = makeContext({ strictCelDiagnostics: true });

      expect(() => analyzer.analyzeExpression('unknowndeployment.status.ready', ctx)).toThrow(
        ConversionError
      );

      try {
        analyzer.analyzeExpression('unknowndeployment.status.ready', ctx);
        throw new Error('expected analyzeExpression to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(UnknownResourceError);
        const conversionError = error as UnknownResourceError;
        expect(conversionError.message).toContain('unknowndeployment.status.ready');
        expect(conversionError.message).toContain("'unknowndeployment'");
        // The error lists the known resources so the typo is easy to spot
        expect(conversionError.message).toContain('deployment');
        expect(conversionError.resourceName).toBe('unknowndeployment');
        expect(conversionError.availableResources).toEqual(['deployment']);
      }
    });

    it('throws for explicit resources.* references to unknown resources', () => {
      const ctx = makeContext({ strictCelDiagnostics: true });

      expect(() =>
        analyzer.analyzeExpression('resources.unknowndeployment.status.ready', ctx)
      ).toThrow(UnknownResourceError);
    });

    it('still converts expressions that reference known resources', () => {
      const ctx = makeContext({ strictCelDiagnostics: true });
      const result = analyzer.analyzeExpression('deployment.status.readyReplicas > 0', ctx);

      expect(result.valid).toBe(true);
      expect(result.celExpression?.expression).toContain('deployment.status.readyReplicas');
    });

    it('does not treat bare schema-context identifiers (spec.*) as unknown resources', () => {
      // In composition functions `spec` is the destructured schema parameter;
      // later stages remap it to `schema.spec.*`. It must never trip strict mode.
      const ctx = makeContext({ strictCelDiagnostics: true });
      const result = analyzer.analyzeExpression('spec.replicas', ctx);

      expect(result.valid).toBe(true);
    });

    it('does not escalate heuristic field-path findings on known resources', () => {
      // Field-path validation guesses shapes against magic proxies whose
      // status is not populated at analysis time — unprovable, so it stays
      // a warning even in strict mode.
      const ctx = makeContext({ strictCelDiagnostics: true });
      const result = analyzer.analyzeExpression('Math.min(deployment.status.replicas, 5)', ctx);

      expect(result.valid).toBe(true);
    });
  });

  describe('strict mode via TYPEKRO_STRICT_CEL environment variable', () => {
    it('behaves like the context flag when TYPEKRO_STRICT_CEL=1', () => {
      process.env.TYPEKRO_STRICT_CEL = '1';
      try {
        expect(() =>
          analyzer.analyzeExpression('unknowndeployment.status.ready', makeContext())
        ).toThrow(UnknownResourceError);
      } finally {
        restoreStrictEnv();
      }
    });

    it('accepts "true" as an enabling value', () => {
      process.env.TYPEKRO_STRICT_CEL = 'true';
      try {
        expect(() =>
          analyzer.analyzeExpression('unknowndeployment.status.ready', makeContext())
        ).toThrow(UnknownResourceError);
      } finally {
        restoreStrictEnv();
      }
    });

    it('is overridden by an explicit strictCelDiagnostics: false on the context', () => {
      process.env.TYPEKRO_STRICT_CEL = '1';
      try {
        const result = analyzer.analyzeExpression(
          'unknowndeployment.status.ready',
          makeContext({ strictCelDiagnostics: false })
        );
        expect(result.valid).toBe(true);
        expect(result.celExpression?.expression).toBe('resources.unknowndeployment.status.ready');
      } finally {
        restoreStrictEnv();
      }
    });
  });

  describe('factory-level strictCelDiagnostics option', () => {
    const AppSpec = type({ name: 'string' });
    const AppStatus = type({ ready: 'boolean' });

    function buildGraphWithUnknownStatusRef() {
      return toResourceGraph(
        {
          name: 'strict-cel-factory-test',
          apiVersion: 'example.com/v1',
          kind: 'StrictCelFactoryTest',
          spec: AppSpec,
          status: AppStatus,
        },
        (schema) => ({
          // Two resources, so the serializer's single-resource variable
          // remapping heuristic cannot silently "fix" the unknown reference.
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'deployment',
          }),
          service: simple.Service({
            name: schema.spec.name,
            selector: { app: 'strict-cel-factory-test' },
            ports: [{ port: 80 }],
            id: 'service',
          }),
        }),
        () => ({
          // References a resource id that does not exist in this graph (and
          // is dissimilar enough that fuzzy resource matching can't remap it).
          ready: Cel.expr<boolean>('nosuchresource.status.ready'),
        })
      );
    }

    it('toYaml() throws with the offending expression when strictCelDiagnostics is true', () => {
      const graph = buildGraphWithUnknownStatusRef();
      const factory = graph.factory('kro', { strictCelDiagnostics: true });

      expect(() => factory.toYaml()).toThrow(ConversionError);

      try {
        factory.toYaml();
        throw new Error('expected toYaml to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConversionError);
        const conversionError = error as ConversionError;
        expect(conversionError.message).toContain('nosuchresource');
        expect(conversionError.message).toContain('nosuchresource.status.ready');
        // Names the graph and lists the known resources
        expect(conversionError.message).toContain('strict-cel-factory-test');
        expect(conversionError.message).toContain('deployment');
      }
    });

    it('toYaml() succeeds (lenient) without the option and emits the expression', () => {
      const graph = buildGraphWithUnknownStatusRef();
      const factory = graph.factory('kro');

      const yamlOutput = factory.toYaml();
      expect(yamlOutput).toContain('nosuchresource.status.ready');
    });

    it('toYaml() throws under TYPEKRO_STRICT_CEL=1 without the factory option', () => {
      process.env.TYPEKRO_STRICT_CEL = '1';
      try {
        const graph = buildGraphWithUnknownStatusRef();
        const factory = graph.factory('kro');
        expect(() => factory.toYaml()).toThrow(ConversionError);
      } finally {
        restoreStrictEnv();
      }
    });

    it('toYaml() succeeds with strictCelDiagnostics: false even under TYPEKRO_STRICT_CEL=1', () => {
      process.env.TYPEKRO_STRICT_CEL = '1';
      try {
        const graph = buildGraphWithUnknownStatusRef();
        const factory = graph.factory('kro', { strictCelDiagnostics: false });
        expect(factory.toYaml()).toContain('nosuchresource.status.ready');
      } finally {
        restoreStrictEnv();
      }
    });

    it('does not reject graphs whose status references only known resources', () => {
      const graph = toResourceGraph(
        {
          name: 'strict-cel-valid-test',
          apiVersion: 'example.com/v1',
          kind: 'StrictCelValidTest',
          spec: AppSpec,
          status: AppStatus,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            id: 'deployment',
          }),
        }),
        () => ({
          ready: Cel.expr<boolean>('deployment.status.readyReplicas > 0'),
        })
      );

      const factory = graph.factory('kro', { strictCelDiagnostics: true });
      expect(factory.toYaml()).toContain('deployment.status.readyReplicas');
    });
  });
});
