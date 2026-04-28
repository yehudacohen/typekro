/**
 * Type definitions for the Magic Proxy Analyzer
 *
 * These interfaces extend the core analysis types with proxy-specific
 * information for JavaScript to CEL expression conversion.
 */

import type { MagicProxy } from '../../types/references.js';
import type { SchemaProxy } from '../../types/serialization.js';
import type { AnalysisContext, CelConversionResult } from '../analysis/analyzer.js';

/**
 * Magic proxy analysis context with additional proxy-specific information
 */
export interface MagicProxyAnalysisContext extends AnalysisContext {
  /** Schema proxy instance for schema field references */
  schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>>;

  /** Available resource proxies */
  resourceProxies?: Record<string, MagicProxy<unknown>>;

  /** Whether to perform deep proxy analysis */
  deepAnalysis?: boolean;

  /** Maximum depth for recursive analysis */
  maxDepth?: number;
}

/**
 * Result of magic proxy analysis with proxy-specific information
 */
export interface MagicProxyAnalysisResult extends CelConversionResult {
  /** Detected proxy types */
  proxyTypes: ('schema' | 'resource')[];

  /** Schema field references found */
  schemaReferences: string[];

  /** Resource field references found */
  resourceReferences: string[];

  /** Depth of analysis performed */
  analysisDepth: number;
}
