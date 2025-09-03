/**
 * Source mapping utilities for JavaScript to CEL expression conversion
 * Tracks original expressions and their converted CEL equivalents for debugging
 */

/**
 * Represents a single source mapping entry
 */
export interface SourceMapEntry {
  /** The original JavaScript expression */
  originalExpression: string;
  /** The converted CEL expression */
  celExpression: string;
  /** Source location in the original code */
  sourceLocation: {
    line: number;
    column: number;
    length: number;
  };
  /** Context where the expression was found */
  context: 'status' | 'resource' | 'condition' | 'readiness';
  /** Unique identifier for this mapping */
  id: string;
  /** Timestamp when the mapping was created */
  timestamp: number;
  /** Additional metadata about the conversion */
  metadata?: {
    expressionType: 'javascript' | 'template-literal' | 'function-call' | 'member-access' | 'binary-operation' | 'conditional' | 'optional-chaining' | 'nullish-coalescing';
    kubernetesRefs?: string[];
    dependencies?: string[];
    conversionNotes?: string[];
  };
}

/**
 * Builds and manages source mappings for expression conversion
 */
export class SourceMapBuilder {
  private entries: SourceMapEntry[] = [];
  private idCounter = 0;

  /**
   * Add a new source mapping entry
   */
  addMapping(
    originalExpression: string,
    celExpression: string,
    sourceLocation: { line: number; column: number; length: number },
    context: 'status' | 'resource' | 'condition' | 'readiness',
    metadata?: SourceMapEntry['metadata']
  ): string {
    const id = `mapping_${++this.idCounter}`;
    
    const entry: SourceMapEntry = {
      id,
      originalExpression,
      celExpression,
      sourceLocation,
      context,
      timestamp: Date.now(),
      ...(metadata && { metadata }),
    };

    this.entries.push(entry);
    return id;
  }

  /**
   * Add a mapping with automatic ID generation from expression content
   */
  addMappingWithAutoId(
    originalExpression: string,
    celExpression: string,
    sourceLocation: { line: number; column: number; length: number },
    context: 'status' | 'resource' | 'condition' | 'readiness',
    metadata?: SourceMapEntry['metadata']
  ): string {
    // Generate a more descriptive ID based on content
    const sanitizedExpr = originalExpression
      .replace(/[^a-zA-Z0-9]/g, '_')
      .substring(0, 20);
    const id = `${context}_${sanitizedExpr}_${this.idCounter++}`;
    
    const entry: SourceMapEntry = {
      id,
      originalExpression,
      celExpression,
      sourceLocation,
      context,
      timestamp: Date.now(),
      ...(metadata && { metadata }),
    };

    this.entries.push(entry);
    return id;
  }

  /**
   * Get all source mapping entries
   */
  getEntries(): SourceMapEntry[] {
    return [...this.entries];
  }

  /**
   * Get a specific mapping by ID
   */
  getMapping(id: string): SourceMapEntry | undefined {
    return this.entries.find(entry => entry.id === id);
  }

  /**
   * Get mappings by context
   */
  getMappingsByContext(context: 'status' | 'resource' | 'condition' | 'readiness'): SourceMapEntry[] {
    return this.entries.filter(entry => entry.context === context);
  }

  /**
   * Get mappings that contain specific KubernetesRef objects
   */
  getMappingsWithKubernetesRef(resourceId: string): SourceMapEntry[] {
    return this.entries.filter(entry => 
      entry.metadata?.kubernetesRefs?.some(ref => ref.includes(resourceId))
    );
  }

  /**
   * Find the original expression for a given CEL expression
   */
  findOriginalExpression(celExpression: string): SourceMapEntry | undefined {
    return this.entries.find(entry => entry.celExpression === celExpression);
  }

  /**
   * Find mappings by source location
   */
  findMappingsByLocation(line: number, column?: number): SourceMapEntry[] {
    return this.entries.filter(entry => {
      if (entry.sourceLocation.line !== line) return false;
      if (column !== undefined) {
        const start = entry.sourceLocation.column;
        const end = start + entry.sourceLocation.length;
        return column >= start && column <= end;
      }
      return true;
    });
  }

  /**
   * Clear all mappings
   */
  clear(): void {
    this.entries = [];
    this.idCounter = 0;
  }

  /**
   * Get the total number of mappings
   */
  size(): number {
    return this.entries.length;
  }

  /**
   * Export mappings to a JSON-serializable format
   */
  export(): SourceMapExport {
    return {
      version: '1.0',
      generator: 'TypeKro JavaScript to CEL Converter',
      timestamp: Date.now(),
      entries: this.entries,
      statistics: {
        totalMappings: this.entries.length,
        contextBreakdown: this.getContextStatistics(),
        expressionTypeBreakdown: this.getExpressionTypeStatistics(),
      },
    };
  }

  /**
   * Import mappings from a JSON format
   */
  import(data: SourceMapExport): void {
    if (data.version !== '1.0') {
      throw new Error(`Unsupported source map version: ${data.version}`);
    }

    this.entries = [...data.entries];
    this.idCounter = Math.max(...this.entries.map(e => {
      const match = e.id.match(/(\d+)$/);
      return match?.[1] ? parseInt(match[1], 10) : 0;
    }), 0);
  }

  /**
   * Merge mappings from another SourceMapBuilder
   */
  merge(other: SourceMapBuilder): void {
    const otherEntries = other.getEntries();
    
    // Adjust IDs to avoid conflicts
    const maxId = Math.max(...this.entries.map(e => {
      const match = e.id.match(/(\d+)$/);
      return match?.[1] ? parseInt(match[1], 10) : 0;
    }), 0);

    otherEntries.forEach((entry, index) => {
      const newEntry: SourceMapEntry = {
        ...entry,
        id: `merged_${maxId + index + 1}`,
      };
      this.entries.push(newEntry);
    });

    this.idCounter = Math.max(this.idCounter, maxId + otherEntries.length);
  }

  /**
   * Create a debug report of all mappings
   */
  createDebugReport(): string {
    const report = [
      '=== JavaScript to CEL Source Map Debug Report ===',
      `Generated: ${new Date().toISOString()}`,
      `Total Mappings: ${this.entries.length}`,
      '',
    ];

    // Group by context
    const byContext = this.groupByContext();
    
    for (const [context, entries] of Object.entries(byContext)) {
      report.push(`## ${context.toUpperCase()} Context (${entries.length} mappings)`);
      report.push('');

      entries.forEach((entry, index) => {
        report.push(`### ${index + 1}. ${entry.id}`);
        report.push(`**Location**: Line ${entry.sourceLocation.line}, Column ${entry.sourceLocation.column}`);
        report.push(`**Original**: \`${entry.originalExpression}\``);
        report.push(`**CEL**: \`${entry.celExpression}\``);
        
        if (entry.metadata?.expressionType) {
          report.push(`**Type**: ${entry.metadata.expressionType}`);
        }
        
        if (entry.metadata?.kubernetesRefs?.length) {
          report.push(`**KubernetesRefs**: ${entry.metadata.kubernetesRefs.join(', ')}`);
        }
        
        if (entry.metadata?.dependencies?.length) {
          report.push(`**Dependencies**: ${entry.metadata.dependencies.join(', ')}`);
        }
        
        if (entry.metadata?.conversionNotes?.length) {
          report.push(`**Notes**: ${entry.metadata.conversionNotes.join('; ')}`);
        }
        
        report.push('');
      });
    }

    // Add statistics
    report.push('## Statistics');
    report.push('');
    
    const contextStats = this.getContextStatistics();
    report.push('**By Context:**');
    Object.entries(contextStats).forEach(([context, count]) => {
      report.push(`- ${context}: ${count}`);
    });
    
    const typeStats = this.getExpressionTypeStatistics();
    report.push('');
    report.push('**By Expression Type:**');
    Object.entries(typeStats).forEach(([type, count]) => {
      report.push(`- ${type}: ${count}`);
    });

    return report.join('\n');
  }

  /**
   * Get statistics by context
   */
  private getContextStatistics(): Record<string, number> {
    const stats: Record<string, number> = {};
    this.entries.forEach(entry => {
      stats[entry.context] = (stats[entry.context] || 0) + 1;
    });
    return stats;
  }

  /**
   * Get statistics by expression type
   */
  private getExpressionTypeStatistics(): Record<string, number> {
    const stats: Record<string, number> = {};
    this.entries.forEach(entry => {
      const type = entry.metadata?.expressionType || 'unknown';
      stats[type] = (stats[type] || 0) + 1;
    });
    return stats;
  }

  /**
   * Group entries by context
   */
  private groupByContext(): Record<string, SourceMapEntry[]> {
    const groups: Record<string, SourceMapEntry[]> = {};
    this.entries.forEach(entry => {
      if (!groups[entry.context]) {
        groups[entry.context] = [];
      }
      groups[entry.context]?.push(entry);
    });
    return groups;
  }
}

/**
 * Exported source map format
 */
export interface SourceMapExport {
  version: string;
  generator: string;
  timestamp: number;
  entries: SourceMapEntry[];
  statistics: {
    totalMappings: number;
    contextBreakdown: Record<string, number>;
    expressionTypeBreakdown: Record<string, number>;
  };
}

/**
 * Utility functions for working with source maps
 */
export class SourceMapUtils {
  /**
   * Create a source location from AST node location
   */
  static createSourceLocation(
    astLocation: { start: { line: number; column: number }; end: { line: number; column: number } } | undefined,
    sourceText: string
  ): { line: number; column: number; length: number } {
    if (!astLocation) {
      return { line: 1, column: 1, length: sourceText.length };
    }

    const length = astLocation.end.line === astLocation.start.line
      ? astLocation.end.column - astLocation.start.column
      : sourceText.length; // Multi-line expressions use full length

    return {
      line: astLocation.start.line,
      column: astLocation.start.column,
      length,
    };
  }

  /**
   * Extract KubernetesRef paths from an expression
   */
  static extractKubernetesRefPaths(expression: string): string[] {
    const refs: string[] = [];
    
    // Match patterns like resources.deployment.status.field or schema.spec.field
    const resourcePattern = /(?:resources|schema)\.[\w.]+/g;
    const matches = expression.match(resourcePattern);
    
    if (matches) {
      refs.push(...matches);
    }

    return refs;
  }

  /**
   * Determine expression type from AST node type
   */
  static determineExpressionType(nodeType: string): NonNullable<SourceMapEntry['metadata']>['expressionType'] {
    switch (nodeType) {
      case 'BinaryExpression':
        return 'binary-operation';
      case 'MemberExpression':
        return 'member-access';
      case 'ConditionalExpression':
        return 'conditional';
      case 'TemplateLiteral':
        return 'template-literal';
      case 'CallExpression':
        return 'function-call';
      default:
        return 'javascript';
    }
  }

  /**
   * Create a formatted error message with source mapping context
   */
  static createErrorWithSourceMap(
    error: Error,
    sourceMap: SourceMapBuilder,
    celExpression?: string
  ): string {
    let message = error.message;

    if (celExpression) {
      const mapping = sourceMap.findOriginalExpression(celExpression);
      if (mapping) {
        message += `\n\nSource Mapping:`;
        message += `\n  Original: ${mapping.originalExpression}`;
        message += `\n  Location: Line ${mapping.sourceLocation.line}, Column ${mapping.sourceLocation.column}`;
        message += `\n  Context: ${mapping.context}`;
        
        if (mapping.metadata?.expressionType) {
          message += `\n  Type: ${mapping.metadata.expressionType}`;
        }
      }
    }

    return message;
  }

  /**
   * Validate source map integrity
   */
  static validateSourceMap(sourceMap: SourceMapBuilder): string[] {
    const issues: string[] = [];
    const entries = sourceMap.getEntries();

    // Check for duplicate IDs
    const ids = new Set<string>();
    entries.forEach(entry => {
      if (ids.has(entry.id)) {
        issues.push(`Duplicate mapping ID: ${entry.id}`);
      }
      ids.add(entry.id);
    });

    // Check for invalid source locations
    entries.forEach(entry => {
      if (entry.sourceLocation.line < 1) {
        issues.push(`Invalid line number in mapping ${entry.id}: ${entry.sourceLocation.line}`);
      }
      if (entry.sourceLocation.column < 0) {
        issues.push(`Invalid column number in mapping ${entry.id}: ${entry.sourceLocation.column}`);
      }
      if (entry.sourceLocation.length < 0) {
        issues.push(`Invalid length in mapping ${entry.id}: ${entry.sourceLocation.length}`);
      }
    });

    // Check for empty expressions
    entries.forEach(entry => {
      if (!entry.originalExpression.trim()) {
        issues.push(`Empty original expression in mapping ${entry.id}`);
      }
      if (!entry.celExpression.trim()) {
        issues.push(`Empty CEL expression in mapping ${entry.id}`);
      }
    });

    return issues;
  }
}