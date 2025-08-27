/**
 * Cross-composition magic proxy tests
 * 
 * This test suite validates that TypedResourceGraph objects can be accessed
 * from other compositions using the magic proxy system to automatically
 * create external references.
 */

import { type } from 'arktype';
import { describe, expect, it } from 'bun:test';
import { Cel, kubernetesComposition, simple } from '../../src/index.js';
import type { Enhanced } from '../../src/core/types.js';

// Test schemas
interface DatabaseSpec {
  name: string;
  port: number;
  storage: string;
}

interface DatabaseStatus {
  phase: 'pending' | 'ready' | 'failed';
  host: string;
  connectionString: string;
  ready: boolean;
}



describe('Cross-composition magic proxy', () => {
  describe('Resource access via property names', () => {
    it('should create external references when accessing resource by key name', () => {
      // Create database composition
      const databaseComposition = kubernetesComposition(
        {
          name: 'database-composition',
          apiVersion: 'example.com/v1alpha1',
          kind: 'DatabaseComposition',
          spec: type({
            name: 'string',
            port: 'number',
            storage: 'string',
          }),
          status: type({
            phase: "'pending' | 'ready' | 'failed'",
            host: 'string',
            connectionString: 'string',
            ready: 'boolean',
          }),
        },
        (schema) => ({
          // Create database resources with specific resource keys
          database: simple.Deployment({
            name: 'postgres-db',
            image: 'postgres:15',
            env: {
              POSTGRES_DB: schema.name,
              POSTGRES_PORT: schema.port.toString(),
            },
          }),
          service: simple.Service({
            name: 'postgres-service',
            selector: { app: 'postgres' },
            ports: [{ port: schema.port, targetPort: 5432 }],
          }),
          // Return status
          phase: Cel.expr<'pending' | 'ready' | 'failed'>`'ready'`,
          host: Cel.template('postgres-service.default.svc.cluster.local'),
          connectionString: Cel.template('postgresql://postgres-service:%s/%s', schema.port, schema.name),
          ready: Cel.expr<boolean>`true`,
        })
      );

      // Access resource via magic proxy
      const databaseRef = (databaseComposition as any).database;

      // Should be an Enhanced proxy with external reference marking
      expect(databaseRef).toBeDefined();
      expect((databaseRef as any).__externalRef).toBe(true);
      expect(databaseRef.kind).toBe('Deployment');
      expect(databaseRef.metadata.name).toBe('postgres-db');
      expect(databaseRef.apiVersion).toBe('apps/v1');

      // Should provide type-safe access to spec and status
      const dbSpec = databaseRef.spec;
      const dbStatus = databaseRef.status;
      
      expect(dbSpec).toBeDefined();
      expect(dbStatus).toBeDefined();
    });

    it('should create external references when accessing service by key name', () => {
      const databaseComposition = kubernetesComposition(
        {
          name: 'database-composition',
          apiVersion: 'example.com/v1alpha1',
          kind: 'DatabaseComposition',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (schema) => ({
          database: simple.Deployment({
            name: 'postgres-db',
            image: 'postgres:15',
          }),
          service: simple.Service({
            name: 'postgres-service',
            selector: { app: 'postgres' },
            ports: [{ port: 5432, targetPort: 5432 }],
          }),
          ready: Cel.expr<boolean>`true`,
        })
      );

      // Access service via magic proxy
      const serviceRef = (databaseComposition as any).service;

      expect(serviceRef).toBeDefined();
      expect((serviceRef as any).__externalRef).toBe(true);
      expect(serviceRef.kind).toBe('Service');
      expect(serviceRef.metadata.name).toBe('postgres-service');
      expect(serviceRef.apiVersion).toBe('v1');
    });

    it('should return undefined for non-existent resources', () => {
      const databaseComposition = kubernetesComposition(
        {
          name: 'database-composition',
          apiVersion: 'example.com/v1alpha1',
          kind: 'DatabaseComposition',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (schema) => ({
          database: simple.Deployment({
            name: 'postgres-db',
            image: 'postgres:15',
          }),
          ready: Cel.expr<boolean>`true`,
        })
      );

      // Try to access non-existent resource
      const nonExistentRef = (databaseComposition as any).nonExistentResource;
      expect(nonExistentRef).toBeUndefined();
    });

    it('should not interfere with existing TypedResourceGraph properties', () => {
      const composition = kubernetesComposition(
        {
          name: 'test-composition',
          apiVersion: 'example.com/v1alpha1',
          kind: 'TestComposition',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: 'test-deployment',
            image: 'nginx',
          }),
          ready: Cel.expr<boolean>`true`,
        })
      );

      // Existing properties should work normally
      expect(composition.name).toBe('test-composition');
      expect(composition.resources).toBeDefined();
      expect(Array.isArray(composition.resources)).toBe(true);
      expect(composition.toYaml).toBeInstanceOf(Function);
      expect(composition.factory).toBeInstanceOf(Function);
      expect(composition.schema).toBeDefined();
    });
  });

  describe('Cross-composition usage patterns', () => {
    it('should enable cross-composition references in status builders', () => {
      // Create database composition
      const databaseComposition = kubernetesComposition(
        {
          name: 'database-composition',
          apiVersion: 'example.com/v1alpha1',
          kind: 'DatabaseComposition',
          spec: type({ name: 'string', port: 'number' }),
          status: type({
            host: 'string',
            ready: 'boolean',
          }),
        },
        (schema) => ({
          database: simple.Deployment({
            name: 'postgres-db',
            image: 'postgres:15',
            env: {
              POSTGRES_DB: schema.name,
            },
          }),
          service: simple.Service({
            name: 'postgres-service',
            selector: { app: 'postgres' },
            ports: [{ port: schema.port, targetPort: 5432 }],
          }),
          host: Cel.template('postgres-service.default.svc.cluster.local'),
          ready: Cel.expr<boolean>`true`,
        })
      );

      // Create webapp composition that references database
      const webappComposition = kubernetesComposition(
        {
          name: 'webapp-composition',
          apiVersion: 'example.com/v1alpha1',
          kind: 'WebappComposition',
          spec: type({ name: 'string', image: 'string' }),
          status: type({
            ready: 'boolean',
            databaseHost: 'string',
            databaseReady: 'boolean',
          }),
        },
        (schema) => {
          // Use cross-composition magic proxy to reference database
          const dbRef = (databaseComposition as any).database as Enhanced<DatabaseSpec, DatabaseStatus>;
          const dbServiceRef = (databaseComposition as any).service as Enhanced<any, any>;

          return {
            webapp: simple.Deployment({
              name: 'test-webapp', // Use static name to avoid KubernetesRef issue
              image: schema.image,
              env: {
                // Reference external database via magic proxy
                DATABASE_HOST: dbServiceRef.spec.clusterIP,
                DATABASE_READY: Cel.expr<string>(dbRef.status.ready, ' ? "true" : "false"'),
              },
            }),
            // Status using cross-composition references
            ready: Cel.expr<boolean>`true`,
            databaseHost: dbServiceRef.spec.clusterIP,
            databaseReady: dbRef.status.ready,
          };
        }
      );

      // Validate that compositions were created successfully
      expect(databaseComposition.name).toBe('database-composition');
      expect(webappComposition.name).toBe('webapp-composition');
      
      // Validate resources exist
      expect(databaseComposition.resources).toHaveLength(2); // database + service
      expect(webappComposition.resources).toHaveLength(1); // webapp only
      
      // The cross-composition references should be marked as external
      const dbRef = (databaseComposition as any).database;
      expect((dbRef as any).__externalRef).toBe(true);
    });

    it('should work with different resource naming patterns', () => {
      const composition = kubernetesComposition(
        {
          name: 'test-composition',
          apiVersion: 'example.com/v1alpha1',
          kind: 'TestComposition',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (schema) => ({
          'my-deployment': simple.Deployment({
            name: 'test-deployment',
            image: 'nginx',
          }),
          'my_service': simple.Service({
            name: 'test-service',
            selector: { app: 'test' },
            ports: [{ port: 80, targetPort: 80 }],
          }),
          ready: Cel.expr<boolean>`true`,
        })
      );

      // Should work with kebab-case and snake_case keys
      const deploymentRef = (composition as any)['my-deployment'];
      const serviceRef = (composition as any)['my_service'];

      expect(deploymentRef).toBeDefined();
      expect((deploymentRef as any).__externalRef).toBe(true);
      expect(deploymentRef.metadata.name).toBe('test-deployment');

      expect(serviceRef).toBeDefined();
      expect((serviceRef as any).__externalRef).toBe(true);
      expect(serviceRef.metadata.name).toBe('test-service');
    });

    it('should handle case-insensitive resource key matching', () => {
      const composition = kubernetesComposition(
        {
          name: 'test-composition',
          apiVersion: 'example.com/v1alpha1',
          kind: 'TestComposition',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (schema) => ({
          Database: simple.Deployment({
            name: 'postgres-db',
            image: 'postgres:15',
          }),
          ready: Cel.expr<boolean>`true`,
        })
      );

      // Should match case-insensitively
      const databaseRef1 = (composition as any).Database;
      const databaseRef2 = (composition as any).database;
      const databaseRef3 = (composition as any).DATABASE;

      expect(databaseRef1).toBeDefined();
      expect(databaseRef2).toBeDefined();
      expect(databaseRef3).toBeDefined();

      // All should reference the same resource
      expect(databaseRef1.metadata.name).toBe('postgres-db');
      expect(databaseRef2.metadata.name).toBe('postgres-db');
      expect(databaseRef3.metadata.name).toBe('postgres-db');
    });
  });

  describe('Type safety and Enhanced proxy behavior', () => {
    it('should provide Enhanced proxy interface for cross-composition refs', () => {
      const composition = kubernetesComposition(
        {
          name: 'test-composition',
          apiVersion: 'example.com/v1alpha1',
          kind: 'TestComposition',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: 'test-deployment',
            image: 'nginx',
          }),
          ready: Cel.expr<boolean>`true`,
        })
      );

      const deploymentRef = (composition as any).deployment;

      // Should have Enhanced proxy structure
      expect(deploymentRef.apiVersion).toBe('apps/v1');
      expect(deploymentRef.kind).toBe('Deployment');
      expect(deploymentRef.metadata).toBeDefined();
      expect(deploymentRef.spec).toBeDefined();
      expect(deploymentRef.status).toBeDefined();

      // Accessing nested properties should return KubernetesRef objects
      const specReplicas = deploymentRef.spec.replicas;
      const statusReady = deploymentRef.status.readyReplicas;

      // These should be KubernetesRef objects (proxy functions)
      expect(typeof specReplicas).toBe('function');
      expect(typeof statusReady).toBe('function');
    });

    it('should preserve namespace information in external references', () => {
      const composition = kubernetesComposition(
        {
          name: 'namespaced-composition',
          apiVersion: 'example.com/v1alpha1',
          kind: 'NamespacedComposition',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: 'namespaced-deployment',
            image: 'nginx',
            namespace: 'production',
          }),
          ready: Cel.expr<boolean>`true`,
        })
      );

      const deploymentRef = (composition as any).deployment;
      
      expect(deploymentRef.metadata.namespace).toBe('production');
      expect((deploymentRef as any).__externalRef).toBe(true);
    });
  });
});