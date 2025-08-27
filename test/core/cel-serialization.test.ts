import { describe, expect, it } from 'bun:test';
import { isCelExpression, processResourceReferences } from '../../src/core.js';
import { Cel, toResourceGraph, simple } from '../../src/index';

describe('CEL Expression Serialization Pipeline', () => {
  describe('KubernetesRef to CelExpression conversion', () => {
    it('should create properly typed CelExpressions from different KubernetesRef types', () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      // Test different CEL utility functions with proper typing
      const stringExpr = Cel.string(database.status.readyReplicas); // number → string
      const intExpr = Cel.int(database.status.readyReplicas); // number → number
      const minExpr = Cel.min(database.status.readyReplicas, 5); // number → number
      const maxExpr = Cel.max(database.status.readyReplicas, 1); // number → number

      // Verify all are CelExpressions
      expect(isCelExpression(stringExpr)).toBe(true);
      expect(isCelExpression(intExpr)).toBe(true);
      expect(isCelExpression(minExpr)).toBe(true);
      expect(isCelExpression(maxExpr)).toBe(true);

      // Verify expression content
      expect(stringExpr.expression).toContain('string(');
      expect(stringExpr.expression).toContain('deploymentPostgres.status.readyReplicas');

      expect(intExpr.expression).toContain('int(');
      expect(minExpr.expression).toContain('min(');
      expect(maxExpr.expression).toContain('max(');
    });

    it('should handle complex CEL expressions with multiple references', () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      const webapp = simple.Deployment({
        name: 'webapp',
        image: 'nginx:latest',
        replicas: 2,
      });

      // Create complex expressions
      const conditionalExpr = Cel.conditional(
        database.status.readyReplicas,
        "'ready'",
        "'not-ready'"
      );

      const templateExpr = Cel.template(
        'Database %s has %s replicas, webapp has %s',
        database.metadata.name,
        database.status.readyReplicas,
        webapp.status.readyReplicas
      );

      const mathExpr = Cel.min(database.status.readyReplicas, webapp.status.readyReplicas);

      expect(isCelExpression(conditionalExpr)).toBe(true);
      expect(isCelExpression(templateExpr)).toBe(true);
      expect(isCelExpression(mathExpr)).toBe(true);

      expect(conditionalExpr.expression).toContain(' ? ');
      expect(conditionalExpr.expression).toContain(' : ');
      expect(templateExpr.expression).toContain('Database');
      expect(mathExpr.expression).toContain('min(');
    });
  });

  describe('CelExpression serialization through processResourceReferences', () => {
    it('should serialize CelExpressions to their expression strings', () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      // Create various CelExpressions
      const stringExpr = Cel.string(database.status.readyReplicas);
      const conditionalExpr = Cel.conditional(
        database.status.readyReplicas,
        "'ready'",
        "'not-ready'"
      );

      // Test serialization through processResourceReferences
      const serializedString = processResourceReferences(stringExpr);
      const serializedConditional = processResourceReferences(conditionalExpr);

      // Should return the expression string, not the CelExpression object
      expect(typeof serializedString).toBe('string');
      expect(typeof serializedConditional).toBe('string');

      expect(serializedString).toBe(`\${${stringExpr.expression}}`);
      expect(serializedConditional).toBe(`\${${conditionalExpr.expression}}`);

      expect(serializedString).toContain('${string(deploymentPostgres.status.readyReplicas)}');
      expect(serializedConditional).toContain('${deploymentPostgres.status.readyReplicas ? ');
    });

    it('should serialize nested objects containing CelExpressions', () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      const complexObject = {
        metadata: {
          name: 'test-resource',
          labels: {
            ready: Cel.conditional(database.status.readyReplicas, "'true'", "'false'"),
          },
        },
        spec: {
          replicas: Cel.max(database.status.readyReplicas, 1),
          config: {
            dbReplicas: Cel.string(database.status.readyReplicas),
            plainValue: 'static-value',
          },
        },
      };

      const serialized = processResourceReferences(complexObject);

      expect(serialized).toEqual({
        metadata: {
          name: 'test-resource',
          labels: {
            ready: "${deploymentPostgres.status.readyReplicas ? 'true' : 'false'}",
          },
        },
        spec: {
          replicas: '${max(deploymentPostgres.status.readyReplicas, 1)}',
          config: {
            dbReplicas: '${string(deploymentPostgres.status.readyReplicas)}',
            plainValue: 'static-value',
          },
        },
      });
    });

    it('should serialize arrays containing CelExpressions', () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      const arrayWithCel = [
        'static-value',
        Cel.string(database.status.readyReplicas),
        {
          nested: Cel.int(database.status.readyReplicas),
        },
      ];

      const serialized = processResourceReferences(arrayWithCel);

      expect(serialized).toEqual([
        'static-value',
        '${string(deploymentPostgres.status.readyReplicas)}',
        {
          nested: '${int(deploymentPostgres.status.readyReplicas)}',
        },
      ]);
    });
  });

  describe('End-to-end YAML generation with CelExpressions', () => {
    it('should generate correct Kro YAML with CelExpressions in environment variables', async () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      const webapp = simple.Deployment({
        name: 'webapp',
        image: 'nginx:latest',
        env: {
          // Use explicit CEL conversions
          DATABASE_READY_REPLICAS: Cel.string(database.status.readyReplicas),
          DATABASE_STATUS: Cel.conditional(database.status.readyReplicas, "'ready'", "'not-ready'"),
          MIN_REPLICAS: Cel.string(Cel.max(database.status.readyReplicas, 1)),
          PLAIN_VALUE: 'static-env-var',
        },
      });

      const { type } = await import('arktype');
      const TestSchema = type({ name: 'string' });
      const resourceGraph = toResourceGraph(
        {
          name: 'test-stack',
          apiVersion: 'test.com/v1',
          kind: 'TestResource',
          spec: TestSchema,
          status: TestSchema,
        },
        () => ({ database, webapp }),
        () => ({ name: 'test-status' })
      );
      const yaml = resourceGraph.toYaml();

      // Verify the YAML contains properly serialized CEL expressions
      expect(yaml).toContain('value: ${string(deploymentPostgres.status.readyReplicas)}');
      expect(yaml).toContain(
        "value: \"${deploymentPostgres.status.readyReplicas ? 'ready' : 'not-ready'}\""
      );
      expect(yaml).toContain('value: ${string(max(deploymentPostgres.status.readyReplicas, 1))}');
      expect(yaml).toContain('value: static-env-var');

      // Should not contain CelExpression objects or [object Object]
      expect(yaml).not.toContain('[object Object]');
      expect(yaml).not.toContain('__brand');
      expect(yaml).not.toContain('CelExpression');
    });

    it('should handle mixed KubernetesRef and CelExpression references', async () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      const webapp = simple.Deployment({
        name: 'webapp',
        image: 'nginx:latest',
        env: {
          // Direct KubernetesRef (string type - should not need string() wrapper)
          DATABASE_HOST: database.status.podIP!,
          // Direct KubernetesRef (number type converted to string)
          DATABASE_AVAILABLE_REPLICAS: Cel.string(database.status.availableReplicas),
          // CelExpression for type conversion
          DATABASE_READY_REPLICAS: Cel.string(database.status.readyReplicas),
          // Complex CelExpression
          DATABASE_STATUS_MESSAGE: Cel.template(
            'Database %s is %s with %s replicas',
            database.metadata.name,
            Cel.conditional(database.status.readyReplicas, "'ready'", "'not-ready'"),
            database.status.readyReplicas
          ),
        },
      });

      const { type } = await import('arktype');
      const TestSchema = type({ name: 'string' });
      const resourceGraph = toResourceGraph(
        {
          name: 'mixed-stack',
          apiVersion: 'test.com/v1',
          kind: 'TestResource',
          spec: TestSchema,
          status: TestSchema,
        },
        () => ({ database, webapp }),
        () => ({ name: 'test-status' })
      );
      const yaml = resourceGraph.toYaml();

      // Direct KubernetesRef should become simple CEL expression (string fields don't need string() wrapper)
      expect(yaml).toContain('value: ${deploymentPostgres.status.podIP}');

      // CelExpression should become the expression content
      expect(yaml).toContain('value: ${string(deploymentPostgres.status.readyReplicas)}');

      // Complex template should be properly serialized as CEL concatenation
      expect(yaml).toContain('Database postgres is');
      expect(yaml).toContain('+ \\" replicas\\"');
    });

    it('should preserve type safety in serialized output', () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      // Create expressions with different return types
      const stringExpr = Cel.string(database.status.readyReplicas); // CelExpression<string>
      const numberExpr = Cel.int(database.status.readyReplicas); // CelExpression<number>

      // Both should serialize to strings (the CEL expression)
      const serializedString = processResourceReferences(stringExpr);
      const serializedNumber = processResourceReferences(numberExpr);

      expect(typeof serializedString).toBe('string');
      expect(typeof serializedNumber).toBe('string');

      expect(serializedString).toBe('${string(deploymentPostgres.status.readyReplicas)}');
      expect(serializedNumber).toBe('${int(deploymentPostgres.status.readyReplicas)}');
    });
  });

  describe('Error handling and edge cases', () => {
    it('should handle null and undefined values in serialization', () => {
      const testObject = {
        nullValue: null,
        undefinedValue: undefined,
        emptyString: '',
        zeroNumber: 0,
        falseBoolean: false,
      };

      const serialized = processResourceReferences(testObject);

      expect(serialized).toEqual({
        nullValue: null,
        undefinedValue: undefined,
        emptyString: '',
        zeroNumber: 0,
        falseBoolean: false,
      });
    });

    it('should handle deeply nested structures with mixed reference types', () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      const deepObject = {
        level1: {
          level2: {
            level3: {
              directRef: database.status.readyReplicas,
              celExpr: Cel.string(database.status.readyReplicas),
              array: [
                Cel.string(database.status.availableReplicas),
                Cel.conditional(database.status.readyReplicas, "'up'", "'down'"),
                'static-value',
              ],
            },
          },
        },
      };

      const serialized = processResourceReferences(deepObject);

      expect(serialized).toEqual({
        level1: {
          level2: {
            level3: {
              directRef: '${deploymentPostgres.status.readyReplicas}',
              celExpr: '${string(deploymentPostgres.status.readyReplicas)}',
              array: [
                '${string(deploymentPostgres.status.availableReplicas)}',
                "${deploymentPostgres.status.readyReplicas ? 'up' : 'down'}",
                'static-value',
              ],
            },
          },
        },
      });
    });
  });
});
