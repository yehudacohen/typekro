import { describe, expect, it } from 'bun:test';
import { Cel, simple } from '../../src/index';
import { isCelExpression } from '../../src/utils/type-guards.js';

describe('Type Safety', () => {
  it('should prevent KubernetesRef<number> assignment to environment variables', () => {
    const database = simple.Deployment({
      name: 'postgres',
      image: 'postgres:13',
      replicas: 1,
    });

    // This should compile - KubernetesRef<string> is allowed in EnvVarValue
    const webapp1 = simple.Deployment({
      name: 'webapp1',
      image: 'nginx:latest',
      env: {
        DATABASE_READY_REPLICAS: Cel.string(database.status?.readyReplicas), // CelExpression<string> - should work
      },
    });

    // This should compile - CelExpression is allowed in EnvVarValue
    const webapp2 = simple.Deployment({
      name: 'webapp2',
      image: 'nginx:latest',
      env: {
        DATABASE_READY_REPLICAS: Cel.string(database.status?.readyReplicas), // CelExpression - should work
      },
    });

    // This should compile - plain string is allowed in EnvVarValue
    const webapp3 = simple.Deployment({
      name: 'webapp3',
      image: 'nginx:latest',
      env: {
        LOG_LEVEL: 'info', // string - should work
      },
    });

    expect(webapp1).toBeDefined();
    expect(webapp2).toBeDefined();
    expect(webapp3).toBeDefined();
  });

  it('should demonstrate that Cel.string() creates proper CEL expressions', () => {
    const database = simple.Deployment({
      name: 'postgres',
      image: 'postgres:13',
      replicas: 1,
    });

    const celExpr = Cel.string(database.status?.readyReplicas);

    expect(celExpr).toBeDefined();
    expect(isCelExpression(celExpr)).toBe(true);
    expect(celExpr.expression).toContain('string(');
    expect(celExpr.expression).toContain('deploymentPostgres.status.readyReplicas');
  });

  it('should demonstrate generic CelExpression type safety', () => {
    const database = simple.Deployment({
      name: 'postgres',
      image: 'postgres:13',
      replicas: 1,
    });

    // Cel.string() returns CelExpression<string>
    const stringExpr = Cel.string(database.status?.readyReplicas);

    // Cel.int() returns CelExpression<number>
    const intExpr = Cel.int(database.status?.readyReplicas);

    // This should work - CelExpression<string> is allowed in EnvVarValue
    const webapp1 = simple.Deployment({
      name: 'webapp1',
      image: 'nginx:latest',
      env: {
        DATABASE_READY_REPLICAS: stringExpr, // CelExpression<string> - should work
      },
    });

    expect(webapp1).toBeDefined();
    expect(isCelExpression(stringExpr)).toBe(true);
    expect(isCelExpression(intExpr)).toBe(true);
  });
});
