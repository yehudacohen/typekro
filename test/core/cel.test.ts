import { describe, expect, it } from 'bun:test';

import { Cel, isCelExpression, simpleDeployment, toResourceGraph } from '../../src/index.js';

describe('CEL Expression Builder', () => {
  it('should create CEL expressions with type safety', () => {
    const database = simpleDeployment({
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
    const database = simpleDeployment({
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
    const database = simpleDeployment({
      name: 'postgres',
      image: 'postgres:13',
      replicas: 1,
    });

    const webapp = simpleDeployment({
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
    const database = simpleDeployment({
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
    const database = simpleDeployment({
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
});
