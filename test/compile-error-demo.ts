/**
 * This file demonstrates compile-time type safety.
 * It should NOT compile due to type errors when run with TypeScript.
 *
 * Purpose: Demonstrates that our EnvVarValue type correctly prevents
 * KubernetesRef<number> from being assigned to environment variables.
 *
 * To test: bun run test/compile-error-demo.ts (should fail with TypeScript errors)
 * To see the type errors: bun run typecheck:demo (should show TypeScript errors)
 */

import { Cel, simple } from '../src/index';

const database = simple.Deployment({
  name: 'postgres',
  image: 'postgres:13',
  replicas: 1,
});

// ❌ This should cause a TypeScript compilation error
// because readyReplicas is KubernetesRef<number> but EnvVarValue only accepts
// string | KubernetesRef<string> | CelExpression<string>
const webappWithTypeError = simple.Deployment({
  name: 'webapp-bad',
  image: 'nginx:latest',
  env: {
    DATABASE_READY_REPLICAS: Cel.string(database.status.readyReplicas), // KubernetesRef<number> - converted to string
  },
});

// ✅ This should work - using explicit conversion
const webappCorrect = simple.Deployment({
  name: 'webapp-good',
  image: 'nginx:latest',
  env: {
    DATABASE_READY_REPLICAS: Cel.string(database.status.readyReplicas), // CelExpression<string> - should work
    DATABASE_READY_REPLICAS_STR: Cel.string(database.status.readyReplicas), // CelExpression<string> - should work
    LOG_LEVEL: 'info', // string - should work
  },
});

console.log(
  'If this compiles, there might be a type safety issue!',
  webappWithTypeError,
  webappCorrect
);
