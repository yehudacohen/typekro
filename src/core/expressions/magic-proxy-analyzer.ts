/**
 * Magic Proxy System Integration for JavaScript to CEL Expression Conversion
 * 
 * This module provides deep integration with TypeKro's magic proxy system,
 * including SchemaProxy and ResourcesProxy, to detect and analyze KubernetesRef
 * objects within JavaScript expressions and convert them to appropriate CEL expressions.
 * 
 * The magic proxy system creates KubernetesRef objects at runtime when accessing
 * properties on schema and resources proxies. This analyzer uses AST parsing to
 * detect these access patterns in JavaScript expressions and converts them to CEL.
 */

import * as esprima from 'esprima';
import * as estraverse from 'estraverse';
import type { Node as ESTreeNode, MemberExpression, Identifier, } from 'estree';

import type { CelExpression, KubernetesRef } from '../types/common.js';
import type { SchemaProxy } from '../types/serialization.js';
import type { MagicProxy } from '../types/references.js';
import { ConversionError } from '../errors.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND, BrandChecks } from '../constants/brands.js';
import type { AnalysisContext, CelConversionResult } from './analyzer.js';
import { SourceMapBuilder, type SourceMapEntry, } from './source-map.js';
import { getComponentLogger } from '../logging/index.js';

/**
 * Magic proxy analysis context with additional proxy-specific information
 */
export interface MagicProxyAnalysisContext extends AnalysisContext {
    /** Schema proxy instance for schema field references */
    schemaProxy?: SchemaProxy<any, any>;

    /** Available resource proxies */
    resourceProxies?: Record<string, MagicProxy<any>>;

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

/**
 * Magic Proxy Analyzer for detecting and converting KubernetesRef objects
 * from TypeKro's magic proxy system
 */
export class MagicProxyAnalyzer {
    private sourceMapBuilder: SourceMapBuilder;
    private logger = getComponentLogger('magic-proxy-analyzer');

    constructor() {
        this.sourceMapBuilder = new SourceMapBuilder();
    }

    /**
     * Analyze expressions for magic proxy access patterns
     * 
     * This method can handle different types of expressions:
     * - String expressions: parsed with AST
     * - KubernetesRef objects: analyzed directly
     * - Other objects: analyzed for nested KubernetesRef objects
     */
    analyzeExpressionWithRefs(
        expression: any,
        context: MagicProxyAnalysisContext
    ): MagicProxyAnalysisResult {
        try {
            // Handle KubernetesRef objects directly
            if (expression && typeof expression === 'object' && expression.__brand === 'KubernetesRef') {
                return this.analyzeKubernetesRefDirectly(expression as KubernetesRef<any>, context);
            }

            // Handle string expressions with AST parsing
            if (typeof expression === 'string') {
                return this.analyzeStringExpression(expression, context);
            }

            // Handle other objects
            if (typeof expression === 'object' && expression !== null) {
                return this.analyzeObjectExpression(expression, context);
            }

            // Handle primitives
            return this.analyzePrimitiveExpression(expression, context);

        } catch (error) {
            return this.createErrorResult(expression, error, context);
        }
    }

    /**
     * Analyze a KubernetesRef object directly
     */
    private analyzeKubernetesRefDirectly(ref: KubernetesRef<any>, context: MagicProxyAnalysisContext): MagicProxyAnalysisResult {
        const { schemaRefs, resourceRefs, schemaReferences, resourceReferences } = 
            this.analyzeKubernetesRefs([ref]);

        const celExpressions = this.convertKubernetesRefsToCel([ref], context);
        const proxyTypes: ('schema' | 'resource')[] = [];
        if (schemaRefs.length > 0) proxyTypes.push('schema');
        if (resourceRefs.length > 0) proxyTypes.push('resource');

        return {
            valid: true,
            celExpression: celExpressions.length > 0 ? (celExpressions[0] || null) : null,
            dependencies: [ref],
            sourceMap: [],
            errors: [],
            warnings: [],
            requiresConversion: true,
            proxyTypes,
            schemaReferences,
            resourceReferences,
            analysisDepth: 1
        };
    }

    /**
     * Analyze string expressions using AST parsing
     */
    private analyzeStringExpression(expressionSource: string, context: MagicProxyAnalysisContext): MagicProxyAnalysisResult {
        this.logger.debug('Analyzing string expression for magic proxy patterns', {
            expression: expressionSource.substring(0, 100),
            contextType: context.type
        });

        // Parse the JavaScript expression to AST
        const ast = this.parseExpression(expressionSource);

        // Analyze the AST for magic proxy access patterns
        const analysisResult = this.analyzeASTForMagicProxyPatterns(ast, expressionSource, context);

        // Convert the analysis result to magic proxy result format
        const conversionResult = this.convertToMagicProxyResult(analysisResult, context);

        return conversionResult;
    }

    /**
     * Analyze object expressions
     */
    private analyzeObjectExpression(obj: any, context: MagicProxyAnalysisContext): MagicProxyAnalysisResult {
        const refs = this.detectKubernetesRefs(obj);
        const { schemaRefs, resourceRefs, schemaReferences, resourceReferences } = 
            this.analyzeKubernetesRefs(refs);

        const celExpressions = this.convertKubernetesRefsToCel(refs, context);
        const proxyTypes: ('schema' | 'resource')[] = [];
        if (schemaRefs.length > 0) proxyTypes.push('schema');
        if (resourceRefs.length > 0) proxyTypes.push('resource');

        return {
            valid: true,
            celExpression: celExpressions.length > 0 ? (celExpressions[0] || null) : null,
            dependencies: refs,
            sourceMap: [],
            errors: [],
            warnings: [],
            requiresConversion: refs.length > 0,
            proxyTypes,
            schemaReferences,
            resourceReferences,
            analysisDepth: 1
        };
    }

    /**
     * Analyze primitive expressions
     */
    private analyzePrimitiveExpression(_value: any, _context: MagicProxyAnalysisContext): MagicProxyAnalysisResult {
        return {
            valid: true,
            celExpression: null,
            dependencies: [],
            sourceMap: [],
            errors: [],
            warnings: [],
            requiresConversion: false,
            proxyTypes: [],
            schemaReferences: [],
            resourceReferences: [],
            analysisDepth: 0
        };
    }

    /**
     * Parse JavaScript expression string into AST using esprima
     */
    private parseExpression(expressionSource: string): ESTreeNode {
        try {
            // Use esprima to parse the expression
            const ast = esprima.parseScript(expressionSource, {
                loc: true,
                range: true
            });
            
            return ast;
        } catch (error) {
            throw new ConversionError(
                `Failed to parse JavaScript expression: ${error instanceof Error ? error.message : 'Unknown error'}`,
                expressionSource,
                'javascript'
            );
        }
    }

    /**
     * Analyze AST for magic proxy access patterns
     */
    private analyzeASTForMagicProxyPatterns(
        ast: ESTreeNode,
        _expressionSource: string,
        context: MagicProxyAnalysisContext
    ): {
        refs: KubernetesRef<any>[];
        analysisDepth: number;
        hasProxyObjects: boolean;
    } {
        const refs: KubernetesRef<any>[] = [];
        let analysisDepth = 0;
        let hasProxyObjects = false;

        // Traverse the AST to find member expressions that could be magic proxy accesses
        estraverse.traverse(ast, {
            enter: (node, _parent) => {
                analysisDepth++;
                
                if (node.type === 'MemberExpression') {
                    const memberExpr = node as MemberExpression;
                    const kubernetesRef = this.extractKubernetesRefFromMemberExpression(memberExpr, context);
                    
                    if (kubernetesRef) {
                        refs.push(kubernetesRef);
                        hasProxyObjects = true;
                    }
                }
                
                // Check for other proxy patterns
                if (this.isProxyAccessPattern(node, context)) {
                    hasProxyObjects = true;
                }
            }
        });

        return {
            refs,
            analysisDepth,
            hasProxyObjects
        };
    }

    /**
     * Extract KubernetesRef from member expression AST node
     */
    private extractKubernetesRefFromMemberExpression(
        memberExpr: MemberExpression,
        context: MagicProxyAnalysisContext
    ): KubernetesRef<any> | null {
        try {
            // Build the field path from the member expression chain
            const fieldPath = this.buildFieldPathFromMemberExpression(memberExpr);
            const resourceId = this.extractResourceIdFromMemberExpression(memberExpr);
            
            if (resourceId && fieldPath) {
                // Check if this matches known proxy patterns
                if (this.isValidProxyAccess(resourceId, fieldPath, context)) {
                    return {
                        [KUBERNETES_REF_BRAND]: true,
                        resourceId,
                        fieldPath,
                        _type: undefined // Will be inferred from context
                    };
                }
            }
            
            return null;
        } catch (error) {
            this.logger.debug('Failed to extract KubernetesRef from member expression', { error });
            return null;
        }
    }

    /**
     * Build field path from member expression chain
     */
    private buildFieldPathFromMemberExpression(memberExpr: MemberExpression): string | null {
        const parts: string[] = [];
        let current: ESTreeNode = memberExpr;
        
        while (current && current.type === 'MemberExpression') {
            const member = current as MemberExpression;
            
            if (member.property.type === 'Identifier') {
                parts.unshift(member.property.name);
            } else {
                // Skip computed properties for now
                break;
            }
            
            current = member.object;
        }
        
        return parts.length > 0 ? parts.join('.') : null;
    }

    /**
     * Extract resource ID from member expression
     */
    private extractResourceIdFromMemberExpression(memberExpr: MemberExpression): string | null {
        let current: ESTreeNode = memberExpr;
        
        // Traverse to the root of the member expression chain
        while (current && current.type === 'MemberExpression') {
            current = (current as MemberExpression).object;
        }
        
        if (current && current.type === 'Identifier') {
            const identifier = current as Identifier;
            
            // Check for known proxy patterns
            if (identifier.name === 'schema') {
                return '__schema__';
            } else if (identifier.name === 'resources') {
                // For resources.resourceName.field, we need to get the next level
                let resourceCurrent: ESTreeNode = memberExpr;
                while (resourceCurrent && resourceCurrent.type === 'MemberExpression') {
                    const member = resourceCurrent as MemberExpression;
                    if (member.object.type === 'Identifier' && member.object.name === 'resources') {
                        if (member.property.type === 'Identifier') {
                            return member.property.name;
                        }
                        break;
                    }
                    resourceCurrent = member.object;
                }
            } else {
                // Direct resource access
                return identifier.name;
            }
        }
        
        return null;
    }

    /**
     * Check if a node represents a proxy access pattern
     */
    private isProxyAccessPattern(node: ESTreeNode, context: MagicProxyAnalysisContext): boolean {
        if (node.type === 'MemberExpression') {
            const memberExpr = node as MemberExpression;
            const resourceId = this.extractResourceIdFromMemberExpression(memberExpr);
            
            if (resourceId) {
                return this.isValidProxyAccess(resourceId, '', context);
            }
        }
        
        return false;
    }

    /**
     * Check if a resource ID and field path represent valid proxy access
     */
    private isValidProxyAccess(
        resourceId: string,
        _fieldPath: string,
        context: MagicProxyAnalysisContext
    ): boolean {
        // Schema references are always valid
        if (resourceId === '__schema__') {
            return true;
        }
        
        // Check if resource exists in available references
        if (context.availableReferences?.[resourceId]) {
            return true;
        }
        
        // Check if resource exists in resource proxies
        if (context.resourceProxies?.[resourceId]) {
            return true;
        }
        
        return false;
    }

    /**
     * Detect KubernetesRef objects in complex data structures
     * 
     * This method uses a breadth-first search approach to find all
     * KubernetesRef objects while respecting maxDepth to prevent infinite recursion.
     * The maxDepth limits how deep we traverse non-KubernetesRef objects, but we
     * continue searching for KubernetesRef objects even beyond the depth limit.
     * This allows us to find deeply nested KubernetesRef objects while still
     * preventing infinite recursion on complex object graphs.
     */
    detectKubernetesRefs(
        value: any,
        maxDepth: number = 10,
        currentDepth: number = 0
    ): KubernetesRef<any>[] {
        const refs: KubernetesRef<any>[] = [];
        const visited = new WeakSet();
        
        // Use a queue for breadth-first traversal
        const queue: Array<{ value: any; depth: number }> = [{ value, depth: currentDepth }];
        
        while (queue.length > 0) {
            const { value: currentValue, depth } = queue.shift()!;
            
            // Skip if we've already visited this object (prevents infinite loops)
            if (currentValue && typeof currentValue === 'object' && visited.has(currentValue)) {
                continue;
            }
            
            // Check if the current value is a KubernetesRef
            if (this.isKubernetesRef(currentValue)) {
                refs.push(currentValue);
                continue; // Don't traverse into KubernetesRef objects
            }
            
            // Mark as visited if it's an object
            if (currentValue && typeof currentValue === 'object') {
                visited.add(currentValue);
            }
            
            // For objects beyond maxDepth, we still check if they might contain
            // KubernetesRef objects, but we limit the expansion to prevent
            // infinite recursion on complex object graphs
            const shouldExpandFully = depth < maxDepth;
            const shouldCheckForRefs = depth < maxDepth + 50; // Allow significant extra depth for KubernetesRef detection
            
            if (!shouldCheckForRefs) {
                continue;
            }
            
            // Add children to the queue for further processing
            if (Array.isArray(currentValue)) {
                for (const item of currentValue) {
                    if (shouldExpandFully || this.mightContainKubernetesRef(item)) {
                        queue.push({ value: item, depth: depth + 1 });
                    }
                }
            } else if (currentValue && typeof currentValue === 'object') {
                // Skip functions and special objects
                if (typeof currentValue === 'function' || 
                    currentValue instanceof Date || 
                    currentValue instanceof RegExp) {
                    continue;
                }
                
                // Add object properties to the queue
                for (const key in currentValue) {
                    if (Object.hasOwn(currentValue, key)) {
                        try {
                            const propertyValue = currentValue[key];
                            if (shouldExpandFully || this.mightContainKubernetesRef(propertyValue)) {
                                queue.push({ value: propertyValue, depth: depth + 1 });
                            }
                        } catch (_error) {
                            // Ignore errors when accessing properties during analysis
                        }
                    }
                }
            }
        }
        
        return refs;
    }

    /**
     * Analyze KubernetesRef objects and categorize them by type
     */
    analyzeKubernetesRefs(refs: KubernetesRef<any>[]): {
        schemaRefs: KubernetesRef<any>[];
        resourceRefs: KubernetesRef<any>[];
        schemaReferences: string[];
        resourceReferences: string[];
    } {
        const schemaRefs: KubernetesRef<any>[] = [];
        const resourceRefs: KubernetesRef<any>[] = [];
        const schemaReferences: string[] = [];
        const resourceReferences: string[] = [];

        for (const ref of refs) {
            if (ref.resourceId === '__schema__') {
                schemaRefs.push(ref);
                schemaReferences.push(ref.fieldPath);
            } else {
                resourceRefs.push(ref);
                resourceReferences.push(`${ref.resourceId}.${ref.fieldPath}`);
            }
        }

        return {
            schemaRefs,
            resourceRefs,
            schemaReferences: Array.from(new Set(schemaReferences)),
            resourceReferences: Array.from(new Set(resourceReferences))
        };
    }

    /**
     * Convert KubernetesRef objects to CEL expressions with magic proxy context
     */
    convertKubernetesRefsToCel(
        refs: KubernetesRef<any>[],
        context: MagicProxyAnalysisContext
    ): CelExpression[] {
        const celExpressions: CelExpression[] = [];

        for (const ref of refs) {
            try {
                const celExpression = this.convertSingleKubernetesRefToCel(ref, context);
                celExpressions.push(celExpression);
            } catch (error) {
                // Log error but continue with other refs
                console.warn(`Failed to convert KubernetesRef ${ref.resourceId}.${ref.fieldPath}:`, error);
            }
        }

        return celExpressions;
    }

    /**
     * Validate KubernetesRef objects against available proxies
     */
    validateKubernetesRefs(
        refs: KubernetesRef<any>[],
        context: MagicProxyAnalysisContext
    ): {
        valid: KubernetesRef<any>[];
        invalid: Array<{ ref: KubernetesRef<any>; reason: string }>;
    } {
        const valid: KubernetesRef<any>[] = [];
        const invalid: Array<{ ref: KubernetesRef<any>; reason: string }> = [];

        for (const ref of refs) {
            const validationResult = this.validateSingleKubernetesRef(ref, context);

            if (validationResult.isValid) {
                valid.push(ref);
            } else {
                invalid.push({ ref, reason: validationResult.reason });
            }
        }

        return { valid, invalid };
    }

    /**
     * Get source mapping information for magic proxy analysis
     */
    getSourceMapping(): SourceMapEntry[] {
        return this.sourceMapBuilder.getEntries();
    }

    /**
     * Clear source mapping information
     */
    clearSourceMapping(): void {
        this.sourceMapBuilder.clear();
    }

    /**
     * Convert analysis result to MagicProxyAnalysisResult
     */
    private convertToMagicProxyResult(
        analysisResult: {
            refs: KubernetesRef<any>[];
            analysisDepth: number;
            hasProxyObjects: boolean;
        },
        context: MagicProxyAnalysisContext
    ): MagicProxyAnalysisResult {
        const { refs, analysisDepth } = analysisResult;

        // Analyze and categorize KubernetesRef objects
        const { schemaRefs, resourceRefs, schemaReferences, resourceReferences } =
            this.analyzeKubernetesRefs(refs);

        // Validate KubernetesRef objects
        const { valid: validRefs, invalid: invalidRefs } = this.validateKubernetesRefs(refs, context);

        // Convert valid KubernetesRef objects to CEL expressions
        const celExpressions = this.convertKubernetesRefsToCel(validRefs, context);

        // Determine proxy types
        const proxyTypes: ('schema' | 'resource')[] = [];
        if (schemaRefs.length > 0) proxyTypes.push('schema');
        if (resourceRefs.length > 0) proxyTypes.push('resource');

        // Create conversion errors for invalid refs
        const errors: ConversionError[] = invalidRefs.map(({ ref, reason }) =>
            new ConversionError(
                `Invalid KubernetesRef: ${reason}`,
                `${ref.resourceId}.${ref.fieldPath}`,
                'member-access'
            )
        );

        // Determine if conversion is required
        const requiresConversion = refs.length > 0;

        // Create primary CEL expression (use first valid one or null)
        const primaryCelExpression = celExpressions.length > 0 ? celExpressions[0] : null;

        return {
            valid: errors.length === 0,
            celExpression: primaryCelExpression as CelExpression | null,
            dependencies: validRefs,
            sourceMap: this.getSourceMapping(),
            errors,
            warnings: [],
            requiresConversion,
            proxyTypes,
            schemaReferences,
            resourceReferences,
            analysisDepth
        };
    }

    /**
     * Create error result for failed analysis
     */
    private createErrorResult(
        expression: any,
        error: any,
        _context: MagicProxyAnalysisContext
    ): MagicProxyAnalysisResult {
        const conversionError = new ConversionError(
            `Magic proxy analysis failed: ${error instanceof Error ? error.message : String(error)}`,
            String(expression),
            'javascript'
        );

        return {
            valid: false,
            celExpression: null,
            dependencies: [],
            sourceMap: [],
            errors: [conversionError],
            warnings: [],
            requiresConversion: false,
            proxyTypes: [],
            schemaReferences: [],
            resourceReferences: [],
            analysisDepth: 0
        };
    }

    /**
     * Check if a value is a KubernetesRef object
     */
    private isKubernetesRef(value: any): value is KubernetesRef<any> {
        return BrandChecks.isKubernetesRef(value) &&
            typeof (value as any).resourceId === 'string' &&
            typeof (value as any).fieldPath === 'string';
    }

    /**
     * Quick check if a value might contain KubernetesRef objects
     * This is used for optimization when we're beyond maxDepth but still
     * want to find deeply nested KubernetesRef objects.
     */
    private mightContainKubernetesRef(value: any): boolean {
        // If it's already a KubernetesRef, we'll find it
        if (this.isKubernetesRef(value)) {
            return true;
        }
        
        // If it's not an object, it can't contain KubernetesRef objects
        if (!value || typeof value !== 'object') {
            return false;
        }
        
        // Skip functions and special objects that are unlikely to contain KubernetesRef objects
        if (typeof value === 'function' || 
            value instanceof Date || 
            value instanceof RegExp ||
            value instanceof Error) {
            return false;
        }
        
        // For plain objects and arrays, assume they might contain KubernetesRef objects
        // This is a conservative approach that errs on the side of finding all refs
        return true;
    }

    /**
     * Convert a single KubernetesRef to CEL expression
     */
    private convertSingleKubernetesRefToCel(
        ref: KubernetesRef<any>,
        context: MagicProxyAnalysisContext
    ): CelExpression {
        // Generate CEL expression based on factory type
        let celExpression: string;

        if (ref.resourceId === '__schema__') {
            // Schema references
            celExpression = `schema.${ref.fieldPath}`;
        } else {
            // Resource references
            celExpression = `resources.${ref.resourceId}.${ref.fieldPath}`;
        }

        // Add source mapping
        if (context.sourceMap) {
            const sourceLocation = { line: 1, column: 1, length: celExpression.length };
            context.sourceMap.addMapping(
                `${ref.resourceId}.${ref.fieldPath}`,
                celExpression,
                sourceLocation,
                context.type,
                {
                    expressionType: 'member-access',
                    kubernetesRefs: [celExpression],
                    dependencies: [`${ref.resourceId}.${ref.fieldPath}`],
                    conversionNotes: ['Magic proxy KubernetesRef conversion']
                }
            );
        }

        return {
            [CEL_EXPRESSION_BRAND]: true,
            expression: celExpression,
            _type: ref._type
        } as CelExpression;
    }

    /**
     * Validate a single KubernetesRef object
     */
    private validateSingleKubernetesRef(
        ref: KubernetesRef<any>,
        context: MagicProxyAnalysisContext
    ): { isValid: boolean; reason: string } {
        // Check basic structure
        if (!ref.resourceId || !ref.fieldPath) {
            return { isValid: false, reason: 'Missing resourceId or fieldPath' };
        }

        // Validate schema references - always valid if properly structured
        if (ref.resourceId === '__schema__') {
            return { isValid: true, reason: '' };
        }

        // Validate resource references
        if (!context.availableReferences || !context.availableReferences[ref.resourceId]) {
            return {
                isValid: false,
                reason: `Resource '${ref.resourceId}' not found in available references`
            };
        }

        return { isValid: true, reason: '' };
    }
}

/**
 * Utility functions for magic proxy integration
 */
export class MagicProxyUtils {

    /**
     * Check if a value contains any KubernetesRef objects
     */
    static containsKubernetesRefs(value: any): boolean {
        const analyzer = new MagicProxyAnalyzer();
        const refs = analyzer.detectKubernetesRefs(value);
        return refs.length > 0;
    }

    /**
     * Extract all KubernetesRef objects from a value
     */
    static extractKubernetesRefs(value: any): KubernetesRef<any>[] {
        const analyzer = new MagicProxyAnalyzer();
        return analyzer.detectKubernetesRefs(value);
    }

    /**
     * Check if a value is a KubernetesRef object
     */
    static isKubernetesRef(value: any): value is KubernetesRef<any> {
        return BrandChecks.isKubernetesRef(value) &&
            typeof (value as any).resourceId === 'string' &&
            typeof (value as any).fieldPath === 'string';
    }

    /**
     * Check if a value is a schema reference
     */
    static isSchemaReference(value: any): boolean {
        return MagicProxyUtils.isKubernetesRef(value) && value.resourceId === '__schema__';
    }

    /**
     * Check if a value is a resource reference
     */
    static isResourceReference(value: any): boolean {
        return MagicProxyUtils.isKubernetesRef(value) && value.resourceId !== '__schema__';
    }

    /**
     * Get the CEL expression for a KubernetesRef
     */
    static getCelExpression(ref: KubernetesRef<any>): string {
        if (ref.resourceId === '__schema__') {
            return `schema.${ref.fieldPath}`;
        } else {
            return `resources.${ref.resourceId}.${ref.fieldPath}`;
        }
    }
}

/**
 * Global magic proxy analyzer instance
 */
export const globalMagicProxyAnalyzer = new MagicProxyAnalyzer();