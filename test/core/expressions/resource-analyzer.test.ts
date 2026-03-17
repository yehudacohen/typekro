/**
 * Tests for Resource Builder Integration
 */

import { describe, expect, it } from 'bun:test';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import {
  analyzeResourceConfig,
  type ResourceAnalysisContext,
  ResourceAnalyzer,
} from '../../../src/core/expressions/factory/resource-analyzer.js';
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
      replicas: 3,
    };

    const context: ResourceAnalysisContext = {
      type: 'resource',
      resourceId: 'test-deployment',
      resourceConfig: config,
      availableReferences: {},
      factoryType: 'kro',
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
      _type: 'string',
    };

    const config = {
      name: 'test-app',
      env: {
        DATABASE_HOST: mockRef,
      },
    };

    const context: ResourceAnalysisContext = {
      type: 'resource',
      resourceId: 'test-deployment',
      resourceConfig: config,
      availableReferences: {},
      factoryType: 'kro',
    };

    const result = analyzer.analyzeResourceConfig('test-deployment', config, context);

    expect(result).toBeDefined();
    expect(result.requiresConversion).toBe(true);
    expect(result.dependencies.length).toBeGreaterThan(0);
    expect(result.dependencies.some((dep) => dep.resourceId === 'database')).toBe(true);
    expect(result.dependencies.some((dep) => dep.fieldPath === 'status.podIP')).toBe(true);
    expect(result.convertedFields.length).toBeGreaterThan(0);
  });
});

describe('analyzeResourceConfig', () => {
  it('should analyze resource config using convenience function', () => {
    const config = {
      name: 'test-app',
      image: 'nginx:latest',
    };

    const result = analyzeResourceConfig('test-deployment', config, {
      type: 'resource',
      availableReferences: {},
      factoryType: 'kro',
    });

    expect(result).toBeDefined();
    expect(result.requiresConversion).toBe(false);
    expect(result.dependencies).toHaveLength(0);
  });
});
