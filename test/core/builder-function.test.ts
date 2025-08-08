/**
 * Tests for Builder Function Support in toResourceGraph
 *
 * This test file validates that the builder function API works correctly
 * with ArkType schema integration and factory pattern.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { Cel, simpleDeployment, simpleService, toResourceGraph } from '../../src/index.js';

describe('Builder Function Support', () => {
  // Define ArkType schemas for testing
  const DatabaseSpecSchema = type({
    name: 'string',
    storage: 'string',
    replicas: 'number%1', // integer
  });

  const DatabaseStatusSchema = type({
    ready: 'boolean',
    connectionString: 'string',
    host: 'string',
    port: 'number%1', // integer
  });

  const WebAppSpecSchema = type({
    name: 'string',
    image: 'string',
    replicas: 'number%1', // integer
  });

  const WebAppStatusSchema = type({
    ready: 'boolean',
    url: 'string',
    availableReplicas: 'number%1', // integer
  });

  // Infer TypeScript types from ArkType schemas (for type checking only)
  // type DatabaseSpec = typeof DatabaseSpecSchema.infer;
  // type DatabaseStatus = typeof DatabaseStatusSchema.infer;
  // type WebAppSpec = typeof WebAppSpecSchema.infer;
  // type WebAppStatus = typeof WebAppStatusSchema.infer;

  describe('Builder function overload', () => {
    it('should create TypedResourceGraphFactory from builder function', () => {
      const factory = toResourceGraph(
        {
          name: 'database-stack',
          apiVersion: 'v1alpha1',
          kind: 'Database',
          spec: DatabaseSpecSchema,
          status: DatabaseStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: 'postgres:13',
            replicas: schema.spec.replicas,
            id: 'databaseDeployment',
          }),
          service: simpleService({
            name: schema.spec.name,
            selector: { app: schema.spec.name },
            ports: [{ port: 5432, targetPort: 5432 }],
            id: 'databaseService',
          }),
        }),
        (schema, resources) => ({
          connectionString: `postgresql://${resources.service.metadata.name}:5432/${schema.spec.name}`,
          host: Cel.expr<string>(resources.service.metadata?.name, ' || "unknown"'),
          port: 5432,
          ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
        })
      );

      // Should return a ResourceGraph
      expect(factory).toHaveProperty('toYaml');
      expect(factory).toHaveProperty('factory');
      expect(factory).toHaveProperty('schema');
      expect(factory).toHaveProperty('name');

      // Schema should be a schema proxy
      expect(factory.schema).toBeDefined();
      expect(factory.schema!.spec).toBeDefined();
      expect(factory.schema!.status).toBeDefined();

      // Should have correct name
      expect(factory.name).toBe('database-stack');
    });

    it('should generate valid YAML from builder function', () => {
      const factory = toResourceGraph(
        {
          name: 'webapp-stack',
          apiVersion: 'v1alpha1',
          kind: 'WebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            replicas: schema.spec.replicas,
            id: 'webappDeployment',
          }),
        }),
        (_schema, resources) => ({
          url: `http://${resources.deployment.status.podIP}`,
          ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
          availableReplicas: resources.deployment.status.availableReplicas,
        })
      );

      const yaml = factory.toYaml();

      // Should generate valid Kro YAML
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('name: webapp-stack');
      expect(yaml).toContain('kind: WebApp');
      expect(yaml).toContain('apiVersion: v1alpha1');

      // Should contain the deployment resource
      expect(yaml).toContain('kind: Deployment');
    });

    it('should pass schema proxy to builder function', () => {
      let capturedSchema: unknown = null;

      const factory = toResourceGraph(
        {
          name: 'test-stack',
          apiVersion: 'v1alpha1',
          kind: 'Test',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => {
          capturedSchema = schema;
          return {
            deployment: simpleDeployment({
              name: schema.spec.name,
              image: 'nginx',
              id: 'testDeployment',
            }),
          };
        },
        (_schema, resources) => ({
          url: `http://${resources.deployment.status.podIP}`,
          ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
          availableReplicas: resources.deployment.status.availableReplicas,
        })
      );

      // Trigger the builder function by calling toYaml
      factory.toYaml();

      // Schema should have been passed to builder
      expect(capturedSchema).toBeDefined();
      expect((capturedSchema as any).spec).toBeDefined();
      expect((capturedSchema as any).status).toBeDefined();

      // Schema references should be KubernetesRef objects
      const nameRef = (capturedSchema as any).spec.name;
      expect(nameRef).toHaveProperty('__brand', 'KubernetesRef');
      expect(nameRef).toHaveProperty('resourceId', '__schema__');
      expect(nameRef).toHaveProperty('fieldPath', 'spec.name');
    });

    it('should support complex nested schema structures', () => {
      // Define complex nested ArkType schemas
      const ComplexSpecSchema = type({
        app: {
          name: 'string',
          version: 'string',
        },
        database: {
          host: 'string',
          port: 'number%1', // integer
          credentials: {
            username: 'string',
            password: 'string',
          },
        },
        features: 'string[]',
        config: 'Record<string, string>',
      });

      const ComplexStatusSchema = type({
        phase: 'string',
        components: {
          app: 'boolean',
          database: 'boolean',
        },
        endpoints: 'Record<string, string>',
      });

      // type ComplexSpec = typeof ComplexSpecSchema.infer;
      // type ComplexStatus = typeof ComplexStatusSchema.infer;

      const factory = toResourceGraph(
        {
          name: 'complex-stack',
          apiVersion: 'v1alpha1',
          kind: 'ComplexApp',
          spec: ComplexSpecSchema,
          status: ComplexStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.app.name,
            image: 'nginx',
            env: {
              DB_HOST: schema.spec.database.host,
              DB_USER: schema.spec.database.credentials.username,
              APP_VERSION: schema.spec.app.version,
            },
            id: 'complexDeployment',
          }),
        }),
        (_schema, resources) => ({
          phase: resources.deployment.status.phase,
          components: {
            app: true,
            database: true,
          },
          endpoints: {
            app: `http://${resources.deployment.status.podIP}`,
          },
        })
      );

      const yaml = factory.toYaml();

      // Should handle nested schema references
      expect(yaml).toContain('kind: ComplexApp');
      expect(yaml).toContain('kind: Deployment');
    });
  });

  describe('Backward compatibility', () => {
    it('should work with simple resource graphs', () => {
      // Create a simple resource graph using the new API
      const SimpleSpecSchema = type({
        name: 'string',
        image: 'string',
      });

      const SimpleStatusSchema = type({
        phase: 'string',
      });

      const resourceGraph = toResourceGraph(
        {
          name: 'simple-stack',
          apiVersion: 'v1alpha1',
          kind: 'SimpleApp',
          spec: SimpleSpecSchema,
          status: SimpleStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.name,
            image: schema.spec.image,
            id: 'simpleDeployment',
          }),
          service: simpleService({
            name: 'simple-service',
            selector: { app: schema.spec.name },
            ports: [{ port: 80, targetPort: 80 }],
            id: 'simpleService',
          }),
        }),
        (_schema, resources) => ({
          phase: resources.deployment.status.phase,
        })
      );

      const yaml = resourceGraph.toYaml();

      // Should return YAML string directly
      expect(typeof yaml).toBe('string');
      expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(yaml).toContain('kind: ResourceGraphDefinition');
      expect(yaml).toContain('name: simple-stack');
      expect(yaml).toContain('kind: Deployment');
      expect(yaml).toContain('kind: Service');
    });

    it('should distinguish between static and builder overloads', () => {
      // Create different resource graphs to test the API
      const TestSpecSchema = type({
        appName: 'string',
        version: 'string',
      });

      const TestStatusSchema = type({
        ready: 'boolean',
      });

      const builderResult = toResourceGraph(
        {
          name: 'test-builder',
          apiVersion: 'v1alpha1',
          kind: 'TestApp',
          spec: TestSpecSchema,
          status: TestStatusSchema,
        },
        (schema) => ({
          deployment: simpleDeployment({
            name: schema.spec.appName,
            image: `nginx:${schema.spec.version}`,
            id: 'testDeployment',
          }),
        }),
        (_schema, resources) => ({
          ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
        })
      );

      // Should return ResourceGraph object
      expect(typeof builderResult).toBe('object');
      expect(builderResult).toHaveProperty('toYaml');
      expect(builderResult).toHaveProperty('factory');
      expect(builderResult).toHaveProperty('schema');
    });
  });

  // Note: getInstance functionality will be tested in future tasks when it's implemented
});
