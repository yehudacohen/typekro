/**
 * Tests for Kro Factory Pattern Types (Task 1)
 *
 * This test file validates that the new types added for the Kro Factory Pattern
 * compile correctly and provide proper type safety. It does NOT test the actual
 * functionality, which will be implemented in future tasks.
 */

import { describe, expect, it } from 'bun:test';
import type {
  Enhanced,
  ResourceBuilder,
  SchemaProxy,
  TypedKroResourceGraphDefinition,
  TypedResourceGraphFactory,
} from '../../src/index';
import { externalRef, simpleDeployment, simpleService } from '../../src/index';
import { isKubernetesRef } from '../../src/utils/type-guards.js';

describe('Kro Factory Pattern - Types Only (Task 1)', () => {
  // Define test types - must be compatible with KroCompatibleType
  interface DatabaseSpec {
    name: string;
    storage: string;
    [key: string]: string | number | boolean | Record<string, any> | any[];
  }

  interface DatabaseStatus {
    connectionString: string;
    host: string;
    port: number;
    [key: string]: string | number | boolean | Record<string, any> | any[];
  }

  interface WebAppSpec {
    name: string;
    image: string;
    [key: string]: string | number | boolean | Record<string, any> | any[];
  }

  interface WebAppStatus {
    url: string;
    replicas: number;
    [key: string]: string | number | boolean | Record<string, any> | any[];
  }

  describe('SchemaProxy Type', () => {
    it('should define SchemaProxy with proper structure', () => {
      // This test validates that SchemaProxy type compiles correctly
      const validateSchemaProxy = (proxy: SchemaProxy<DatabaseSpec, DatabaseStatus>) => {
        expect(proxy.spec).toBeDefined();
        expect(proxy.status).toBeDefined();
      };

      expect(validateSchemaProxy).toBeDefined();
    });

    it('should provide type-safe access to spec and status fields', () => {
      // This validates the type structure without runtime implementation
      const typeTest = (schema: SchemaProxy<DatabaseSpec, DatabaseStatus>) => {
        // These should be accessible and return KubernetesRef objects
        const nameRef = schema.spec.name;
        const storageRef = schema.spec.storage;
        const connectionRef = schema.status.connectionString;
        const hostRef = schema.status.host;
        const portRef = schema.status.port;

        // All should be defined (they're KubernetesRef objects)
        expect(nameRef).toBeDefined();
        expect(storageRef).toBeDefined();
        expect(connectionRef).toBeDefined();
        expect(hostRef).toBeDefined();
        expect(portRef).toBeDefined();
      };

      expect(typeTest).toBeDefined();
    });
  });

  describe('ResourceBuilder Type', () => {
    it('should define ResourceBuilder with correct function signature', () => {
      // This test validates that ResourceBuilder type compiles correctly
      const validateBuilder: ResourceBuilder<DatabaseSpec, DatabaseStatus> = (schema) => {
        // Schema should have the correct structure
        expect(schema.spec).toBeDefined();
        expect(schema.status).toBeDefined();

        // Should return a record of resources
        return {
          testResource: simpleDeployment({
            name: 'test',
            image: 'nginx',
            id: 'testResource',
          }),
        };
      };

      expect(validateBuilder).toBeDefined();
    });

    it('should support Enhanced types in return value', () => {
      // This test validates that ResourceBuilder can return Enhanced types
      const builderWithEnhanced: ResourceBuilder<DatabaseSpec, DatabaseStatus> = (_schema) => {
        // Mock Enhanced resource
        const enhancedResource = {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'test' },
          spec: {} as any,
          status: {} as any,
        } as Enhanced<any, any>;

        return {
          testResource: enhancedResource,
        };
      };

      expect(builderWithEnhanced).toBeDefined();
    });
  });

  describe('TypedResourceGraphFactory Interface', () => {
    it('should define TypedResourceGraphFactory with all required methods', () => {
      // This test validates that TypedResourceGraphFactory interface compiles correctly
      const validateFactory = (
        factory: TypedResourceGraphFactory<DatabaseSpec, DatabaseStatus>
      ) => {
        // Should have getInstance method
        const getInstance: (spec: DatabaseSpec) => Enhanced<DatabaseSpec, DatabaseStatus> =
          factory.getInstance;

        // Should have toYaml method
        const toYaml: () => string = factory.toYaml;

        // Should have schema property
        const schema: SchemaProxy<DatabaseSpec, DatabaseStatus> = factory.schema;

        // Should have definition property
        const definition: TypedKroResourceGraphDefinition<DatabaseSpec, DatabaseStatus> =
          factory.definition;

        expect(getInstance).toBeDefined();
        expect(toYaml).toBeDefined();
        expect(schema).toBeDefined();
        expect(definition).toBeDefined();
      };

      expect(validateFactory).toBeDefined();
    });
  });

  describe('TypedKroResourceGraphDefinition Interface', () => {
    it('should define TypedKroResourceGraphDefinition extending base definition', () => {
      // This test validates that TypedKroResourceGraphDefinition compiles correctly
      const validateDefinition = (
        def: TypedKroResourceGraphDefinition<DatabaseSpec, DatabaseStatus>
      ) => {
        expect(def.apiVersion).toBe('kro.run/v1alpha1');
        expect(def.kind).toBe('ResourceGraphDefinition');
        expect(def.metadata).toBeDefined();
        expect(def.spec).toBeDefined();

        // Should have typed schema
        const schema = def.spec.schema;
        expect(schema.spec).toBeDefined();
        expect(schema.status).toBeDefined();
      };

      // Create a mock definition for testing
      const mockDefinition: TypedKroResourceGraphDefinition<DatabaseSpec, DatabaseStatus> = {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: { name: 'test' },
        spec: {
          schema: {
            apiVersion: 'v1alpha1',
            kind: 'Database',
            spec: { name: 'test', storage: '10Gi' } as any,
            status: { connectionString: 'test', host: 'test', port: 5432 } as any,
          },
          resources: [],
        },
      };

      validateDefinition(mockDefinition);
    });
  });

  describe('External Reference Support', () => {
    it('should create external references with Enhanced proxy', () => {
      const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
        'v1alpha1',
        'Database',
        'production-db'
      );

      expect(dbRef.apiVersion).toBe('v1alpha1');
      expect(dbRef.kind).toBe('Database');
      expect(dbRef.metadata.name).toBe('production-db');
      expect((dbRef as any).__externalRef).toBe(true);
    });

    it('should support external references with namespaces', () => {
      const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
        'v1alpha1',
        'Database',
        'production-db',
        'production'
      );

      expect(dbRef.apiVersion).toBe('v1alpha1');
      expect(dbRef.kind).toBe('Database');
      expect(dbRef.metadata.name).toBe('production-db');
      expect(dbRef.metadata.namespace).toBe('production');
      expect((dbRef as any).__externalRef).toBe(true);
    });

    it('should provide type-safe access to external reference fields', () => {
      const dbRef = externalRef<DatabaseSpec, DatabaseStatus>(
        'v1alpha1',
        'Database',
        'production-db'
      );

      // These should be accessible and return KubernetesRef objects
      const connectionRef = dbRef.status.connectionString;
      const hostRef = dbRef.status.host;
      const portRef = dbRef.status.port;

      expect(connectionRef).toBeDefined();
      expect(hostRef).toBeDefined();
      expect(portRef).toBeDefined();

      // Should have KubernetesRef properties
      expect(isKubernetesRef(connectionRef)).toBe(true);
      expect(connectionRef).toHaveProperty('resourceId');
      expect(connectionRef).toHaveProperty('fieldPath');
    });
  });

  describe('Type Safety Validation', () => {
    it('should enforce type safety in ResourceBuilder function', () => {
      // This test validates that the types provide proper type safety
      const typeSafeBuilder: ResourceBuilder<DatabaseSpec, DatabaseStatus> = (schema) => {
        // These should be type-safe accesses
        const nameRef = schema.spec.name; // Should be KubernetesRef<string>
        const replicasRef = schema.spec.storage; // Should be KubernetesRef<string>
        const readyRef = schema.status.connectionString; // Should be KubernetesRef<string>
        const urlRef = schema.status.host; // Should be KubernetesRef<string>

        // All should be defined (they're KubernetesRef objects)
        expect(nameRef).toBeDefined();
        expect(replicasRef).toBeDefined();
        expect(readyRef).toBeDefined();
        expect(urlRef).toBeDefined();

        return {
          testResource: simpleDeployment({
            name: 'test',
            image: 'nginx',
            id: 'testResource',
          }),
        };
      };

      expect(typeSafeBuilder).toBeDefined();
    });

    it('should support mixed resource types in ResourceBuilder return', () => {
      // This test validates that ResourceBuilder can return mixed types
      const mixedBuilder: ResourceBuilder<WebAppSpec, WebAppStatus> = (_schema) => {
        return {
          pod: simpleDeployment({
            name: 'test-pod',
            image: 'nginx',
            id: 'testPod',
          }),
          service: simpleService({
            name: 'test-service',
            selector: { app: 'test' },
            ports: [{ port: 80, targetPort: 80 }],
            id: 'testService',
          }),
        };
      };

      expect(mixedBuilder).toBeDefined();
    });
  });
});
