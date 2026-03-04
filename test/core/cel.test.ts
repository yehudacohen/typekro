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
});
