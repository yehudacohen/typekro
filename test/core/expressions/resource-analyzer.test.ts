/**
 * Tests for Resource Builder Integration
 */

import { describe, it, expect } from 'bun:test';
import { 
  ResourceAnalyzer, 
  DependencyTracker, 
  ResourceTypeValidator,
  analyzeResourceConfig,
  type ResourceAnalysisContext,
  type DependencyTrackingOptions
} from '../../../src/core/expressions/resource-analyzer.js';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import type { KubernetesRef } from '../../../src/core/types/common.js';

describe('ResourceAnalyzer', () => {
  it('should create a ResourceAnalyzer instance', () => {
    const analyzer = new ResourceAnalyzer();
    expect(analyzer).toBeDefined();
    expect(analyzer.getDependencyGraph).toBeDefined();
    expect(analyzer.getTypeValidator).toBeDefined();
  });

  it('should analyze resource config with no KubernetesRef objects', () => {
    const analyzer = new ResourceAnalyzer();
    const config = {
      name: 'test-app',
      image: 'nginx:latest',
      replicas: 3
    };

    const context: ResourceAnalysisContext = {
      type: 'resource',
      resourceId: 'test-deployment',
      resourceConfig: config,
      availableReferences: {},
      factoryType: 'kro'
    };

    const result = analyzer.analyzeResourceConfig('test-deployment', config, context);
    
    expect(result).toBeDefined();
    expect(result.requiresConversion).toBe(false);
    expect(result.dependencies).toHaveLength(0);
    expect(result.convertedFields).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should analyze resource config with KubernetesRef objects', () => {
    const analyzer = new ResourceAnalyzer();
    
    // Create a mock KubernetesRef
    const mockRef: KubernetesRef<string> = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: 'database',
      fieldPath: 'status.podIP',
      _type: 'string'
    };

    const config = {
      name: 'test-app',
      env: {
        DATABASE_HOST: mockRef
      }
    };

    const context: ResourceAnalysisContext = {
      type: 'resource',
      resourceId: 'test-deployment',
      resourceConfig: config,
      availableReferences: {},
      factoryType: 'kro'
    };

    const result = analyzer.analyzeResourceConfig('test-deployment', config, context);
    
    expect(result).toBeDefined();
    expect(result.requiresConversion).toBe(true);
    expect(result.dependencies.length).toBeGreaterThan(0);
    expect(result.dependencies.some(dep => dep.resourceId === 'database')).toBe(true);
    expect(result.dependencies.some(dep => dep.fieldPath === 'status.podIP')).toBe(true);
    expect(result.convertedFields.length).toBeGreaterThan(0);
  });
});

describe('DependencyTracker', () => {
  it('should create a DependencyTracker instance', () => {
    const tracker = new DependencyTracker();
    expect(tracker).toBeDefined();
    expect(tracker.getDependencyGraph).toBeDefined();
    expect(tracker.trackDependencies).toBeDefined();
  });

  it('should track dependencies', () => {
    const tracker = new DependencyTracker();
    
    const mockRef: KubernetesRef<string> = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: 'database',
      fieldPath: 'status.podIP',
      _type: 'string'
    };

    const options: DependencyTrackingOptions = {
      trackResourceDependencies: true,
      detectCircularDependencies: true
    };

    const result = tracker.trackDependencies(
      'test-deployment',
      [mockRef],
      ['env.DATABASE_HOST'],
      options
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.reference.resourceId).toBe('database');
    expect(result[0]?.fieldPath).toBe('env.DATABASE_HOST');
    expect(result[0]?.dependencyType).toBe('resource');
  });

  it('should detect circular dependencies', () => {
    const tracker = new DependencyTracker();
    
    // Create a circular dependency scenario
    const ref1: KubernetesRef<string> = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: 'service-b',
      fieldPath: 'status.ready',
      _type: 'boolean'
    };

    const ref2: KubernetesRef<string> = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: 'service-a',
      fieldPath: 'status.ready',
      _type: 'boolean'
    };

    // Track dependencies for service-a -> service-b
    tracker.trackDependencies(
      'service-a',
      [ref1],
      ['spec.enabled'],
      { detectCircularDependencies: true }
    );

    // Track dependencies for service-b -> service-a (creates cycle)
    tracker.trackDependencies(
      'service-b',
      [ref2],
      ['spec.enabled'],
      { detectCircularDependencies: true }
    );

    const analysis = tracker.detectCircularDependencyChains();
    expect(analysis.hasCircularDependencies).toBe(true);
    expect(analysis.circularChains.length).toBeGreaterThan(0);
  });
});

describe('ResourceTypeValidator', () => {
  it('should create a ResourceTypeValidator instance', () => {
    const validator = new ResourceTypeValidator();
    expect(validator).toBeDefined();
    expect(validator.validateKubernetesRef).toBeDefined();
  });

  it('should validate KubernetesRef types', () => {
    const validator = new ResourceTypeValidator();
    
    const mockRef: KubernetesRef<string> = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: 'database',
      fieldPath: 'status.podIP',
      _type: 'string'
    };

    const result = validator.validateKubernetesRef(mockRef, {
      strictTypeChecking: true
    });

    expect(result).toBeDefined();
    expect(result.reference).toBe(mockRef);
    expect(result.fieldPath).toBe('database.status.podIP');
    expect(result.expectedType).toBe('string');
  });
});

describe('analyzeResourceConfig', () => {
  it('should analyze resource config using convenience function', () => {
    const config = {
      name: 'test-app',
      image: 'nginx:latest'
    };

    const result = analyzeResourceConfig('test-deployment', config, {
      type: 'resource',
      availableReferences: {},
      factoryType: 'kro'
    });

    expect(result).toBeDefined();
    expect(result.requiresConversion).toBe(false);
    expect(result.dependencies).toHaveLength(0);
  });
});