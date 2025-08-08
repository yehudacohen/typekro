/**
 * Consolidated and Statically-Typed Test Suite for TypeKro
 * This file validates the final, magical, and cast-free architecture.
 */

import { describe, expect, it } from 'bun:test';

import {
  Cel,
  isKubernetesRef,
  simpleDeployment,
  simpleService,
  toResourceGraph,
  validateResourceGraph,
} from '../src/index.js';

// =============================================================================
// 1. FACTORY AND PROXY SYSTEM TESTS
// =============================================================================

describe('Core Factory & Proxy System', () => {
  it('should access real properties without casting or errors', () => {
    const webapp = simpleDeployment({
      name: 'web-app',
      image: 'nginx:latest',
    });

    expect(webapp.apiVersion).toBe('apps/v1');
    expect(webapp.kind).toBe('Deployment');
    expect(webapp.metadata.name).toBe('web-app');
    expect(webapp.spec.replicas).toBe(1);
    expect(webapp.spec.selector?.matchLabels?.app).toBe('web-app');
  });

  it('should create references to any property without casting', () => {
    const webSvc = simpleService({
      name: 'web-svc',
      selector: { app: 'web-app' },
      ports: [{ port: 80 }],
    });

    // Accessing a spec field that doesn't exist on the base type creates a reference.
    const clusterIpRef = webSvc.spec.clusterIP;
    // This is a safe test: first, we check if it's a ref, then we check its properties.
    if (isKubernetesRef(clusterIpRef)) {
      expect(clusterIpRef.fieldPath).toBe('spec.clusterIP');
    } else {
      // If it's not a ref, the test should fail.
      expect(isKubernetesRef(clusterIpRef)).toBe(true);
    }

    const someStatusRef = webSvc.status?.someRuntimeField;
    if (isKubernetesRef(someStatusRef)) {
      expect(someStatusRef.fieldPath).toBe('status.someRuntimeField');
    } else {
      expect(isKubernetesRef(someStatusRef)).toBe(true);
    }
  });
});

// =============================================================================
// 2. CROSS-RESOURCE REFERENCE TESTS
// =============================================================================

describe('Cross-Resource References', () => {
  it('should create a type-safe reference for an env var without casting', () => {
    const database = simpleDeployment({ name: 'db', image: 'postgres' });
    const webapp = simpleDeployment({
      name: 'app',
      image: 'my-app',
      env: {
        DB_HOST: database.status?.podIP!,
      },
    });

    const container = webapp.spec.template?.spec?.containers[0];
    const envVar = container?.env?.[0];

    expect(envVar).toBeDefined();
    const ref = envVar?.value;

    // This is the safe, cast-free way to test the reference.
    if (isKubernetesRef(ref)) {
      expect(ref.fieldPath).toBe('status.podIP');
    } else {
      expect(isKubernetesRef(ref)).toBe(true);
    }
  });

  it('should handle references from static metadata correctly', () => {
    const webapp = simpleDeployment({ name: 'web-app', image: 'nginx' });
    const webService = simpleService({
      name: 'web-service',
      // Use '!' because we know the factory creates this label.
      selector: { app: webapp.metadata.labels?.app! },
      ports: [{ port: 80 }],
    });

    expect(isKubernetesRef(webService.spec.selector?.app)).toBe(false);
    expect(webService.spec.selector?.app).toBe('web-app');
  });
});

// =============================================================================
// 3. SERIALIZATION TESTS
// =============================================================================

describe('Serialization Engine', () => {
  it('should convert resource references into CEL expressions', async () => {
    const dbService = simpleService({
      name: 'db',
      selector: { app: 'db' },
      ports: [{ port: 5432 }],
    });
    const webapp = simpleDeployment({
      name: 'app',
      image: 'my-app',
      env: {
        DB_HOST: dbService.spec.clusterIP || 'localhost',
      },
    });

    const { type } = await import('arktype');
    const TestSchema = type({ name: 'string' });
    const resourceGraph = toResourceGraph(
      {
        name: 'my-app',
        apiVersion: 'test.com/v1',
        kind: 'TestResource',
        spec: TestSchema,
        status: TestSchema,
      },
      () => ({ dbService, webapp }),
      () => ({ name: 'test' })
    );
    const yaml = resourceGraph.toYaml();
    const dbServiceId = (dbService as any).__resourceId;
    const expectedCel = `\${${dbServiceId}.spec.clusterIP}`;

    // Corrected, more robust test: Check for the key-value pair with a space,
    // which is how the serializer will output it without quotes.
    expect(yaml).toContain(`value: ${expectedCel}`);
  });

  it('should pass validation for a valid graph', () => {
    const db = simpleDeployment({ name: 'db', image: 'postgres' });
    const app = simpleDeployment({
      name: 'app',
      image: 'my-app',
      env: { DB_REPLICAS: Cel.string(db.status?.replicas) },
    });

    const result = validateResourceGraph({ db, app });
    expect(result.valid).toBe(true);
  });
});
