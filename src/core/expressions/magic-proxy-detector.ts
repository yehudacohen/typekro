/**
 * Magic Proxy Detection for Factory Integration
 * 
 * This module provides enhanced detection capabilities for KubernetesRef objects
 * that originate from TypeKro's magic proxy system (SchemaProxy and ResourcesProxy).
 */

import { getComponentLogger } from '../logging/index.js';
import type { KubernetesRef, } from '../types/index.js';
import { isKubernetesRef } from '../../utils/type-guards.js';

const logger = getComponentLogger('magic-proxy-detector');

/**
 * Information about a detected KubernetesRef from magic proxy
 */
export interface MagicProxyRefInfo {
  /** The KubernetesRef object */
  ref: KubernetesRef<any>;
  /** Path where the reference was found */
  path: string;
  /** Source of the reference (schema or resource) */
  source: 'schema' | 'resource' | 'unknown';
  /** Resource ID if from resource proxy */
  resourceId?: string;
  /** Field path within the resource/schema */
  fieldPath: string;
  /** Whether this is a nested reference */
  isNested: boolean;
  /** Depth of nesting */
  nestingDepth: number;
}

/**
 * Result of magic proxy detection
 */
export interface MagicProxyDetectionResult {
  /** Whether any KubernetesRef objects were found */
  hasKubernetesRefs: boolean;
  /** List of detected references */
  references: MagicProxyRefInfo[];
  /** Statistics about the detection */
  stats: {
    totalReferences: number;
    schemaReferences: number;
    resourceReferences: number;
    nestedReferences: number;
    maxNestingDepth: number;
  };
  /** Performance metrics */
  metrics: {
    detectionTimeMs: number;
    objectsScanned: number;
    propertiesScanned: number;
  };
}

/**
 * Configuration for magic proxy detection
 */
export interface MagicProxyDetectionConfig {
  /** Maximum depth to scan for nested references */
  maxDepth?: number;
  /** Whether to include detailed path information */
  includeDetailedPaths?: boolean;
  /** Whether to analyze reference sources */
  analyzeReferenceSources?: boolean;
  /** Whether to track performance metrics */
  trackMetrics?: boolean;
}

/**
 * Magic Proxy Detector
 * 
 * Provides sophisticated detection of KubernetesRef objects that originate
 * from TypeKro's magic proxy system, with detailed analysis of their sources
 * and usage patterns.
 */
export class MagicProxyDetector {
  /**
   * Detect KubernetesRef objects in a value with detailed analysis
   * 
   * @param value - Value to analyze
   * @param config - Detection configuration
   * @param basePath - Base path for reference tracking
   * @returns Detection result
   */
  detectKubernetesRefs(
    value: any,
    config: MagicProxyDetectionConfig = {},
    basePath = ''
  ): MagicProxyDetectionResult {
    const startTime = performance.now();
    
    const result: MagicProxyDetectionResult = {
      hasKubernetesRefs: false,
      references: [],
      stats: {
        totalReferences: 0,
        schemaReferences: 0,
        resourceReferences: 0,
        nestedReferences: 0,
        maxNestingDepth: 0
      },
      metrics: {
        detectionTimeMs: 0,
        objectsScanned: 0,
        propertiesScanned: 0
      }
    };

    this.scanValue(value, result, config, basePath, 0);

    result.hasKubernetesRefs = result.references.length > 0;
    result.stats.totalReferences = result.references.length;
    result.stats.schemaReferences = result.references.filter(r => r.source === 'schema').length;
    result.stats.resourceReferences = result.references.filter(r => r.source === 'resource').length;
    result.stats.nestedReferences = result.references.filter(r => r.isNested).length;
    result.stats.maxNestingDepth = Math.max(...result.references.map(r => r.nestingDepth), 0);
    result.metrics.detectionTimeMs = performance.now() - startTime;

    if (config.trackMetrics !== false) {
      logger.debug('Magic proxy detection completed', {
        hasKubernetesRefs: result.hasKubernetesRefs,
        totalReferences: result.stats.totalReferences,
        detectionTimeMs: result.metrics.detectionTimeMs
      });
    }

    return result;
  }

  /**
   * Check if a value contains any KubernetesRef objects (fast check)
   * 
   * @param value - Value to check
   * @param maxDepth - Maximum depth to check
   * @returns Whether KubernetesRef objects were found
   */
  containsKubernetesRefs(value: any, maxDepth = 10): boolean {
    return this.fastScanForRefs(value, 0, maxDepth);
  }

  /**
   * Extract all KubernetesRef objects from a value
   * 
   * @param value - Value to extract from
   * @param maxDepth - Maximum depth to extract
   * @returns Array of KubernetesRef objects
   */
  extractKubernetesRefs(value: any, maxDepth = 10): KubernetesRef<any>[] {
    const refs: KubernetesRef<any>[] = [];
    this.extractRefs(value, refs, 0, maxDepth);
    return refs;
  }

  /**
   * Analyze the source of a KubernetesRef object
   * 
   * @param ref - KubernetesRef to analyze
   * @returns Source analysis
   */
  analyzeReferenceSource(ref: KubernetesRef<any>): {
    source: 'schema' | 'resource' | 'unknown';
    isSchemaRef: boolean;
    isResourceRef: boolean;
    resourceId?: string;
    fieldPath: string;
  } {
    const resourceId = ref.resourceId;
    const fieldPath = ref.fieldPath || '';

    // Handle malformed refs gracefully
    if (!resourceId || typeof resourceId !== 'string') {
      return {
        source: 'unknown',
        isSchemaRef: false,
        isResourceRef: false,
        fieldPath
      };
    }

    // Detect schema references (typically have __schema__ as resourceId)
    const isSchemaRef = resourceId === '__schema__' || resourceId.startsWith('schema.');
    
    // Detect resource references (have actual resource IDs)
    const isResourceRef = !isSchemaRef && !!resourceId && resourceId !== '__schema__';

    const source: 'schema' | 'resource' | 'unknown' = 
      isSchemaRef ? 'schema' : 
      isResourceRef ? 'resource' : 
      'unknown';

    const result: {
      source: 'schema' | 'resource' | 'unknown';
      isSchemaRef: boolean;
      isResourceRef: boolean;
      resourceId?: string;
      fieldPath: string;
    } = {
      source,
      isSchemaRef,
      isResourceRef,
      fieldPath
    };

    if (isResourceRef && resourceId) {
      result.resourceId = resourceId;
    }

    return result;
  }

  private scanValue(
    value: any,
    result: MagicProxyDetectionResult,
    config: MagicProxyDetectionConfig,
    currentPath: string,
    depth: number
  ): void {
    const maxDepth = config.maxDepth || 10;
    
    if (depth >= maxDepth) {
      return;
    }

    result.metrics.objectsScanned++;

    // Check if this value is a KubernetesRef
    if (isKubernetesRef(value)) {
      const sourceAnalysis = config.analyzeReferenceSources !== false 
        ? this.analyzeReferenceSource(value)
        : { source: 'unknown' as const, isSchemaRef: false, isResourceRef: false, fieldPath: value.fieldPath };

      const refInfo: MagicProxyRefInfo = {
        ref: value,
        path: currentPath,
        source: sourceAnalysis.source,
        ...(sourceAnalysis.resourceId && { resourceId: sourceAnalysis.resourceId }),
        fieldPath: sourceAnalysis.fieldPath,
        isNested: depth > 1, // Only consider nested if depth > 1 (not just at object level)
        nestingDepth: depth
      };

      result.references.push(refInfo);
      return;
    }

    // Recursively scan objects and arrays
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          result.metrics.propertiesScanned++;
          const itemPath = config.includeDetailedPaths !== false 
            ? `${currentPath}[${index}]` 
            : currentPath;
          this.scanValue(item, result, config, itemPath, depth + 1);
        });
      } else {
        for (const [key, val] of Object.entries(value)) {
          result.metrics.propertiesScanned++;
          const propPath = config.includeDetailedPaths !== false 
            ? currentPath ? `${currentPath}.${key}` : key 
            : currentPath;
          this.scanValue(val, result, config, propPath, depth + 1);
        }
      }
    }
  }

  private fastScanForRefs(value: any, depth: number, maxDepth: number): boolean {
    if (depth >= maxDepth) {
      return false;
    }

    if (isKubernetesRef(value)) {
      return true;
    }

    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        return value.some(item => this.fastScanForRefs(item, depth + 1, maxDepth));
      } else {
        return Object.values(value).some(val => this.fastScanForRefs(val, depth + 1, maxDepth));
      }
    }

    return false;
  }

  private extractRefs(value: any, refs: KubernetesRef<any>[], depth: number, maxDepth: number): void {
    if (depth >= maxDepth) {
      return;
    }

    if (isKubernetesRef(value)) {
      refs.push(value);
      return;
    }

    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach(item => this.extractRefs(item, refs, depth + 1, maxDepth));
      } else {
        Object.values(value).forEach(val => this.extractRefs(val, refs, depth + 1, maxDepth));
      }
    }
  }
}

/**
 * Global magic proxy detector instance
 */
export const magicProxyDetector = new MagicProxyDetector();

/**
 * Utility function to detect KubernetesRef objects in a value
 * 
 * @param value - Value to analyze
 * @param config - Detection configuration
 * @returns Detection result
 */
export function detectMagicProxyRefs(
  value: any,
  config?: MagicProxyDetectionConfig
): MagicProxyDetectionResult {
  return magicProxyDetector.detectKubernetesRefs(value, config);
}

/**
 * Utility function to check if a value contains KubernetesRef objects
 * 
 * @param value - Value to check
 * @param maxDepth - Maximum depth to check
 * @returns Whether KubernetesRef objects were found
 */
export function containsMagicProxyRefs(value: any, maxDepth?: number): boolean {
  return magicProxyDetector.containsKubernetesRefs(value, maxDepth);
}

/**
 * Utility function to extract all KubernetesRef objects from a value
 * 
 * @param value - Value to extract from
 * @param maxDepth - Maximum depth to extract
 * @returns Array of KubernetesRef objects
 */
export function extractMagicProxyRefs(value: any, maxDepth?: number): KubernetesRef<any>[] {
  return magicProxyDetector.extractKubernetesRefs(value, maxDepth);
}

/**
 * Utility function to analyze the source of a KubernetesRef object
 * 
 * @param ref - KubernetesRef to analyze
 * @returns Source analysis
 */
export function analyzeMagicProxyRefSource(ref: KubernetesRef<any>) {
  return magicProxyDetector.analyzeReferenceSource(ref);
}