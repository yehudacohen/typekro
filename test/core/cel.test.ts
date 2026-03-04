import { describe, expect, it } from 'bun:test';
import { cel } from '../../src/core/references/cel.js';
import { Cel, isCelExpression, simple, toResourceGraph } from '../../src/index.js';

describe('CEL Expression Builder', () => {
  it('should create CEL expressions with type safety', () => {
    const database = simple.Deployment({
      name: 'postgres',
      image: 'postgres:13',
      replicas: 1,
    });

    const celExpr = Cel.expr(database.status?.readyReplicas, ' > 0');

    expect(isCelExpression(celExpr)).toBe(true);
    expect(celExpr.expression).toContain('deploymentPostgres.');
    expect(celExpr.expression).toContain('.status.readyReplicas');
    expect(celExpr.expression).toContain(' > 0');
  });

  it('should handle conditional expressions', () => {
    const database = simple.Deployment({
      name: 'postgres',
      image: 'postgres:13',
      replicas: 1,
    });

    const conditional = Cel.conditional(database.status?.readyReplicas, "'ready'", "'not-ready'");

    expect(isCelExpression(conditional)).toBe(true);
    expect(conditional.expression).toContain(' ? ');
    expect(conditional.expression).toContain(' : ');
  });

  it('should serialize CEL expressions correctly in resource graphs', async () => {
    const database = simple.Deployment({
      name: 'postgres',
      image: 'postgres:13',
      replicas: 1,
    });

    const webapp = simple.Deployment({
      name: 'webapp',
      image: 'nginx:latest',
      replicas: 1,
      env: {
        DATABASE_READY: Cel.expr(database.status?.readyReplicas, ' > 0'),
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

    expect(yaml).toContain('deploymentPostgres.');
    expect(yaml).toContain('status.readyReplicas > 0');
    expect(yaml).not.toContain('[object Object]');
  });

  it('should support mathematical operations', () => {
    const database = simple.Deployment({
      name: 'postgres',
      image: 'postgres:13',
      replicas: 1,
    });

    const minExpr = Cel.min(database.status?.readyReplicas, 5);
    const maxExpr = Cel.max(database.status?.readyReplicas, 1);

    expect(minExpr.expression).toContain('min(');
    expect(maxExpr.expression).toContain('max(');
  });

  it('should support string templates', () => {
    const database = simple.Deployment({
      name: 'postgres',
      image: 'postgres:13',
      replicas: 1,
    });

    const template = Cel.template(
      'Database %s has %s replicas',
      database.metadata.name,
      database.status?.readyReplicas
    );

    expect(template.expression).toContain('Database');
    expect(template.expression).toContain('deploymentPostgres.');
  });

  describe('CEL string escaping', () => {
    it('should escape double quotes in Cel.concat() string literals', () => {
      const result = Cel.concat('hello "world"', '-suffix');
      // Should produce: "hello \"world\"" + "-suffix"
      expect(result.expression).toBe('"hello \\"world\\"" + "-suffix"');
    });

    it('should escape backslashes in Cel.concat() string literals', () => {
      const result = Cel.concat('path\\to\\file', '-name');
      // Should produce: "path\\to\\file" + "-name"
      expect(result.expression).toBe('"path\\\\to\\\\file" + "-name"');
    });

    it('should escape both backslashes and quotes in Cel.concat()', () => {
      const result = Cel.concat('say \\"hi\\"');
      // Backslashes escaped first, then quotes
      expect(result.expression).toBe('"say \\\\\\"hi\\\\\\""');
    });

    it('should escape double quotes in cel template tag string segments', () => {
      const result = cel`prefix "quoted" suffix`;
      expect(result.expression).toBe('"prefix \\"quoted\\" suffix"');
    });

    it('should escape backslashes in cel template tag string segments', () => {
      const result = cel`path\\to\\file`;
      expect(result.expression).toBe('"path\\\\to\\\\file"');
    });

    it('should escape double quotes in cel template tag interpolated strings', () => {
      const value = 'hello "world"';
      const result = cel`prefix ${value} suffix`;
      expect(result.expression).toBe('"prefix " + "hello \\"world\\"" + " suffix"');
    });

    it('should escape backslashes in cel template tag interpolated strings', () => {
      const value = 'back\\slash';
      const result = cel`prefix ${value} suffix`;
      expect(result.expression).toBe('"prefix " + "back\\\\slash" + " suffix"');
    });

    it('should handle Cel.concat() with non-string types containing special chars', () => {
      // Non-string types are converted via String() then quoted
      const obj = { toString: () => 'has "quotes"' };
      const result = Cel.concat(obj as unknown as string);
      expect(result.expression).toBe('"has \\"quotes\\""');
    });
  });

  describe('Cel.template() ${} escaping', () => {
    it('should escape ${ in literal string values to prevent CEL injection', () => {
      const template = Cel.template('Prefix: %s', 'Use ${foo} syntax');
      // The literal value should have ${ escaped with backslash
      // so convertTemplateToCelConcat won't misinterpret it as a CEL ref
      expect(template.expression).toBe('Prefix: Use \\${foo} syntax');
      // The \${ pattern means the $ is escaped — serialization will treat it as literal text
    });

    it('should handle literal values without ${ unchanged', () => {
      const template = Cel.template('Hello %s', 'world');
      expect(template.expression).toBe('Hello world');
    });

    it('should escape multiple ${ occurrences in a single literal', () => {
      const template = Cel.template('Values: %s', '${a} and ${b}');
      // Both ${ should be escaped
      expect(template.expression).toBe('Values: \\${a} and \\${b}');
    });

    it('should not escape ${ produced from KubernetesRef proxy access', () => {
      const deployment = simple.Deployment({
        name: 'test',
        image: 'nginx:latest',
      });
      // KubernetesRef values produce ${...} placeholders that should NOT be escaped
      const template = Cel.template('Replicas: %s', deployment.status?.readyReplicas);
      // The KubernetesRef produces a real ${ref} placeholder
      expect(template.expression).toMatch(/\$\{deploymentTest\./);
      expect(template.__isTemplate).toBe(true);
    });

    it('should preserve template flag for serialization', () => {
      const template = Cel.template('Static text only');
      expect(template.__isTemplate).toBe(true);
      expect(template.expression).toBe('Static text only');
    });
  });

  describe('Typed convenience methods', () => {
    it('Cel.boolean() should produce a CelExpression with boolean type', () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      const boolResult = Cel.boolean(database.status?.readyReplicas, ' > 0');
      const exprResult = Cel.expr<boolean>(database.status?.readyReplicas, ' > 0');

      expect(isCelExpression(boolResult)).toBe(true);
      expect(boolResult.expression).toBe(exprResult.expression);
    });

    it('Cel.str() should produce a CelExpression with string type', () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      const strResult = Cel.str(database.status?.readyReplicas, ' + "-suffix"');
      const exprResult = Cel.expr<string>(database.status?.readyReplicas, ' + "-suffix"');

      expect(isCelExpression(strResult)).toBe(true);
      expect(strResult.expression).toBe(exprResult.expression);
    });

    it('Cel.number() should produce a CelExpression with number type', () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      const numResult = Cel.number(database.status?.readyReplicas);
      const exprResult = Cel.expr<number>(database.status?.readyReplicas);

      expect(isCelExpression(numResult)).toBe(true);
      expect(numResult.expression).toBe(exprResult.expression);
    });

    it('convenience methods should be functionally identical to Cel.expr<T>()', () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
        replicas: 1,
      });

      // Boolean
      const boolConvenience = Cel.boolean(database.status?.readyReplicas, ' > 0');
      const boolExpr = Cel.expr<boolean>(database.status?.readyReplicas, ' > 0');
      expect(boolConvenience.expression).toBe(boolExpr.expression);

      // String
      const strConvenience = Cel.str(database.status?.readyReplicas, ' + "-suffix"');
      const strExpr = Cel.expr<string>(database.status?.readyReplicas, ' + "-suffix"');
      expect(strConvenience.expression).toBe(strExpr.expression);

      // Number
      const numConvenience = Cel.number(database.status?.readyReplicas);
      const numExpr = Cel.expr<number>(database.status?.readyReplicas);
      expect(numConvenience.expression).toBe(numExpr.expression);
    });
  });
});
