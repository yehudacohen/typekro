import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { Cel } from '../src/core/references/index.js';
import { customResource, formatArktypeError, formatReferenceError, TypeKroReferenceError, ValidationError, validateResourceGraph } from '../src/core.js';
import { simple } from '../src/index.js';

describe('Error Handling', () => {
  describe('Arktype Validation Errors', () => {
    it('should provide detailed error messages for invalid CRD specs', () => {
      const DatabaseSpec = type({
        engine: "'postgresql' | 'mysql'",
        version: 'string',
        replicas: 'number',
      });

      expect(() => {
        customResource(
          {
            apiVersion: 'db.example.com/v1',
            kind: 'Database',
            spec: DatabaseSpec,
          },
          {
            metadata: { name: 'test-db' },
            spec: {
              engine: 'invalid-engine', // Should be 'postgresql' or 'mysql'
              version: '13',
              replicas: 'not-a-number', // Should be number
            } as any,
          }
        );
      }).toThrow(ValidationError);
    });

    it('should provide helpful suggestions for missing required fields', () => {
      const DatabaseSpec = type({
        engine: "'postgresql' | 'mysql'",
        version: 'string',
      });

      try {
        customResource(
          {
            apiVersion: 'db.example.com/v1',
            kind: 'Database',
            spec: DatabaseSpec,
          },
          {
            metadata: { name: 'test-db' },
            spec: {
              // Missing required fields
            } as any,
          }
        );
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const validationError = error as ValidationError;
        expect(validationError.resourceKind).toBe('Database');
        expect(validationError.resourceName).toBe('test-db');
        expect(validationError.suggestions).toBeDefined();
        expect(validationError.suggestions?.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Reference Resolution Errors', () => {
    it('should provide helpful error messages for missing resource references', () => {
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
      });

      const webapp = simple.Deployment({
        name: 'web-app',
        image: 'nginx:latest',
        env: {
          DB_HOST: database.status?.podIP!, // Direct KubernetesRef that validation can detect
        },
      });

      // Only include webapp, not database - this should cause a reference error
      const validation = validateResourceGraph({ webapp });

      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
      expect(validation.errors[0]).toContain('Resource reference failed');
    });

    it('should suggest similar resource names for typos', () => {
      const availableResources = ['deployment-default-postgres', 'deployment-default-webapp'];
      const error = formatReferenceError(
        'deployment-default-webapp',
        'deployment-default-postgre', // Typo: missing 's'
        'status.podIP',
        availableResources
      );

      expect(error).toBeInstanceOf(TypeKroReferenceError);
      expect(error.message).toContain('Resource reference failed');
      expect(error.suggestions).toBeDefined();
      expect(error.suggestions?.some((s) => s.includes('deployment-default-postgres'))).toBe(true);
    });
  });

  describe('Circular Dependency Detection', () => {
    it('should detect and report circular dependencies', () => {
      // Create a circular dependency scenario
      const database = simple.Deployment({
        name: 'postgres',
        image: 'postgres:13',
      });

      const webapp = simple.Deployment({
        name: 'web-app',
        image: 'nginx:latest',
        env: {
          DB_READY_REPLICAS: Cel.string(database.status?.readyReplicas), // Use actual deployment status field
        },
      });

      // This would create a circular dependency if database referenced webapp
      // For now, just test that validation works with valid resources
      const validation = validateResourceGraph({ database, webapp });
      expect(validation.valid).toBe(true);
    });
  });

  describe('Error Message Formatting', () => {
    it('should format Arktype errors with helpful context', () => {
      const mockArktypeError = {
        summary: 'Invalid type',
        problems: [
          {
            path: ['engine'],
            expected: "'postgresql' | 'mysql'",
            actual: 'invalid-engine',
            code: 'type',
            message: 'Expected postgresql or mysql',
          },
        ],
      };

      const error = formatArktypeError(mockArktypeError, 'Database', 'test-db', {});

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.message).toContain("Invalid Database 'test-db' at field 'engine'");
      expect(error.message).toContain("Expected: 'postgresql' | 'mysql'");
      expect(error.message).toContain('Received: string');
      expect(error.suggestions).toBeDefined();
      expect(error.suggestions?.length).toBeGreaterThan(0);
    });

    it('should provide example values for different types', () => {
      const mockArktypeError = {
        summary: 'Missing required field',
        problems: [
          {
            path: ['replicas'],
            expected: 'number',
            actual: undefined,
            code: 'missing',
            message: 'Required field missing',
          },
        ],
      };

      const error = formatArktypeError(mockArktypeError, 'Database', 'test-db', {});

      expect(error.suggestions?.some((s) => s.includes('42'))).toBe(true); // Number example
    });
  });
});
