/**
 * Migration Helpers for Converting CEL to JavaScript with Magic Proxy Support
 * 
 * This module provides utilities to help developers migrate from manual CEL expressions
 * to natural JavaScript expressions that work with TypeKro's magic proxy system.
 * 
 * The helpers analyze existing CEL expressions and suggest equivalent JavaScript
 * expressions that will be automatically converted back to CEL by the analyzer.
 */

import type { CelExpression } from '../types/common.js';
import { isCelExpression } from '../../utils/type-guards.js';
import { getComponentLogger } from '../logging/index.js';

/**
 * Migration suggestion for converting CEL to JavaScript
 */
export interface MigrationSuggestion {
  /** Original CEL expression */
  originalCel: string;
  
  /** Suggested JavaScript equivalent */
  suggestedJavaScript: string;
  
  /** Confidence level of the suggestion (0-1) */
  confidence: number;
  
  /** Migration category */
  category: MigrationCategory;
  
  /** Additional notes or warnings */
  notes: string[];
  
  /** Whether the migration is safe (no behavior change expected) */
  isSafe: boolean;
  
  /** Example usage in status builder context */
  exampleUsage?: string;
}

/**
 * Migration category
 */
export type MigrationCategory = 
  | 'simple-comparison'      // Simple comparisons like > 0, == "Ready"
  | 'template-string'        // String templates and concatenation
  | 'conditional-expression' // Ternary operators and conditionals
  | 'resource-reference'     // Resource field references
  | 'schema-reference'       // Schema field references
  | 'complex-expression'     // Complex expressions that might need manual review
  | 'unsupported';           // Expressions that cannot be automatically migrated

/**
 * Migration analysis result
 */
export interface MigrationAnalysisResult {
  /** All migration suggestions */
  suggestions: MigrationSuggestion[];
  
  /** Suggestions by category */
  suggestionsByCategory: Map<MigrationCategory, MigrationSuggestion[]>;
  
  /** Overall migration feasibility */
  migrationFeasibility: {
    totalExpressions: number;
    migratableExpressions: number;
    safeMigrations: number;
    unsupportedExpressions: number;
    overallConfidence: number;
  };
  
  /** Migration summary */
  summary: string;
}

/**
 * CEL to JavaScript Migration Helper
 * 
 * Analyzes existing CEL expressions and provides suggestions for converting
 * them to equivalent JavaScript expressions that work with magic proxy.
 */
export class CelToJavaScriptMigrationHelper {
  private logger = getComponentLogger('cel-migration-helper');
  
  /**
   * Analyze status mappings and provide migration suggestions
   */
  analyzeMigrationOpportunities(
    statusMappings: Record<string, any>
  ): MigrationAnalysisResult {
    const suggestions: MigrationSuggestion[] = [];
    
    this.analyzeObjectForMigration(statusMappings, suggestions);
    
    // Categorize suggestions
    const suggestionsByCategory = new Map<MigrationCategory, MigrationSuggestion[]>();
    for (const suggestion of suggestions) {
      if (!suggestionsByCategory.has(suggestion.category)) {
        suggestionsByCategory.set(suggestion.category, []);
      }
      suggestionsByCategory.get(suggestion.category)?.push(suggestion);
    }
    
    // Calculate migration feasibility
    const totalExpressions = suggestions.length;
    const migratableExpressions = suggestions.filter(s => s.category !== 'unsupported').length;
    const safeMigrations = suggestions.filter(s => s.isSafe).length;
    const unsupportedExpressions = suggestions.filter(s => s.category === 'unsupported').length;
    const overallConfidence = totalExpressions > 0 
      ? suggestions.reduce((sum, s) => sum + s.confidence, 0) / totalExpressions 
      : 0;
    
    const migrationFeasibility = {
      totalExpressions,
      migratableExpressions,
      safeMigrations,
      unsupportedExpressions,
      overallConfidence
    };
    
    // Generate summary
    const summary = this.generateMigrationSummary(migrationFeasibility, suggestionsByCategory);
    
    this.logger.debug('Migration analysis complete', {
      totalExpressions,
      migratableExpressions,
      overallConfidence: Math.round(overallConfidence * 100)
    });
    
    return {
      suggestions,
      suggestionsByCategory,
      migrationFeasibility,
      summary
    };
  }
  
  /**
   * Recursively analyze object for CEL expressions that can be migrated
   */
  private analyzeObjectForMigration(
    obj: any,
    suggestions: MigrationSuggestion[],
    path: string = ''
  ): void {
    if (!obj || typeof obj !== 'object') {
      return;
    }
    
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${key}` : key;
      
      if (isCelExpression(value)) {
        const suggestion = this.analyzeCelExpression(value, currentPath);
        if (suggestion) {
          suggestions.push(suggestion);
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        this.analyzeObjectForMigration(value, suggestions, currentPath);
      }
    }
  }
  
  /**
   * Analyze a single CEL expression and provide migration suggestion
   */
  private analyzeCelExpression(
    celExpression: CelExpression,
    fieldPath: string
  ): MigrationSuggestion | null {
    const celString = celExpression.expression;
    
    // Try different migration patterns
    const patterns = [
      this.trySimpleComparison,
      this.tryTemplateString,
      this.tryConditionalExpression,
      this.tryResourceReference,
      this.trySchemaReference,
      this.tryComplexExpression
    ];
    
    for (const pattern of patterns) {
      const suggestion = pattern.call(this, celString, fieldPath);
      if (suggestion) {
        return suggestion;
      }
    }
    
    // If no pattern matches, mark as unsupported
    return {
      originalCel: celString,
      suggestedJavaScript: '// Unable to automatically migrate this expression',
      confidence: 0.1,
      category: 'unsupported',
      notes: [
        'This CEL expression is too complex for automatic migration',
        'Manual review and conversion required',
        'Consider breaking down into simpler expressions'
      ],
      isSafe: false
    };
  }
  
  /**
   * Try to migrate simple comparison expressions
   */
  private trySimpleComparison(celString: string, _fieldPath: string): MigrationSuggestion | null {
    // Pattern: resources.deployment.status.readyReplicas > 0
    const comparisonMatch = celString.match(/^(resources\.[\w.]+|schema\.[\w.]+)\s*([><=!]+)\s*(.+)$/);
    if (comparisonMatch) {
      const [, resourceRef, operator, value] = comparisonMatch;
      if (!resourceRef || !operator || !value) {
        return null;
      }
      const jsResourceRef = this.convertCelReferenceToJavaScript(resourceRef);
      
      return {
        originalCel: celString,
        suggestedJavaScript: `${jsResourceRef} ${operator} ${value}`,
        confidence: 0.9,
        category: 'simple-comparison',
        notes: [
          'Simple comparison expression',
          'Direct conversion to JavaScript comparison operator'
        ],
        isSafe: true,
        exampleUsage: `ready: ${jsResourceRef} ${operator} ${value}`
      };
    }
    
    return null;
  }
  
  /**
   * Try to migrate template string expressions
   */
  private tryTemplateString(celString: string, _fieldPath: string): MigrationSuggestion | null {
    // Pattern: "http://" + resources.service.status.loadBalancer.ingress[0].ip
    const templateMatch = celString.match(/^"([^"]*)" \+ (.+)$/) || 
                         celString.match(/^(.+) \+ "([^"]*)"$/) ||
                         celString.match(/^"([^"]*)" \+ (.+) \+ "([^"]*)"$/);
    
    if (templateMatch) {
      let jsExpression: string;
      let notes: string[];
      
      if (templateMatch.length === 3) {
        // Simple prefix or suffix
        const [, stringPart, refPart] = templateMatch;
        if (!stringPart || !refPart) {
          return null;
        }
        const jsRef = this.convertCelReferenceToJavaScript(refPart.trim());
        
        if (celString.startsWith('"')) {
          // Prefix: "http://" + ref
          jsExpression = `\`${stringPart}\${${jsRef}}\``;
        } else {
          // Suffix: ref + ".com"
          jsExpression = `\`\${${jsRef}}${stringPart}\``;
        }
        
        notes = [
          'String concatenation converted to template literal',
          'Template literals are more readable and maintainable'
        ];
      } else {
        // Complex template - might need manual review
        jsExpression = '// Complex template - manual conversion recommended';
        notes = [
          'Complex string concatenation detected',
          'Consider using template literal with multiple interpolations',
          'Manual review recommended for accuracy'
        ];
      }
      
      return {
        originalCel: celString,
        suggestedJavaScript: jsExpression,
        confidence: templateMatch.length === 3 ? 0.8 : 0.4,
        category: 'template-string',
        notes,
        isSafe: templateMatch.length === 3,
        exampleUsage: `url: ${jsExpression}`
      };
    }
    
    return null;
  }
  
  /**
   * Try to migrate conditional expressions
   */
  private tryConditionalExpression(celString: string, _fieldPath: string): MigrationSuggestion | null {
    // Pattern: condition ? trueValue : falseValue
    const conditionalMatch = celString.match(/^(.+?)\s*\?\s*(.+?)\s*:\s*(.+)$/);
    if (conditionalMatch) {
      const [, condition, trueValue, falseValue] = conditionalMatch;
      if (!condition || !trueValue || !falseValue) {
        return null;
      }
      
      const jsCondition = this.convertCelExpressionToJavaScript(condition.trim());
      const jsTrueValue = this.convertCelValueToJavaScript(trueValue.trim());
      const jsFalseValue = this.convertCelValueToJavaScript(falseValue.trim());
      
      const jsExpression = `${jsCondition} ? ${jsTrueValue} : ${jsFalseValue}`;
      
      return {
        originalCel: celString,
        suggestedJavaScript: jsExpression,
        confidence: 0.7,
        category: 'conditional-expression',
        notes: [
          'Conditional expression (ternary operator)',
          'Direct conversion to JavaScript ternary operator'
        ],
        isSafe: true,
        exampleUsage: `phase: ${jsExpression}`
      };
    }
    
    return null;
  }
  
  /**
   * Try to migrate resource reference expressions
   */
  private tryResourceReference(celString: string, fieldPath: string): MigrationSuggestion | null {
    // Pattern: resources.deployment.status.readyReplicas
    const resourceMatch = celString.match(/^resources\.([\w.]+)$/);
    if (resourceMatch) {
      const [, resourcePath] = resourceMatch;
      const jsRef = `resources.${resourcePath}`;
      
      return {
        originalCel: celString,
        suggestedJavaScript: jsRef,
        confidence: 0.95,
        category: 'resource-reference',
        notes: [
          'Simple resource field reference',
          'Direct conversion - magic proxy will handle the reference'
        ],
        isSafe: true,
        exampleUsage: `${fieldPath}: ${jsRef}`
      };
    }
    
    return null;
  }
  
  /**
   * Try to migrate schema reference expressions
   */
  private trySchemaReference(celString: string, fieldPath: string): MigrationSuggestion | null {
    // Pattern: schema.spec.name
    const schemaMatch = celString.match(/^schema\.([\w.]+)$/);
    if (schemaMatch) {
      const [, schemaPath] = schemaMatch;
      const jsRef = `schema.${schemaPath}`;
      
      return {
        originalCel: celString,
        suggestedJavaScript: jsRef,
        confidence: 0.95,
        category: 'schema-reference',
        notes: [
          'Simple schema field reference',
          'Direct conversion - magic proxy will handle the reference'
        ],
        isSafe: true,
        exampleUsage: `${fieldPath}: ${jsRef}`
      };
    }
    
    return null;
  }
  
  /**
   * Try to migrate complex expressions
   */
  private tryComplexExpression(celString: string, _fieldPath: string): MigrationSuggestion | null {
    // For complex expressions, provide general guidance
    if (celString.length > 50 || celString.includes('&&') || celString.includes('||')) {
      return {
        originalCel: celString,
        suggestedJavaScript: '// Complex expression - consider breaking into smaller parts',
        confidence: 0.3,
        category: 'complex-expression',
        notes: [
          'Complex CEL expression detected',
          'Consider breaking into multiple simpler expressions',
          'Use JavaScript logical operators (&&, ||) instead of CEL equivalents',
          'Manual review recommended'
        ],
        isSafe: false
      };
    }
    
    return null;
  }
  
  /**
   * Convert CEL resource reference to JavaScript equivalent
   */
  private convertCelReferenceToJavaScript(celRef: string): string {
    // Remove any extra whitespace and convert CEL reference to JS
    return celRef.trim();
  }
  
  /**
   * Convert CEL expression part to JavaScript equivalent
   */
  private convertCelExpressionToJavaScript(celExpr: string): string {
    // Handle resource/schema references
    if (celExpr.startsWith('resources.') || celExpr.startsWith('schema.')) {
      return celExpr;
    }
    
    // Handle string literals
    if (celExpr.startsWith('"') && celExpr.endsWith('"')) {
      return celExpr;
    }
    
    // Handle numbers and booleans
    if (/^\d+(\.\d+)?$/.test(celExpr) || celExpr === 'true' || celExpr === 'false') {
      return celExpr;
    }
    
    // For other expressions, return as-is with a note
    return celExpr;
  }
  
  /**
   * Convert CEL value to JavaScript equivalent
   */
  private convertCelValueToJavaScript(celValue: string): string {
    // Handle string literals
    if (celValue.startsWith('"') && celValue.endsWith('"')) {
      return `'${celValue.slice(1, -1)}'`; // Convert to single quotes for consistency
    }
    
    // Handle resource/schema references
    if (celValue.startsWith('resources.') || celValue.startsWith('schema.')) {
      return celValue;
    }
    
    // Handle numbers, booleans, null
    if (/^\d+(\.\d+)?$/.test(celValue) || 
        celValue === 'true' || 
        celValue === 'false' || 
        celValue === 'null') {
      return celValue;
    }
    
    // For complex values, return as-is
    return celValue;
  }
  
  /**
   * Generate migration summary
   */
  private generateMigrationSummary(
    feasibility: MigrationAnalysisResult['migrationFeasibility'],
    suggestionsByCategory: Map<MigrationCategory, MigrationSuggestion[]>
  ): string {
    const { totalExpressions, migratableExpressions, safeMigrations, overallConfidence } = feasibility;
    
    if (totalExpressions === 0) {
      return 'No CEL expressions found that require migration.';
    }
    
    const migrationRate = Math.round((migratableExpressions / totalExpressions) * 100);
    const safetyRate = Math.round((safeMigrations / totalExpressions) * 100);
    const confidencePercent = Math.round(overallConfidence * 100);
    
    let summary = `Migration Analysis Summary:\n`;
    summary += `- Total CEL expressions: ${totalExpressions}\n`;
    summary += `- Migratable expressions: ${migratableExpressions} (${migrationRate}%)\n`;
    summary += `- Safe migrations: ${safeMigrations} (${safetyRate}%)\n`;
    summary += `- Overall confidence: ${confidencePercent}%\n\n`;
    
    summary += `Breakdown by category:\n`;
    for (const [category, suggestions] of suggestionsByCategory) {
      summary += `- ${category}: ${suggestions.length} expressions\n`;
    }
    
    if (migrationRate >= 80) {
      summary += `\n✅ High migration feasibility - most expressions can be automatically converted.`;
    } else if (migrationRate >= 50) {
      summary += `\n⚠️  Moderate migration feasibility - some expressions may need manual review.`;
    } else {
      summary += `\n❌ Low migration feasibility - many expressions require manual conversion.`;
    }
    
    return summary;
  }
  
  /**
   * Generate migration guide for a specific status builder
   */
  generateMigrationGuide(
    statusMappings: Record<string, any>,
    options: {
      includeExamples?: boolean;
      includeWarnings?: boolean;
      format?: 'markdown' | 'text';
    } = {}
  ): string {
    const { includeExamples = true, includeWarnings = true, format = 'markdown' } = options;
    const analysis = this.analyzeMigrationOpportunities(statusMappings);
    
    let guide = format === 'markdown' ? '# CEL to JavaScript Migration Guide\n\n' : 'CEL to JavaScript Migration Guide\n\n';
    
    guide += `${analysis.summary}\n\n`;
    
    if (analysis.suggestions.length === 0) {
      guide += 'No migration suggestions available.\n';
      return guide;
    }
    
    // Group suggestions by category
    for (const [category, suggestions] of analysis.suggestionsByCategory) {
      if (suggestions.length === 0) continue;
      
      const categoryTitle = this.getCategoryTitle(category);
      guide += format === 'markdown' ? `## ${categoryTitle}\n\n` : `${categoryTitle}:\n\n`;
      
      for (const suggestion of suggestions) {
        guide += format === 'markdown' ? '### ' : '';
        guide += `Original CEL: \`${suggestion.originalCel}\`\n`;
        guide += `Suggested JavaScript: \`${suggestion.suggestedJavaScript}\`\n`;
        guide += `Confidence: ${Math.round(suggestion.confidence * 100)}%\n`;
        guide += `Safe: ${suggestion.isSafe ? 'Yes' : 'No'}\n`;
        
        if (includeExamples && suggestion.exampleUsage) {
          guide += `Example: \`${suggestion.exampleUsage}\`\n`;
        }
        
        if (includeWarnings && suggestion.notes.length > 0) {
          guide += 'Notes:\n';
          for (const note of suggestion.notes) {
            guide += `- ${note}\n`;
          }
        }
        
        guide += '\n';
      }
    }
    
    return guide;
  }
  
  /**
   * Get human-readable category title
   */
  private getCategoryTitle(category: MigrationCategory): string {
    const titles: Record<MigrationCategory, string> = {
      'simple-comparison': 'Simple Comparisons',
      'template-string': 'Template Strings',
      'conditional-expression': 'Conditional Expressions',
      'resource-reference': 'Resource References',
      'schema-reference': 'Schema References',
      'complex-expression': 'Complex Expressions',
      'unsupported': 'Unsupported Expressions'
    };
    
    return titles[category] || category;
  }
}

/**
 * Convenience function to analyze migration opportunities
 */
export function analyzeCelMigrationOpportunities(
  statusMappings: Record<string, any>
): MigrationAnalysisResult {
  const helper = new CelToJavaScriptMigrationHelper();
  return helper.analyzeMigrationOpportunities(statusMappings);
}

/**
 * Convenience function to generate migration guide
 */
export function generateCelMigrationGuide(
  statusMappings: Record<string, any>,
  options?: Parameters<CelToJavaScriptMigrationHelper['generateMigrationGuide']>[1]
): string {
  const helper = new CelToJavaScriptMigrationHelper();
  return helper.generateMigrationGuide(statusMappings, options);
}