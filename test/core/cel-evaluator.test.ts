/**
 * Unit tests for CEL expression evaluator using cel-js
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import { CelEvaluationError, CelEvaluator } from '../../src/core.js';

describe('CelEvaluator', () => {
  let evaluator: CelEvaluator;
  let context: any;

  beforeEach(() => {
    evaluator = new CelEvaluator();
    context = {
      resources: new Map(),
      variables: {},
      functions: {},
    };
  });

  describe('evaluate', () => {
    it('should evaluate simple arithmetic expressions', async () => {
      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: '2 + 3 * 4',
      };

      const result = await evaluator.evaluate(expression, context);
      expect(result).toBe(14);
    });

    it('should evaluate string operations', async () => {
      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: '"hello" + " " + "world"',
      };

      const result = await evaluator.evaluate(expression, context);
      expect(result).toBe('hello world');
    });

    it('should evaluate boolean expressions', async () => {
      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'true && false || true',
      };

      const result = await evaluator.evaluate(expression, context);
      expect(result).toBe(true);
    });

    it('should evaluate expressions with variables', async () => {
      context.variables = { x: 10, y: 5 };

      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'x > y',
      };

      const result = await evaluator.evaluate(expression, context);
      expect(result).toBe(true);
    });

    it('should evaluate expressions with resource references', async () => {
      const resource = {
        status: {
          podIP: '10.0.0.1',
          port: 8080,
        },
      };

      context.resources.set('database', resource);

      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'database.status.podIP + ":" + string(database.status.port)',
      };

      const result = await evaluator.evaluate(expression, context);
      expect(result).toBe('10.0.0.1:8080');
    });

    it('should evaluate complex expressions with multiple resources', async () => {
      const database = {
        status: { ready: true, replicas: 3 },
      };

      const cache = {
        status: { ready: true, replicas: 2 },
      };

      context.resources.set('database', database);
      context.resources.set('cache', cache);

      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression:
          'database.status.ready && cache.status.ready && (database.status.replicas + cache.status.replicas) >= 5',
      };

      const result = await evaluator.evaluate(expression, context);
      expect(result).toBe(true);
    });

    it('should evaluate conditional expressions', async () => {
      context.variables = { env: 'production' };

      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'env == "production" ? "prod-config" : "dev-config"',
      };

      const result = await evaluator.evaluate(expression, context);
      expect(result).toBe('prod-config');
    });

    it('should evaluate list operations', async () => {
      context.variables = { numbers: [1, 2, 3, 4, 5] };

      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'numbers.all(x, x > 0)',
      };

      const result = await evaluator.evaluate(expression, context);
      expect(result).toBe(true);
    });

    it('should evaluate map operations', async () => {
      context.variables = { config: { debug: true, port: 8080 } };

      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'has(config.debug) && config.port > 8000',
      };

      const result = await evaluator.evaluate(expression, context);
      expect(result).toBe(true);
    });

    it('should evaluate with custom functions', async () => {
      context.functions = {
        double: (x: number) => x * 2,
        greet: (name: string) => `Hello, ${name}!`,
      };

      const expression1 = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'double(21)',
      };

      const expression2 = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'greet("World")',
      };

      const result1 = await evaluator.evaluate(expression1, context);
      const result2 = await evaluator.evaluate(expression2, context);

      expect(result1).toBe(42);
      expect(result2).toBe('Hello, World!');
    });

    it('should throw error for undefined resources', async () => {
      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'nonexistent.status.ready',
      };

      await expect(evaluator.evaluate(expression, context)).rejects.toThrow(
        "Resource 'nonexistent' not found in context"
      );
    });

    it('should throw error for invalid expressions', async () => {
      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'invalid syntax here !!!',
      };

      await expect(evaluator.evaluate(expression, context)).rejects.toThrow(CelEvaluationError);
    });
  });

  describe('parse', () => {
    it('should parse and reuse expressions', async () => {
      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'x + y',
      };

      const parsedEvaluator = evaluator.parse(expression);

      const result1 = await parsedEvaluator({ ...context, variables: { x: 1, y: 2 } });
      const result2 = await parsedEvaluator({ ...context, variables: { x: 10, y: 20 } });

      expect(result1).toBe(3);
      expect(result2).toBe(30);
    });

    it('should throw error for invalid syntax during parsing', () => {
      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'invalid syntax !!!',
      };

      expect(() => evaluator.parse(expression)).toThrow(CelEvaluationError);
    });
  });

  describe('validate', () => {
    it('should validate correct expressions', () => {
      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: '2 + 2',
      };

      const result = evaluator.validate(expression);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should invalidate incorrect expressions', () => {
      const expression = {
        [CEL_EXPRESSION_BRAND]: true as const,
        expression: 'invalid syntax !!!',
      };

      const result = evaluator.validate(expression);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('extractResourceReferences', () => {
    it('should extract resource references from expressions', () => {
      const extractResourceReferences = (evaluator as any).extractResourceReferences.bind(
        evaluator
      );

      const refs = extractResourceReferences('database.status.ready && cache.spec.replicas > 0');

      expect(refs).toHaveLength(2);
      expect(refs[0]).toEqual({ resourceId: 'database', fieldPath: 'status.ready' });
      expect(refs[1]).toEqual({ resourceId: 'cache', fieldPath: 'spec.replicas' });
    });

    it('should handle complex field paths', () => {
      const extractResourceReferences = (evaluator as any).extractResourceReferences.bind(
        evaluator
      );

      const refs = extractResourceReferences('service.spec.ports[0].port');

      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({ resourceId: 'service', fieldPath: 'spec.ports[0].port' });
    });

    it('should handle nested field paths', () => {
      const extractResourceReferences = (evaluator as any).extractResourceReferences.bind(
        evaluator
      );

      const refs = extractResourceReferences('deployment.spec.template.metadata.labels.app');

      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        resourceId: 'deployment',
        fieldPath: 'spec.template.metadata.labels.app',
      });
    });
  });

  describe('static expression builders', () => {
    it('should create concat expressions', () => {
      const ref = {
        [KUBERNETES_REF_BRAND]: true as const,
        resourceId: 'database',
        fieldPath: 'status.endpoint',
      };

      const expression = CelEvaluator.expressions.concat('postgresql://', ref, ':5432/mydb');

      expect(expression.expression).toBe(
        'concat("postgresql://", database.status.endpoint, ":5432/mydb")'
      );
    });

    it('should create conditional expressions', () => {
      const ref = {
        [KUBERNETES_REF_BRAND]: true as const,
        resourceId: 'config',
        fieldPath: 'data.debug',
      };

      const expression = CelEvaluator.expressions.conditional(ref, 'debug-mode', 'production-mode');

      expect(expression.expression).toBe('config.data.debug ? "debug-mode" : "production-mode"');
    });

    it('should create has expressions', () => {
      const ref = {
        [KUBERNETES_REF_BRAND]: true as const,
        resourceId: 'secret',
        fieldPath: 'data.password',
      };

      const expression = CelEvaluator.expressions.has(ref);

      expect(expression.expression).toBe('has(secret.data.password)');
    });

    it('should create size expressions', () => {
      const ref = {
        [KUBERNETES_REF_BRAND]: true as const,
        resourceId: 'deployment',
        fieldPath: 'spec.replicas',
      };

      const expression = CelEvaluator.expressions.size(ref);

      expect(expression.expression).toBe('size(deployment.spec.replicas)');
    });

    it('should create string method expressions', () => {
      const ref = {
        [KUBERNETES_REF_BRAND]: true as const,
        resourceId: 'service',
        fieldPath: 'metadata.name',
      };

      const containsExpr = CelEvaluator.expressions.contains(ref, 'api');
      const startsWithExpr = CelEvaluator.expressions.startsWith(ref, 'my-');
      const endsWithExpr = CelEvaluator.expressions.endsWith(ref, '-service');

      expect(containsExpr.expression).toBe('service.metadata.name.contains("api")');
      expect(startsWithExpr.expression).toBe('service.metadata.name.startsWith("my-")');
      expect(endsWithExpr.expression).toBe('service.metadata.name.endsWith("-service")');
    });

    it('should create list operation expressions', () => {
      const ref = {
        [KUBERNETES_REF_BRAND]: true as const,
        resourceId: 'deployment',
        fieldPath: 'spec.template.spec.containers',
      };

      const allExpr = CelEvaluator.expressions.all(ref, 'x.image != ""');
      const existsExpr = CelEvaluator.expressions.exists(ref, 'x.name == "main"');
      const filterExpr = CelEvaluator.expressions.filter(ref, 'x.ports.size() > 0');
      const mapExpr = CelEvaluator.expressions.map(ref, 'x.name');

      expect(allExpr.expression).toBe(
        'deployment.spec.template.spec.containers.all(x, x.image != "")'
      );
      expect(existsExpr.expression).toBe(
        'deployment.spec.template.spec.containers.exists(x, x.name == "main")'
      );
      expect(filterExpr.expression).toBe(
        'deployment.spec.template.spec.containers.filter(x, x.ports.size() > 0)'
      );
      expect(mapExpr.expression).toBe('deployment.spec.template.spec.containers.map(x, x.name)');
    });
  });

  describe('createExpression', () => {
    it('should create expressions with placeholders', () => {
      const ref1 = {
        [KUBERNETES_REF_BRAND]: true as const,
        resourceId: 'database',
        fieldPath: 'status.host',
      };

      const ref2 = {
        [KUBERNETES_REF_BRAND]: true as const,
        resourceId: 'database',
        fieldPath: 'status.port',
      };

      const expression = CelEvaluator.createExpression('$0 + ":" + string($1)', ref1, ref2);

      expect(expression.expression).toBe(
        'database.status.host + ":" + string(database.status.port)'
      );
    });
  });
});
