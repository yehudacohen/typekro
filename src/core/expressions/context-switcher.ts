/**
 * Context Switching for Nested Expressions with KubernetesRef Objects
 * 
 * This module provides functionality to handle context switching when analyzing
 * nested JavaScript expressions that contain KubernetesRef objects, ensuring
 * that each part of a complex expression is converted using the appropriate context.
 */

import type { CelExpression, KubernetesRef } from '../types/common.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { SchemaProxy } from '../types/serialization.js';
import { isKubernetesRef, containsKubernetesRefs } from '../../utils/type-guards.js';
import { ConversionError } from '../errors.js';
import type {
    ExpressionContext,
    CelGenerationStrategy,
    ExpressionContextDetector
} from './context-detector.js';
import type {
    ContextAwareCelGenerator,
    CelGenerationConfig,
} from './context-aware-generator.js';
import type {
    ContextExpressionValidator,
    ContextValidationConfig,
    ContextValidationReport
} from './context-validator.js';

/**
 * Context switching configuration
 */
export interface ContextSwitchingConfig {
    /** Primary context for the expression */
    primaryContext: ExpressionContext;

    /** Available resources for context analysis */
    availableResources?: Record<string, Enhanced<any, any>>;

    /** Schema proxy for schema field analysis */
    schemaProxy?: SchemaProxy<any, any>;

    /** Factory type being used */
    factoryType?: 'direct' | 'kro';

    /** Whether to enable automatic context detection */
    autoDetectContext?: boolean;

    /** Whether to validate context switches */
    validateContextSwitches?: boolean;

    /** Maximum nesting depth to analyze */
    maxNestingDepth?: number;

    /** Whether to optimize context switches */
    optimizeContextSwitches?: boolean;

    /** Custom context detection rules */
    customContextRules?: ContextSwitchingRule[];
}

/**
 * Context switching rule
 */
export interface ContextSwitchingRule {
    /** Rule identifier */
    id: string;

    /** Rule name */
    name: string;

    /** When this rule should be applied */
    condition: (
        expression: any,
        currentContext: ExpressionContext,
        parentContext: ExpressionContext,
        depth: number
    ) => boolean;

    /** What context to switch to */
    targetContext: ExpressionContext;

    /** Priority of this rule (higher = more important) */
    priority: number;
}

/**
 * Context switch point in an expression
 */
export interface ContextSwitchPoint {
    /** Path to the expression part that needs context switching */
    path: string[];

    /** Current context */
    currentContext: ExpressionContext;

    /** Target context */
    targetContext: ExpressionContext;

    /** Reason for the context switch */
    reason: string;

    /** Expression part that triggered the switch */
    expression: any;

    /** KubernetesRef objects in this part */
    kubernetesRefs: KubernetesRef<any>[];

    /** Nesting depth */
    depth: number;
}

/**
 * Context switching result
 */
export interface ContextSwitchingResult {
    /** Original expression */
    originalExpression: any;

    /** Primary context used */
    primaryContext: ExpressionContext;

    /** Context switch points found */
    switchPoints: ContextSwitchPoint[];

    /** Generated CEL expressions by context */
    celExpressions: Map<string, CelExpression>;

    /** Final combined CEL expression */
    finalCelExpression: CelExpression;

    /** All dependencies found */
    allDependencies: KubernetesRef<any>[];

    /** Validation reports by context */
    validationReports: Map<ExpressionContext, ContextValidationReport>;

    /** Warnings generated during context switching */
    warnings: string[];

    /** Performance metrics */
    performanceMetrics?: ContextSwitchingMetrics;
}

/**
 * Performance metrics for context switching
 */
export interface ContextSwitchingMetrics {
    /** Total analysis time */
    totalTimeMs: number;

    /** Time spent on context detection */
    contextDetectionTimeMs: number;

    /** Time spent on CEL generation */
    celGenerationTimeMs: number;

    /** Time spent on validation */
    validationTimeMs: number;

    /** Number of context switches performed */
    contextSwitchCount: number;

    /** Maximum nesting depth reached */
    maxDepthReached: number;
}

/**
 * Context switcher for nested expressions
 */
export class ExpressionContextSwitcher {
    private contextDetector: ExpressionContextDetector;
    private celGenerator: ContextAwareCelGenerator;
    private validator: ContextExpressionValidator;

    constructor(
        contextDetector: ExpressionContextDetector,
        celGenerator: ContextAwareCelGenerator,
        validator: ContextExpressionValidator
    ) {
        this.contextDetector = contextDetector;
        this.celGenerator = celGenerator;
        this.validator = validator;
    }

    /**
     * Analyze and convert a nested expression with context switching
     */
    analyzeWithContextSwitching(
        expression: any,
        config: ContextSwitchingConfig
    ): ContextSwitchingResult {
        const startTime = performance.now();
        const switchPoints: ContextSwitchPoint[] = [];
        const celExpressions = new Map<string, CelExpression>();
        const validationReports = new Map<ExpressionContext, ContextValidationReport>();
        const warnings: string[] = [];
        const allDependencies: KubernetesRef<any>[] = [];

        try {
            // Step 1: Extract all dependencies from the expression first
            const expressionDependencies = this.extractKubernetesRefs(expression);
            allDependencies.push(...expressionDependencies);

            // Step 2: Analyze the expression structure and find context switch points
            const contextDetectionStart = performance.now();
            this.findContextSwitchPoints(
                expression,
                config.primaryContext,
                config.primaryContext,
                [],
                0,
                config,
                switchPoints
            );
            const contextDetectionTime = performance.now() - contextDetectionStart;

            // Step 3: Generate CEL expressions for each context
            const celGenerationStart = performance.now();
            const contextGroups = this.groupSwitchPointsByContext(switchPoints);

            // If no context switches were found but we have dependencies, create a group for the primary context
            if (contextGroups.size === 0 && allDependencies.length > 0) {
                contextGroups.set(config.primaryContext, [{
                    path: [],
                    currentContext: config.primaryContext,
                    targetContext: config.primaryContext,
                    reason: 'Primary context with dependencies',
                    expression,
                    kubernetesRefs: allDependencies,
                    depth: 0
                }]);
            }

            for (const [context, points] of contextGroups) {
                const contextRefs = points.flatMap(p => p.kubernetesRefs);
                allDependencies.push(...contextRefs);

                if (contextRefs.length > 0) {
                    const celConfig: CelGenerationConfig = {
                        factoryType: config.factoryType || 'direct',
                        ...(config.availableResources ? { availableResources: config.availableResources } : {}),
                        ...(config.schemaProxy ? { schemaProxy: config.schemaProxy } : {}),
                        includeDebugInfo: true
                    };

                    const strategy = this.determineCelStrategy(context, config.factoryType);
                    const celResult = this.celGenerator.generateCelExpression(
                        contextRefs,
                        context,
                        strategy,
                        celConfig
                    );

                    celExpressions.set(context, celResult.celExpression);

                    if (celResult.warnings.length > 0) {
                        warnings.push(...celResult.warnings);
                    }
                }
            }
            const celGenerationTime = performance.now() - celGenerationStart;

            // Step 4: Validate context switches if enabled
            const validationStart = performance.now();
            if (config.validateContextSwitches) {
                for (const [context, points] of contextGroups) {
                    const contextExpression = points.map(p => p.expression);
                    const validationConfig: ContextValidationConfig = {
                        ...(config.availableResources ? { availableResources: config.availableResources } : {}),
                        ...(config.schemaProxy ? { schemaProxy: config.schemaProxy } : {}),
                        ...(config.factoryType ? { factoryType: config.factoryType } : {}),
                        validateMagicProxy: true
                    };

                    const report = this.validator.validateExpression(
                        contextExpression,
                        context,
                        validationConfig
                    );

                    validationReports.set(context, report);

                    if (!report.valid) {
                        warnings.push(`Context ${context} validation failed: ${report.errors.map(e => e.message).join(', ')}`);
                    }
                }
            }
            const validationTime = performance.now() - validationStart;

            // Step 5: Combine CEL expressions into final result
            const finalCelExpression = this.combineCelExpressions(
                celExpressions,
                switchPoints,
                config.primaryContext
            );

            const totalTime = performance.now() - startTime;

            return {
                originalExpression: expression,
                primaryContext: config.primaryContext,
                switchPoints,
                celExpressions,
                finalCelExpression,
                allDependencies: [...new Set(allDependencies)], // Remove duplicates
                validationReports,
                warnings,
                performanceMetrics: {
                    totalTimeMs: totalTime,
                    contextDetectionTimeMs: contextDetectionTime,
                    celGenerationTimeMs: celGenerationTime,
                    validationTimeMs: validationTime,
                    contextSwitchCount: switchPoints.length,
                    maxDepthReached: Math.max(...switchPoints.map(p => p.depth), 0)
                }
            };

        } catch (error) {
            throw new ConversionError(
                `Context switching analysis failed: ${error instanceof Error ? error.message : String(error)}`,
                String(expression),
                'unknown'
            );
        }
    }

    /**
     * Find context switch points in a nested expression
     */
    private findContextSwitchPoints(
        expression: any,
        currentContext: ExpressionContext,
        parentContext: ExpressionContext,
        path: string[],
        depth: number,
        config: ContextSwitchingConfig,
        switchPoints: ContextSwitchPoint[]
    ): void {
        // Check maximum depth
        if (config.maxNestingDepth && depth > config.maxNestingDepth) {
            return;
        }

        // Extract KubernetesRef objects from this expression part
        const kubernetesRefs = this.extractKubernetesRefs(expression);

        // Detect if context should switch for this expression part
        if (config.autoDetectContext && kubernetesRefs.length > 0) {
            const detectionResult = this.contextDetector.detectContext(expression, {
                ...(config.availableResources ? { availableResources: config.availableResources } : {}),
                ...(config.schemaProxy ? { schemaProxy: config.schemaProxy } : {}),
                ...(config.factoryType ? { factoryType: config.factoryType } : {})
            });

            // Check if we should switch context
            if (detectionResult.context !== currentContext && detectionResult.confidence > 0.7) {
                switchPoints.push({
                    path: [...path],
                    currentContext,
                    targetContext: detectionResult.context,
                    reason: `Auto-detected context switch: ${detectionResult.reasons.join(', ')}`,
                    expression,
                    kubernetesRefs,
                    depth
                });

                currentContext = detectionResult.context;
            }
        }

        // Apply custom context switching rules
        if (config.customContextRules) {
            for (const rule of config.customContextRules.sort((a, b) => b.priority - a.priority)) {
                if (rule.condition(expression, currentContext, parentContext, depth)) {
                    switchPoints.push({
                        path: [...path],
                        currentContext,
                        targetContext: rule.targetContext,
                        reason: `Custom rule: ${rule.name}`,
                        expression,
                        kubernetesRefs,
                        depth
                    });

                    currentContext = rule.targetContext;
                    break; // Use highest priority rule only
                }
            }
        }

        // Recursively analyze nested structures
        if (Array.isArray(expression)) {
            expression.forEach((item, index) => {
                this.findContextSwitchPoints(
                    item,
                    currentContext,
                    currentContext,
                    [...path, `[${index}]`],
                    depth + 1,
                    config,
                    switchPoints
                );
            });
        } else if (expression && typeof expression === 'object' && !isKubernetesRef(expression)) {
            for (const [key, value] of Object.entries(expression)) {
                // Skip certain keys that shouldn't trigger context switches
                if (key.startsWith('_') || key === 'constructor' || key === 'prototype') {
                    continue;
                }

                this.findContextSwitchPoints(
                    value,
                    currentContext,
                    currentContext,
                    [...path, key],
                    depth + 1,
                    config,
                    switchPoints
                );
            }
        } else if (typeof expression === 'string') {
            // Analyze string expressions for nested patterns
            this.analyzeStringExpression(
                expression,
                currentContext,
                path,
                depth,
                config,
                switchPoints
            );
        }
    }

    /**
     * Analyze string expressions for context switching patterns
     */
    private analyzeStringExpression(
        expression: string,
        currentContext: ExpressionContext,
        path: string[],
        depth: number,
        _config: ContextSwitchingConfig,
        switchPoints: ContextSwitchPoint[]
    ): void {
        // Look for template literal patterns
        if (expression.includes('${') && expression.includes('}')) {
            const templateParts = this.parseTemplateLiteral(expression);

            templateParts.forEach((part, index) => {
                if (part.type === 'interpolation') {
                    // Template interpolations might need different context
                    if (currentContext !== 'template-literal') {
                        switchPoints.push({
                            path: [...path, `template[${index}]`],
                            currentContext,
                            targetContext: 'template-literal',
                            reason: 'Template literal interpolation detected',
                            expression: part.content,
                            kubernetesRefs: this.extractKubernetesRefs(part.content),
                            depth: depth + 1
                        });
                    }
                }
            });
        }

        // Look for conditional patterns
        if (expression.includes('?') && expression.includes(':')) {
            const conditionalParts = this.parseConditionalExpression(expression);

            if (conditionalParts && currentContext !== 'conditional') {
                switchPoints.push({
                    path: [...path, 'condition'],
                    currentContext,
                    targetContext: 'conditional',
                    reason: 'Conditional expression detected',
                    expression: conditionalParts.condition,
                    kubernetesRefs: this.extractKubernetesRefs(conditionalParts.condition),
                    depth: depth + 1
                });
            }
        }
    }

    /**
     * Parse template literal into parts
     */
    private parseTemplateLiteral(expression: string): TemplatePart[] {
        const parts: TemplatePart[] = [];
        let currentIndex = 0;

        while (currentIndex < expression.length) {
            const interpolationStart = expression.indexOf('${', currentIndex);

            if (interpolationStart === -1) {
                // No more interpolations
                if (currentIndex < expression.length) {
                    parts.push({
                        type: 'literal',
                        content: expression.slice(currentIndex)
                    });
                }
                break;
            }

            // Add literal part before interpolation
            if (interpolationStart > currentIndex) {
                parts.push({
                    type: 'literal',
                    content: expression.slice(currentIndex, interpolationStart)
                });
            }

            // Find the end of interpolation
            const interpolationEnd = this.findMatchingBrace(expression, interpolationStart + 2);

            if (interpolationEnd === -1) {
                // Malformed template literal
                break;
            }

            // Add interpolation part
            parts.push({
                type: 'interpolation',
                content: expression.slice(interpolationStart + 2, interpolationEnd)
            });

            currentIndex = interpolationEnd + 1;
        }

        return parts;
    }

    /**
     * Parse conditional expression
     */
    private parseConditionalExpression(expression: string): ConditionalParts | null {
        const questionIndex = expression.indexOf('?');
        const colonIndex = expression.indexOf(':', questionIndex);

        if (questionIndex === -1 || colonIndex === -1) {
            return null;
        }

        return {
            condition: expression.slice(0, questionIndex).trim(),
            trueBranch: expression.slice(questionIndex + 1, colonIndex).trim(),
            falseBranch: expression.slice(colonIndex + 1).trim()
        };
    }

    /**
     * Find matching closing brace
     */
    private findMatchingBrace(expression: string, startIndex: number): number {
        let braceCount = 1;
        let index = startIndex;

        while (index < expression.length && braceCount > 0) {
            const char = expression[index];

            if (char === '{') {
                braceCount++;
            } else if (char === '}') {
                braceCount--;
            }

            index++;
        }

        return braceCount === 0 ? index - 1 : -1;
    }

    /**
     * Group switch points by context
     */
    private groupSwitchPointsByContext(
        switchPoints: ContextSwitchPoint[]
    ): Map<ExpressionContext, ContextSwitchPoint[]> {
        const groups = new Map<ExpressionContext, ContextSwitchPoint[]>();

        for (const point of switchPoints) {
            const context = point.targetContext;

            if (!groups.has(context)) {
                groups.set(context, []);
            }

            groups.get(context)?.push(point);
        }

        return groups;
    }

    /**
     * Determine CEL generation strategy for context
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
     * Combine CEL expressions from different contexts
     */
    private combineCelExpressions(
        celExpressions: Map<string, CelExpression>,
        _switchPoints: ContextSwitchPoint[],
        _primaryContext: ExpressionContext
    ): CelExpression {
        if (celExpressions.size === 0) {
            // No CEL expressions generated
            return {
                expression: '/* No KubernetesRef objects found */',
                _type: undefined
            } as CelExpression;
        }

        if (celExpressions.size === 1) {
            // Single context - return the CEL expression directly
            const singleExpression = Array.from(celExpressions.values())[0];
            if (!singleExpression) {
                throw new ConversionError('No CEL expression generated', 'unknown', 'unknown');
            }
            return singleExpression;
        }

        // Multiple contexts - need to combine them appropriately
        const expressions = Array.from(celExpressions.entries());

        // For now, create a structure that preserves context information
        const combinedExpression = expressions
            .map(([context, cel]) => `/* ${context} */ ${cel.expression}`)
            .join(' + ');

        return {
            expression: combinedExpression,
            _type: 'string' // Default to string for combined expressions
        } as CelExpression;
    }

    /**
     * Extract KubernetesRef objects from expression
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
     * Recursively extract KubernetesRef objects
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
}

/**
 * Template literal part
 */
interface TemplatePart {
    type: 'literal' | 'interpolation';
    content: string;
}

/**
 * Conditional expression parts
 */
interface ConditionalParts {
    condition: string;
    trueBranch: string;
    falseBranch: string;
}

/**
 * Context switching utilities
 */
export class ContextSwitchingUtils {

    /**
     * Create default context switching rules
     */
    static createDefaultRules(): ContextSwitchingRule[] {
        return [
            {
                id: 'template-literal-interpolation',
                name: 'Template Literal Interpolation',
                condition: (expression, currentContext) => {
                    return typeof expression === 'string' &&
                        expression.includes('${') &&
                        currentContext !== 'template-literal';
                },
                targetContext: 'template-literal',
                priority: 100
            },

            {
                id: 'conditional-expression',
                name: 'Conditional Expression',
                condition: (expression, currentContext) => {
                    return typeof expression === 'string' &&
                        expression.includes('?') &&
                        expression.includes(':') &&
                        currentContext !== 'conditional';
                },
                targetContext: 'conditional',
                priority: 90
            },

            {
                id: 'readiness-check',
                name: 'Readiness Check',
                condition: (expression, currentContext) => {
                    const expressionString = String(expression);
                    return /ready|available|healthy|running/i.test(expressionString) &&
                        currentContext !== 'readiness';
                },
                targetContext: 'readiness',
                priority: 80
            },

            {
                id: 'status-field-reference',
                name: 'Status Field Reference',
                condition: (expression, currentContext) => {
                    if (!containsKubernetesRefs(expression)) return false;

                    const refs = [];
                    if (isKubernetesRef(expression)) {
                        refs.push(expression);
                    } else {
                        // Extract refs from complex expression
                        // This is a simplified check
                        return String(expression).includes('status') &&
                            currentContext !== 'status-builder';
                    }

                    return refs.some(ref => ref.fieldPath.includes('status')) &&
                        currentContext !== 'status-builder';
                },
                targetContext: 'status-builder',
                priority: 70
            }
        ];
    }

    /**
     * Optimize context switching configuration
     */
    static optimizeConfig(config: ContextSwitchingConfig): ContextSwitchingConfig {
        const optimized = { ...config };

        // Set reasonable defaults
        if (optimized.maxNestingDepth === undefined) {
            optimized.maxNestingDepth = 10;
        }

        if (optimized.autoDetectContext === undefined) {
            optimized.autoDetectContext = true;
        }

        if (optimized.validateContextSwitches === undefined) {
            optimized.validateContextSwitches = true;
        }

        if (optimized.optimizeContextSwitches === undefined) {
            optimized.optimizeContextSwitches = true;
        }

        // Add default rules if none provided
        if (!optimized.customContextRules) {
            optimized.customContextRules = ContextSwitchingUtils.createDefaultRules();
        }

        return optimized;
    }

    /**
     * Analyze context switching performance
     */
    static analyzePerformance(result: ContextSwitchingResult): string {
        const metrics = result.performanceMetrics;
        if (!metrics) return 'No performance metrics available';

        const lines = [
            `Context Switching Performance Analysis:`,
            `  Total Time: ${metrics.totalTimeMs.toFixed(2)}ms`,
            `  Context Detection: ${metrics.contextDetectionTimeMs.toFixed(2)}ms (${((metrics.contextDetectionTimeMs / metrics.totalTimeMs) * 100).toFixed(1)}%)`,
            `  CEL Generation: ${metrics.celGenerationTimeMs.toFixed(2)}ms (${((metrics.celGenerationTimeMs / metrics.totalTimeMs) * 100).toFixed(1)}%)`,
            `  Validation: ${metrics.validationTimeMs.toFixed(2)}ms (${((metrics.validationTimeMs / metrics.totalTimeMs) * 100).toFixed(1)}%)`,
            `  Context Switches: ${metrics.contextSwitchCount}`,
            `  Max Depth: ${metrics.maxDepthReached}`
        ];

        return lines.join('\n');
    }
}

/**
 * Create a context switcher with default dependencies
 */
export function createContextSwitcher(
    contextDetector: ExpressionContextDetector,
    celGenerator: ContextAwareCelGenerator,
    validator: ContextExpressionValidator
): ExpressionContextSwitcher {
    return new ExpressionContextSwitcher(contextDetector, celGenerator, validator);
}