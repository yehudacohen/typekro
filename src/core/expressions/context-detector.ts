/**
 * Context Detection for JavaScript to CEL Expression Conversion
 * 
 * This module provides functionality to detect the context in which JavaScript expressions
 * containing KubernetesRef objects are being used, enabling context-appropriate CEL generation.
 */

import type { KubernetesRef } from '../types/common.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { SchemaProxy } from '../types/serialization.js';
import { isKubernetesRef, containsKubernetesRefs } from '../../utils/type-guards.js';

/**
 * Different contexts where expressions can be used
 */
export type ExpressionContext = 
  | 'status-builder'      // Status builders in toResourceGraph
  | 'resource-builder'    // Resource configuration in factory functions
  | 'conditional'         // Conditional resource inclusion (includeWhen)
  | 'readiness'          // Resource readiness checks (readyWhen)
  | 'field-hydration'    // Field hydration expressions
  | 'template-literal'   // Template literal interpolations
  | 'unknown';           // Context cannot be determined

/**
 * Context detection result
 */
export interface ContextDetectionResult {
  /** Detected context type */
  context: ExpressionContext;
  
  /** Confidence level (0-1) in the detection */
  confidence: number;
  
  /** Reasons for the context detection */
  reasons: string[];
  
  /** Whether KubernetesRef objects were found in the expression */
  hasKubernetesRefs: boolean;
  
  /** Detected KubernetesRef objects */
  kubernetesRefs: KubernetesRef<any>[];
  
  /** Suggested CEL generation strategy */
  celStrategy: CelGenerationStrategy;
  
  /** Context-specific metadata */
  metadata: ContextMetadata;
}

/**
 * CEL generation strategy based on context
 */
export type CelGenerationStrategy = 
  | 'status-expression'     // Generate status field CEL expressions
  | 'resource-reference'    // Generate resource field references
  | 'conditional-check'     // Generate boolean condition expressions
  | 'readiness-check'       // Generate readiness validation expressions
  | 'template-interpolation' // Generate template string expressions
  | 'direct-evaluation';    // Evaluate directly without CEL conversion

/**
 * Context-specific metadata
 */
export interface ContextMetadata {
  /** Available resources in this context */
  availableResources?: string[];
  
  /** Schema fields available in this context */
  availableSchemaFields?: string[];
  
  /** Expected return type for this context */
  expectedReturnType?: string;
  
  /** Whether this context supports async operations */
  supportsAsync?: boolean;
  
  /** Factory type being used */
  factoryType?: 'direct' | 'kro';
  
  /** Additional context-specific properties */
  [key: string]: any;
}

/**
 * Context detection configuration
 */
export interface ContextDetectionConfig {
  /** Available resources for context analysis */
  availableResources?: Record<string, Enhanced<any, any>>;
  
  /** Schema proxy for schema field analysis */
  schemaProxy?: SchemaProxy<any, any>;
  
  /** Factory type being used */
  factoryType?: 'direct' | 'kro';
  
  /** Function name or identifier that provides context hints */
  functionContext?: string;
  
  /** Call stack information for context detection */
  callStack?: string[];
  
  /** Whether to perform deep analysis */
  deepAnalysis?: boolean;
}

/**
 * Context detector for JavaScript expressions containing KubernetesRef objects
 */
export class ExpressionContextDetector {
  
  /**
   * Detect the context of a JavaScript expression
   */
  detectContext(
    expression: any,
    config: ContextDetectionConfig = {}
  ): ContextDetectionResult {
    const kubernetesRefs = this.extractKubernetesRefs(expression);
    const hasKubernetesRefs = kubernetesRefs.length > 0;
    
    // Start with unknown context
    let context: ExpressionContext = 'unknown';
    let confidence = 0;
    const reasons: string[] = [];
    
    // Analyze the expression structure and content
    const structureAnalysis = this.analyzeExpressionStructure(expression);
    const contentAnalysis = this.analyzeExpressionContent(expression, kubernetesRefs);
    const contextualAnalysis = this.analyzeContextualHints(config);
    
    // Combine analyses to determine context
    const contextResult = this.combineAnalyses(
      structureAnalysis,
      contentAnalysis,
      contextualAnalysis
    );
    
    context = contextResult.context;
    confidence = contextResult.confidence;
    reasons.push(...contextResult.reasons);
    
    // Determine CEL generation strategy based on context
    const celStrategy = this.determineCelStrategy(context, config.factoryType);
    
    // Build context metadata
    const metadata = this.buildContextMetadata(context, config, kubernetesRefs);
    
    return {
      context,
      confidence,
      reasons,
      hasKubernetesRefs,
      kubernetesRefs,
      celStrategy,
      metadata
    };
  }
  
  /**
   * Detect context from function call patterns
   */
  detectContextFromFunction(
    functionName: string,
    args: any[],
    config: ContextDetectionConfig = {}
  ): ContextDetectionResult {
    // Analyze function name patterns
    if (functionName === 'toResourceGraph' || functionName.includes('statusBuilder')) {
      return this.detectStatusBuilderContext(args, config);
    }
    
    if (functionName.startsWith('simple') || functionName.includes('deployment') || 
        functionName.includes('service') || functionName.includes('configMap')) {
      return this.detectResourceBuilderContext(args, config);
    }
    
    if (functionName.includes('includeWhen') || functionName.includes('conditional')) {
      return this.detectConditionalContext(args, config);
    }
    
    if (functionName.includes('readyWhen') || functionName.includes('readiness')) {
      return this.detectReadinessContext(args, config);
    }
    
    // Default to unknown context with low confidence
    return {
      context: 'unknown',
      confidence: 0.1,
      reasons: [`Unknown function pattern: ${functionName}`],
      hasKubernetesRefs: false,
      kubernetesRefs: [],
      celStrategy: 'direct-evaluation',
      metadata: {}
    };
  }
  
  /**
   * Extract KubernetesRef objects from an expression
   */
  private extractKubernetesRefs(expression: any): KubernetesRef<any>[] {
    const refs: KubernetesRef<any>[] = [];
    
    if (isKubernetesRef(expression)) {
      refs.push(expression);
    } else if (typeof expression === 'object' && expression !== null) {
      this.recursivelyExtractRefs(expression, refs);
    }
    
    return refs;
  }
  
  /**
   * Recursively extract KubernetesRef objects from complex structures
   */
  private recursivelyExtractRefs(value: any, refs: KubernetesRef<any>[]): void {
    if (isKubernetesRef(value)) {
      refs.push(value);
      return;
    }
    
    if (Array.isArray(value)) {
      for (const item of value) {
        this.recursivelyExtractRefs(item, refs);
      }
    } else if (value && typeof value === 'object') {
      for (const prop of Object.values(value)) {
        this.recursivelyExtractRefs(prop, refs);
      }
    }
  }
  
  /**
   * Analyze the structure of the expression
   */
  private analyzeExpressionStructure(expression: any): StructureAnalysis {
    const analysis: StructureAnalysis = {
      type: typeof expression,
      isFunction: typeof expression === 'function',
      isString: typeof expression === 'string',
      isObject: expression && typeof expression === 'object',
      isArray: Array.isArray(expression),
      hasTemplateLiteral: false,
      hasConditional: false,
      hasBooleanLogic: false,
      hasComparison: false,
      complexity: 0
    };
    
    if (typeof expression === 'string') {
      // Analyze string content for patterns
      analysis.hasTemplateLiteral = expression.includes('${') && expression.includes('}');
      analysis.hasConditional = expression.includes('?') && expression.includes(':');
      analysis.hasBooleanLogic = /&&|\|\|/.test(expression);
      analysis.hasComparison = /[><=!]=?/.test(expression);
      
      // Calculate complexity based on operators and structure
      analysis.complexity = this.calculateStringComplexity(expression);
    } else if (typeof expression === 'function') {
      // Analyze function structure
      const functionString = expression.toString();
      analysis.hasConditional = functionString.includes('?') && functionString.includes(':');
      analysis.hasBooleanLogic = /&&|\|\|/.test(functionString);
      analysis.hasComparison = /[><=!]=?/.test(functionString);
      analysis.complexity = this.calculateFunctionComplexity(functionString);
    } else if (expression && typeof expression === 'object') {
      // Analyze object structure
      analysis.complexity = this.calculateObjectComplexity(expression);
    }
    
    return analysis;
  }
  
  /**
   * Analyze the content of the expression for context clues
   */
  private analyzeExpressionContent(
    expression: any,
    kubernetesRefs: KubernetesRef<any>[]
  ): ContentAnalysis {
    const analysis: ContentAnalysis = {
      referencesSchema: false,
      referencesResources: false,
      referencesStatus: false,
      referencesSpec: false,
      hasStatusPatterns: false,
      hasResourcePatterns: false,
      hasConditionalPatterns: false,
      hasReadinessPatterns: false,
      resourceTypes: [],
      fieldPaths: []
    };
    
    // Analyze KubernetesRef objects for patterns
    for (const ref of kubernetesRefs) {
      if (ref.resourceId === '__schema__') {
        analysis.referencesSchema = true;
        if (ref.fieldPath.startsWith('spec.')) {
          analysis.referencesSpec = true;
        } else if (ref.fieldPath.startsWith('status.')) {
          analysis.referencesStatus = true;
        }
      } else {
        analysis.referencesResources = true;
        analysis.resourceTypes.push(ref.resourceId);
        
        if (ref.fieldPath.includes('status')) {
          analysis.referencesStatus = true;
          analysis.hasStatusPatterns = true;
        }
        
        if (ref.fieldPath.includes('spec')) {
          analysis.referencesSpec = true;
          analysis.hasResourcePatterns = true;
        }
      }
      
      analysis.fieldPaths.push(`${ref.resourceId}.${ref.fieldPath}`);
    }
    
    // Analyze expression content for patterns
    const expressionString = String(expression);
    
    // Status builder patterns
    if (/ready|available|running|healthy|complete/.test(expressionString.toLowerCase())) {
      analysis.hasStatusPatterns = true;
    }
    
    // Resource builder patterns
    if (/name|image|port|env|volume|mount/.test(expressionString.toLowerCase())) {
      analysis.hasResourcePatterns = true;
    }
    
    // Conditional patterns
    if (/include|exclude|when|if|condition/.test(expressionString.toLowerCase())) {
      analysis.hasConditionalPatterns = true;
    }
    
    // Readiness patterns
    if (/ready|available|healthy|up|running/.test(expressionString.toLowerCase())) {
      analysis.hasReadinessPatterns = true;
    }
    
    return analysis;
  }
  
  /**
   * Analyze contextual hints from configuration
   */
  private analyzeContextualHints(config: ContextDetectionConfig): ContextualAnalysis {
    const analysis: ContextualAnalysis = {
      hasAvailableResources: !!config.availableResources,
      hasSchemaProxy: !!config.schemaProxy,
      callStackHints: [],
      contextStrength: 0
    };
    
    if (config.functionContext) {
      analysis.functionContext = config.functionContext;
    }
    if (config.factoryType) {
      analysis.factoryType = config.factoryType;
    }
    
    // Analyze function context
    if (config.functionContext) {
      if (config.functionContext.includes('status') || config.functionContext.includes('Status')) {
        analysis.callStackHints.push('status-context');
        analysis.contextStrength += 0.3;
      }
      
      if (config.functionContext.includes('resource') || config.functionContext.includes('Resource')) {
        analysis.callStackHints.push('resource-context');
        analysis.contextStrength += 0.3;
      }
      
      if (config.functionContext.includes('condition') || config.functionContext.includes('when')) {
        analysis.callStackHints.push('conditional-context');
        analysis.contextStrength += 0.3;
      }
    }
    
    // Analyze call stack
    if (config.callStack) {
      for (const frame of config.callStack) {
        if (frame.includes('toResourceGraph')) {
          analysis.callStackHints.push('resource-graph-context');
          analysis.contextStrength += 0.2;
        }
        
        if (frame.includes('statusBuilder')) {
          analysis.callStackHints.push('status-builder-context');
          analysis.contextStrength += 0.4;
        }
        
        if (frame.includes('simple') && (frame.includes('deployment') || frame.includes('service'))) {
          analysis.callStackHints.push('resource-builder-context');
          analysis.contextStrength += 0.4;
        }
      }
    }
    
    return analysis;
  }
  
  /**
   * Combine all analyses to determine the final context
   */
  private combineAnalyses(
    structure: StructureAnalysis,
    content: ContentAnalysis,
    contextual: ContextualAnalysis
  ): { context: ExpressionContext; confidence: number; reasons: string[] } {
    const scores = {
      'status-builder': 0,
      'resource-builder': 0,
      'conditional': 0,
      'readiness': 0,
      'field-hydration': 0,
      'template-literal': 0,
      'unknown': 0.1
    };
    
    const reasons: string[] = [];
    
    // Structure-based scoring
    if (structure.hasTemplateLiteral) {
      scores['template-literal'] += 0.4;
      reasons.push('Contains template literal syntax');
    }
    
    if (structure.hasConditional) {
      scores.conditional += 0.3;
      scores.readiness += 0.2;
      reasons.push('Contains conditional logic');
    }
    
    if (structure.hasBooleanLogic || structure.hasComparison) {
      scores['status-builder'] += 0.2;
      scores.conditional += 0.3;
      scores.readiness += 0.3;
      reasons.push('Contains boolean or comparison operators');
    }
    
    // Content-based scoring
    if (content.referencesStatus) {
      scores['status-builder'] += 0.4;
      scores.readiness += 0.3;
      reasons.push('References status fields');
    }
    
    if (content.referencesSpec && content.referencesResources) {
      scores['resource-builder'] += 0.4;
      reasons.push('References resource spec fields');
    }
    
    if (content.referencesSchema) {
      scores['resource-builder'] += 0.3;
      reasons.push('References schema fields');
    }
    
    if (content.hasStatusPatterns) {
      scores['status-builder'] += 0.3;
      scores.readiness += 0.2;
      reasons.push('Contains status-related patterns');
    }
    
    if (content.hasResourcePatterns) {
      scores['resource-builder'] += 0.3;
      reasons.push('Contains resource configuration patterns');
    }
    
    if (content.hasConditionalPatterns) {
      scores.conditional += 0.4;
      reasons.push('Contains conditional patterns');
    }
    
    if (content.hasReadinessPatterns) {
      scores.readiness += 0.4;
      reasons.push('Contains readiness patterns');
    }
    
    // Contextual hints scoring
    for (const hint of contextual.callStackHints) {
      switch (hint) {
        case 'status-context':
        case 'status-builder-context':
          scores['status-builder'] += 0.4;
          reasons.push('Function context suggests status builder');
          break;
        case 'resource-context':
        case 'resource-builder-context':
          scores['resource-builder'] += 0.4;
          reasons.push('Function context suggests resource builder');
          break;
        case 'conditional-context':
          scores.conditional += 0.4;
          reasons.push('Function context suggests conditional');
          break;
      }
    }
    
    // Add direct function context scoring
    if (contextual.functionContext) {
      if (contextual.functionContext.includes('status') || contextual.functionContext.includes('Status')) {
        scores['status-builder'] += 0.5;
        reasons.push('Function name suggests status builder');
      }
      
      if (contextual.functionContext.includes('simple') || contextual.functionContext.includes('deployment') || contextual.functionContext.includes('service')) {
        scores['resource-builder'] += 0.5;
        reasons.push('Function name suggests resource builder');
      }
    }
    
    // Find the highest scoring context
    let bestContext: ExpressionContext = 'unknown';
    let bestScore = 0;
    
    for (const [context, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestContext = context as ExpressionContext;
      }
    }
    
    // Normalize confidence to 0-1 range
    const confidence = Math.min(bestScore, 1.0);
    
    return { context: bestContext, confidence, reasons };
  }
  
  /**
   * Determine CEL generation strategy based on context
   */
  private determineCelStrategy(
    context: ExpressionContext,
    factoryType?: 'direct' | 'kro'
  ): CelGenerationStrategy {
    switch (context) {
      case 'status-builder':
        return 'status-expression';
      case 'resource-builder':
        return 'resource-reference';
      case 'conditional':
        return 'conditional-check';
      case 'readiness':
        return 'readiness-check';
      case 'template-literal':
        return 'template-interpolation';
      case 'field-hydration':
        return factoryType === 'direct' ? 'direct-evaluation' : 'status-expression';
      default:
        return 'direct-evaluation';
    }
  }
  
  /**
   * Build context-specific metadata
   */
  private buildContextMetadata(
    context: ExpressionContext,
    config: ContextDetectionConfig,
    kubernetesRefs: KubernetesRef<any>[]
  ): ContextMetadata {
    const metadata: ContextMetadata = {
      ...(config.factoryType ? { factoryType: config.factoryType } : {})
    };
    
    if (config.availableResources) {
      metadata.availableResources = Object.keys(config.availableResources);
    }
    
    if (config.schemaProxy) {
      // Extract available schema fields (this would need schema introspection)
      metadata.availableSchemaFields = ['spec.*', 'status.*'];
    }
    
    // Set expected return type based on context
    switch (context) {
      case 'status-builder':
        metadata.expectedReturnType = 'any';
        metadata.supportsAsync = false;
        break;
      case 'resource-builder':
        metadata.expectedReturnType = 'string | number | boolean | object';
        metadata.supportsAsync = false;
        break;
      case 'conditional':
      case 'readiness':
        metadata.expectedReturnType = 'boolean';
        metadata.supportsAsync = false;
        break;
      case 'template-literal':
        metadata.expectedReturnType = 'string';
        metadata.supportsAsync = false;
        break;
    }
    
    // Add KubernetesRef-specific metadata
    if (kubernetesRefs.length > 0) {
      metadata.referencedResources = [...new Set(kubernetesRefs.map(ref => ref.resourceId))];
      metadata.referencedFields = kubernetesRefs.map(ref => `${ref.resourceId}.${ref.fieldPath}`);
    }
    
    return metadata;
  }
  
  /**
   * Detect status builder context
   */
  private detectStatusBuilderContext(
    args: any[],
    config: ContextDetectionConfig
  ): ContextDetectionResult {
    return {
      context: 'status-builder',
      confidence: 0.9,
      reasons: ['Function is a status builder'],
      hasKubernetesRefs: args.some(arg => containsKubernetesRefs(arg)),
      kubernetesRefs: this.extractKubernetesRefs(args),
      celStrategy: 'status-expression',
      metadata: {
        expectedReturnType: 'object',
        supportsAsync: false,
        ...(config.factoryType ? { factoryType: config.factoryType } : {})
      }
    };
  }
  
  /**
   * Detect resource builder context
   */
  private detectResourceBuilderContext(
    args: any[],
    config: ContextDetectionConfig
  ): ContextDetectionResult {
    return {
      context: 'resource-builder',
      confidence: 0.9,
      reasons: ['Function is a resource builder'],
      hasKubernetesRefs: args.some(arg => containsKubernetesRefs(arg)),
      kubernetesRefs: this.extractKubernetesRefs(args),
      celStrategy: 'resource-reference',
      metadata: {
        expectedReturnType: 'Enhanced<any, any>',
        supportsAsync: false,
        ...(config.factoryType ? { factoryType: config.factoryType } : {})
      }
    };
  }
  
  /**
   * Detect conditional context
   */
  private detectConditionalContext(
    args: any[],
    config: ContextDetectionConfig
  ): ContextDetectionResult {
    return {
      context: 'conditional',
      confidence: 0.9,
      reasons: ['Function is a conditional expression'],
      hasKubernetesRefs: args.some(arg => containsKubernetesRefs(arg)),
      kubernetesRefs: this.extractKubernetesRefs(args),
      celStrategy: 'conditional-check',
      metadata: {
        expectedReturnType: 'boolean',
        supportsAsync: false,
        ...(config.factoryType ? { factoryType: config.factoryType } : {})
      }
    };
  }
  
  /**
   * Detect readiness context
   */
  private detectReadinessContext(
    args: any[],
    config: ContextDetectionConfig
  ): ContextDetectionResult {
    return {
      context: 'readiness',
      confidence: 0.9,
      reasons: ['Function is a readiness check'],
      hasKubernetesRefs: args.some(arg => containsKubernetesRefs(arg)),
      kubernetesRefs: this.extractKubernetesRefs(args),
      celStrategy: 'readiness-check',
      metadata: {
        expectedReturnType: 'boolean',
        supportsAsync: false,
        ...(config.factoryType ? { factoryType: config.factoryType } : {})
      }
    };
  }
  
  /**
   * Calculate complexity of a string expression
   */
  private calculateStringComplexity(expression: string): number {
    let complexity = 0;
    
    // Count operators
    complexity += (expression.match(/[+\-*/]/g) || []).length * 0.1;
    complexity += (expression.match(/[><=!]=?/g) || []).length * 0.2;
    complexity += (expression.match(/&&|\|\|/g) || []).length * 0.3;
    complexity += (expression.match(/\?.*:/g) || []).length * 0.4;
    
    // Count function calls
    complexity += (expression.match(/\w+\(/g) || []).length * 0.2;
    
    // Count property access
    complexity += (expression.match(/\.\w+/g) || []).length * 0.1;
    
    return Math.min(complexity, 1.0);
  }
  
  /**
   * Calculate complexity of a function
   */
  private calculateFunctionComplexity(functionString: string): number {
    // Similar to string complexity but with additional function-specific patterns
    let complexity = this.calculateStringComplexity(functionString);
    
    // Add function-specific complexity
    complexity += (functionString.match(/return/g) || []).length * 0.1;
    complexity += (functionString.match(/if|else|for|while/g) || []).length * 0.3;
    
    return Math.min(complexity, 1.0);
  }
  
  /**
   * Calculate complexity of an object
   */
  private calculateObjectComplexity(obj: any): number {
    let complexity = 0;
    
    try {
      const keys = Object.keys(obj);
      complexity += keys.length * 0.1;
      
      // Add complexity for nested objects
      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') {
          complexity += 0.2;
        }
      }
    } catch {
      complexity = 0.5; // Default complexity for non-enumerable objects
    }
    
    return Math.min(complexity, 1.0);
  }
}

/**
 * Structure analysis result
 */
interface StructureAnalysis {
  type: string;
  isFunction: boolean;
  isString: boolean;
  isObject: boolean;
  isArray: boolean;
  hasTemplateLiteral: boolean;
  hasConditional: boolean;
  hasBooleanLogic: boolean;
  hasComparison: boolean;
  complexity: number;
}

/**
 * Content analysis result
 */
interface ContentAnalysis {
  referencesSchema: boolean;
  referencesResources: boolean;
  referencesStatus: boolean;
  referencesSpec: boolean;
  hasStatusPatterns: boolean;
  hasResourcePatterns: boolean;
  hasConditionalPatterns: boolean;
  hasReadinessPatterns: boolean;
  resourceTypes: string[];
  fieldPaths: string[];
}

/**
 * Contextual analysis result
 */
interface ContextualAnalysis {
  functionContext?: string;
  factoryType?: 'direct' | 'kro';
  hasAvailableResources: boolean;
  hasSchemaProxy: boolean;
  callStackHints: string[];
  contextStrength: number;
}

/**
 * Default context detector instance
 */
export const contextDetector = new ExpressionContextDetector();