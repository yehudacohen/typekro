/**
 * Automatic dependency tracker for KubernetesRef objects in expressions.
 *
 * Tracks resource dependencies, detects circular dependency chains using both
 * simple DFS and Tarjan's strongly connected components algorithm, and computes
 * topologically sorted deployment orders using Kahn's algorithm.
 */

import type { KubernetesRef } from '../../types/common.js';

/**
 * Dependency tracking information for a KubernetesRef
 */
export interface DependencyInfo {
  /** The KubernetesRef object */
  reference: KubernetesRef<unknown>;

  /** The field path where this dependency was found */
  fieldPath: string;

  /** The type of dependency */
  dependencyType: 'schema' | 'resource' | 'external';

  /** Whether this dependency is required for the resource to function */
  required: boolean;

  /** The expected type of the dependency */
  expectedType: string;

  /** Additional metadata about the dependency */
  metadata?: {
    /** Whether this dependency affects resource readiness */
    affectsReadiness?: boolean;

    /** Whether this dependency is used in conditional logic */
    conditional?: boolean;

    /** The expression context where this dependency was found */
    expressionContext?: string;
  };
}

/**
 * Dependency graph for tracking resource relationships
 */
export interface DependencyGraph {
  /** Map of resource ID to its dependencies */
  dependencies: Map<string, DependencyInfo[]>;

  /** Map of resource ID to resources that depend on it */
  dependents: Map<string, string[]>;

  /** Detected circular dependency chains */
  circularChains: string[][];

  /** Topologically sorted resource order (for deployment) */
  deploymentOrder: string[];
}

/**
 * Options for dependency tracking
 */
export interface DependencyTrackingOptions {
  /** Whether to track schema dependencies */
  trackSchemaDependencies?: boolean;

  /** Whether to track resource dependencies */
  trackResourceDependencies?: boolean;

  /** Whether to track external dependencies */
  trackExternalDependencies?: boolean;

  /** Whether to detect circular dependencies */
  detectCircularDependencies?: boolean;

  /** Whether to compute deployment order */
  computeDeploymentOrder?: boolean;

  /** Maximum depth for dependency traversal */
  maxDepth?: number;
}

/**
 * Detailed analysis of circular dependencies
 */
export interface CircularDependencyAnalysis {
  /** Whether circular dependencies were found */
  hasCircularDependencies: boolean;

  /** List of circular dependency chains */
  circularChains: string[][];

  /** Detailed analysis of each chain */
  chainAnalysis: CircularChainAnalysis[];

  /** Recommendations for resolving circular dependencies */
  recommendations: CircularDependencyRecommendation[];
}

/**
 * Analysis of a single circular dependency chain
 */
export interface CircularChainAnalysis {
  /** The resources in the circular chain */
  chain: string[];

  /** Length of the chain */
  chainLength: number;

  /** Severity score (0-1, higher is more severe) */
  severity: number;

  /** Potential break points in the chain */
  breakPoints: string[];

  /** Fields affected by the circular dependency */
  affectedFields: string[];

  /** Risk level assessment */
  riskLevel: 'low' | 'medium' | 'high';
}

/**
 * Recommendation for resolving circular dependencies
 */
export interface CircularDependencyRecommendation {
  /** Type of recommendation */
  type:
    | 'break-optional-dependency'
    | 'refactor-architecture'
    | 'external-configuration'
    | 'conditional-logic';

  /** Human-readable description */
  description: string;

  /** Severity of the issue this addresses */
  severity: 'low' | 'medium' | 'high';

  /** Resources affected by this recommendation */
  affectedResources: string[];

  /** Implementation guidance */
  implementation: string;
}

/**
 * Automatic dependency tracker for KubernetesRef objects in expressions.
 * Implements automatic dependency tracking with circular dependency detection
 * and topological sort for deployment ordering.
 */
export class DependencyTracker {
  private dependencyGraph: DependencyGraph;

  constructor() {
    this.dependencyGraph = {
      dependencies: new Map(),
      dependents: new Map(),
      circularChains: [],
      deploymentOrder: [],
    };
  }

  /**
   * Track dependencies for a resource configuration
   */
  trackDependencies(
    resourceId: string,
    dependencies: KubernetesRef<unknown>[],
    fieldPaths: string[],
    options: DependencyTrackingOptions = {}
  ): DependencyInfo[] {
    const dependencyInfos: DependencyInfo[] = [];

    for (let i = 0; i < dependencies.length; i++) {
      const dep = dependencies[i];
      if (!dep) continue;

      const fieldPath = fieldPaths[i] || `unknown[${i}]`;

      const dependencyInfo = this.createDependencyInfo(dep, fieldPath, options);
      dependencyInfos.push(dependencyInfo);

      // Add to dependency graph
      this.addToDependencyGraph(resourceId, dependencyInfo);
    }

    // Update dependency graph computations
    if (options.detectCircularDependencies) {
      this.detectCircularDependencies();
    }

    if (options.computeDeploymentOrder) {
      this.computeDeploymentOrder();
    }

    return dependencyInfos;
  }

  /**
   * Create dependency information for a KubernetesRef
   */
  private createDependencyInfo(
    ref: KubernetesRef<unknown>,
    fieldPath: string,
    options: DependencyTrackingOptions
  ): DependencyInfo {
    const dependencyType = this.determineDependencyType(ref);

    // Skip tracking based on options
    if (dependencyType === 'schema' && options.trackSchemaDependencies === false) {
      return this.createSkippedDependencyInfo(ref, fieldPath, dependencyType);
    }

    if (dependencyType === 'resource' && options.trackResourceDependencies === false) {
      return this.createSkippedDependencyInfo(ref, fieldPath, dependencyType);
    }

    if (dependencyType === 'external' && options.trackExternalDependencies === false) {
      return this.createSkippedDependencyInfo(ref, fieldPath, dependencyType);
    }

    return {
      reference: ref,
      fieldPath,
      dependencyType,
      required: this.isDependencyRequired(ref, fieldPath),
      expectedType: ref._type ? String(ref._type) : 'unknown',
      metadata: {
        affectsReadiness: this.affectsReadiness(ref, fieldPath),
        conditional: this.isConditional(fieldPath),
        expressionContext: this.getExpressionContext(fieldPath),
      },
    };
  }

  /**
   * Create a skipped dependency info (for disabled tracking)
   */
  private createSkippedDependencyInfo(
    ref: KubernetesRef<unknown>,
    fieldPath: string,
    dependencyType: 'schema' | 'resource' | 'external'
  ): DependencyInfo {
    return {
      reference: ref,
      fieldPath,
      dependencyType,
      required: false,
      expectedType: 'skipped',
      metadata: {
        affectsReadiness: false,
        conditional: false,
        expressionContext: 'skipped',
      },
    };
  }

  /**
   * Determine the type of dependency
   */
  private determineDependencyType(ref: KubernetesRef<unknown>): 'schema' | 'resource' | 'external' {
    if (ref.resourceId === '__schema__') {
      return 'schema';
    }

    // Check if it's a known resource type
    if (ref.resourceId.match(/^[a-z][a-z0-9-]*$/)) {
      return 'resource';
    }

    return 'external';
  }

  /**
   * Determine if a dependency is required
   */
  private isDependencyRequired(ref: KubernetesRef<unknown>, fieldPath: string): boolean {
    // Schema dependencies are generally required
    if (ref.resourceId === '__schema__') {
      return true;
    }

    // Dependencies in required fields are required
    if (this.isRequiredField(fieldPath)) {
      return true;
    }

    // Dependencies in conditional expressions may not be required
    if (this.isConditional(fieldPath)) {
      return false;
    }

    // Default to required for safety
    return true;
  }

  /**
   * Check if a field path represents a required field
   */
  private isRequiredField(fieldPath: string): boolean {
    // Common required fields
    const requiredFields = ['name', 'image', 'namespace'];

    return requiredFields.some((field) => fieldPath.includes(field));
  }

  /**
   * Check if a dependency affects resource readiness
   */
  private affectsReadiness(ref: KubernetesRef<unknown>, fieldPath: string): boolean {
    // Status field dependencies typically affect readiness
    if (ref.fieldPath.startsWith('status.')) {
      return true;
    }

    // Dependencies in readiness-related fields
    const readinessFields = ['ready', 'available', 'replicas', 'conditions'];

    return readinessFields.some(
      (field) => fieldPath.includes(field) || ref.fieldPath.includes(field)
    );
  }

  /**
   * Check if a field path is in a conditional context
   */
  private isConditional(fieldPath: string): boolean {
    // Look for conditional patterns in field path
    return (
      fieldPath.includes('?') ||
      fieldPath.includes('||') ||
      fieldPath.includes('&&') ||
      fieldPath.includes('??')
    );
  }

  /**
   * Get expression context for a field path
   */
  private getExpressionContext(fieldPath: string): string {
    // Extract the top-level field context
    const parts = fieldPath.split('.');
    if (parts.length > 0 && parts[0]) {
      return parts[0];
    }

    return 'unknown';
  }

  /**
   * Add dependency info to the dependency graph
   */
  private addToDependencyGraph(resourceId: string, dependencyInfo: DependencyInfo): void {
    // Add to dependencies map
    if (!this.dependencyGraph.dependencies.has(resourceId)) {
      this.dependencyGraph.dependencies.set(resourceId, []);
    }
    this.dependencyGraph.dependencies.get(resourceId)?.push(dependencyInfo);

    // Add to dependents map (reverse mapping)
    const dependentResourceId = dependencyInfo.reference.resourceId;
    if (dependentResourceId !== '__schema__') {
      if (!this.dependencyGraph.dependents.has(dependentResourceId)) {
        this.dependencyGraph.dependents.set(dependentResourceId, []);
      }

      const dependents = this.dependencyGraph.dependents.get(dependentResourceId);
      if (!dependents) return;
      if (!dependents.includes(resourceId)) {
        dependents.push(resourceId);
      }
    }
  }

  /**
   * Detect circular dependencies in the dependency graph
   */
  private detectCircularDependencies(): void {
    this.dependencyGraph.circularChains = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    // Check each resource for cycles
    for (const resourceId of this.dependencyGraph.dependencies.keys()) {
      if (!visited.has(resourceId)) {
        this.detectCyclesFromResource(resourceId, [], visited, recursionStack);
      }
    }
  }

  /**
   * Detect cycles starting from a specific resource
   */
  private detectCyclesFromResource(
    resourceId: string,
    path: string[],
    visited: Set<string>,
    recursionStack: Set<string>
  ): void {
    if (recursionStack.has(resourceId)) {
      // Found a cycle
      const cycleStart = path.indexOf(resourceId);
      if (cycleStart >= 0) {
        const cycle = path.slice(cycleStart).concat([resourceId]);
        this.dependencyGraph.circularChains.push(cycle);
      }
      return;
    }

    if (visited.has(resourceId)) {
      return;
    }

    visited.add(resourceId);
    recursionStack.add(resourceId);

    // Follow dependencies
    const dependencies = this.dependencyGraph.dependencies.get(resourceId) || [];
    for (const dep of dependencies) {
      if (dep.reference.resourceId !== '__schema__') {
        this.detectCyclesFromResource(
          dep.reference.resourceId,
          [...path, resourceId],
          visited,
          recursionStack
        );
      }
    }

    recursionStack.delete(resourceId);
  }

  /**
   * Compute deployment order using topological sort
   */
  private computeDeploymentOrder(): void {
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    // Initialize in-degree and adjacency list
    for (const [resourceId, dependencies] of this.dependencyGraph.dependencies) {
      if (!inDegree.has(resourceId)) {
        inDegree.set(resourceId, 0);
      }

      if (!adjList.has(resourceId)) {
        adjList.set(resourceId, []);
      }

      for (const dep of dependencies) {
        if (dep.reference.resourceId !== '__schema__') {
          const depResourceId = dep.reference.resourceId;

          if (!inDegree.has(depResourceId)) {
            inDegree.set(depResourceId, 0);
          }

          if (!adjList.has(depResourceId)) {
            adjList.set(depResourceId, []);
          }

          // Add edge from dependency to dependent
          adjList.get(depResourceId)?.push(resourceId);
          const currentDegree = inDegree.get(resourceId) ?? 0;
          inDegree.set(resourceId, currentDegree + 1);
        }
      }
    }

    // Kahn's algorithm for topological sort
    const queue: string[] = [];
    const result: string[] = [];

    // Find all resources with no dependencies
    for (const [resourceId, degree] of inDegree) {
      if (degree === 0) {
        queue.push(resourceId);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      result.push(current);

      // Process all dependents
      const dependents = adjList.get(current) || [];
      for (const dependent of dependents) {
        const newDegree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, newDegree);

        if (newDegree === 0) {
          queue.push(dependent);
        }
      }
    }

    this.dependencyGraph.deploymentOrder = result;
  }

  /**
   * Get the current dependency graph
   */
  getDependencyGraph(): DependencyGraph {
    return { ...this.dependencyGraph };
  }

  /**
   * Get dependencies for a specific resource
   */
  getDependencies(resourceId: string): DependencyInfo[] {
    return this.dependencyGraph.dependencies.get(resourceId) || [];
  }

  /**
   * Get resources that depend on a specific resource
   */
  getDependents(resourceId: string): string[] {
    return this.dependencyGraph.dependents.get(resourceId) || [];
  }

  /**
   * Check if there are circular dependencies
   */
  hasCircularDependencies(): boolean {
    return this.dependencyGraph.circularChains.length > 0;
  }

  /**
   * Get the deployment order
   */
  getDeploymentOrder(): string[] {
    return [...this.dependencyGraph.deploymentOrder];
  }

  /**
   * Reset the dependency graph
   */
  reset(): void {
    this.dependencyGraph = {
      dependencies: new Map(),
      dependents: new Map(),
      circularChains: [],
      deploymentOrder: [],
    };
  }

  /**
   * Advanced circular dependency detection with detailed chain analysis.
   * Uses Tarjan's strongly connected components algorithm for cycle detection.
   */
  detectCircularDependencyChains(): CircularDependencyAnalysis {
    const analysis: CircularDependencyAnalysis = {
      hasCircularDependencies: false,
      circularChains: [],
      chainAnalysis: [],
      recommendations: [],
    };

    // Use Tarjan's strongly connected components algorithm for better cycle detection
    const tarjanResult = this.findStronglyConnectedComponents();

    for (const component of tarjanResult.components) {
      if (component.length > 1) {
        // This is a circular dependency
        analysis.hasCircularDependencies = true;
        analysis.circularChains.push(component);

        // Analyze the chain
        const chainAnalysis = this.analyzeCircularChain(component);
        analysis.chainAnalysis.push(chainAnalysis);

        // Generate recommendations
        const recommendations = this.generateCircularDependencyRecommendations(chainAnalysis);
        analysis.recommendations.push(...recommendations);
      }
    }

    return analysis;
  }

  /**
   * Find strongly connected components using Tarjan's algorithm
   */
  private findStronglyConnectedComponents(): { components: string[][] } {
    const index = new Map<string, number>();
    const lowLink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];
    let currentIndex = 0;

    const strongConnect = (resourceId: string): void => {
      index.set(resourceId, currentIndex);
      lowLink.set(resourceId, currentIndex);
      currentIndex++;
      stack.push(resourceId);
      onStack.add(resourceId);

      // Get dependencies for this resource
      const dependencies = this.dependencyGraph.dependencies.get(resourceId) || [];
      for (const dep of dependencies) {
        const depResourceId = dep.reference.resourceId;
        if (depResourceId === '__schema__') continue; // Skip schema references

        if (!index.has(depResourceId)) {
          strongConnect(depResourceId);
          const resourceLowLink = lowLink.get(resourceId);
          const depLowLink = lowLink.get(depResourceId);
          if (resourceLowLink !== undefined && depLowLink !== undefined) {
            lowLink.set(resourceId, Math.min(resourceLowLink, depLowLink));
          }
        } else if (onStack.has(depResourceId)) {
          const resourceLowLink = lowLink.get(resourceId);
          const depIndex = index.get(depResourceId);
          if (resourceLowLink !== undefined && depIndex !== undefined) {
            lowLink.set(resourceId, Math.min(resourceLowLink, depIndex));
          }
        }
      }

      // If resourceId is a root node, pop the stack and create a component
      if (lowLink.get(resourceId) === index.get(resourceId)) {
        const component: string[] = [];
        let w: string;
        do {
          const popped = stack.pop();
          if (!popped) break;
          w = popped;
          onStack.delete(w);
          component.push(w);
        } while (w !== resourceId);

        components.push(component);
      }
    };

    // Run algorithm on all unvisited nodes
    for (const resourceId of this.dependencyGraph.dependencies.keys()) {
      if (!index.has(resourceId)) {
        strongConnect(resourceId);
      }
    }

    return { components };
  }

  /**
   * Analyze a circular dependency chain
   */
  private analyzeCircularChain(chain: string[]): CircularChainAnalysis {
    const analysis: CircularChainAnalysis = {
      chain,
      chainLength: chain.length,
      severity: this.calculateChainSeverity(chain),
      breakPoints: this.findPotentialBreakPoints(chain),
      affectedFields: this.getAffectedFields(chain),
      riskLevel: 'medium',
    };

    // Determine risk level
    if (analysis.severity > 0.8 || analysis.chainLength > 5) {
      analysis.riskLevel = 'high';
    } else if (analysis.severity < 0.3 && analysis.chainLength <= 2) {
      analysis.riskLevel = 'low';
    }

    return analysis;
  }

  /**
   * Calculate the severity of a circular dependency chain
   */
  private calculateChainSeverity(chain: string[]): number {
    let severity = 0;
    let totalDependencies = 0;

    for (const resourceId of chain) {
      const dependencies = this.dependencyGraph.dependencies.get(resourceId) || [];
      totalDependencies += dependencies.length;

      // Increase severity for required dependencies
      const requiredDeps = dependencies.filter((dep) => dep.required);
      severity += requiredDeps.length * 0.3;

      // Increase severity for readiness-affecting dependencies
      const readinessDeps = dependencies.filter((dep) => dep.metadata?.affectsReadiness);
      severity += readinessDeps.length * 0.2;
    }

    // Normalize by chain length and total dependencies
    return Math.min(severity / (chain.length * Math.max(totalDependencies, 1)), 1);
  }

  /**
   * Find potential break points in a circular chain
   */
  private findPotentialBreakPoints(chain: string[]): string[] {
    const breakPoints: string[] = [];

    for (const resourceId of chain) {
      const dependencies = this.dependencyGraph.dependencies.get(resourceId) || [];

      // Look for optional dependencies that could be break points
      const optionalDeps = dependencies.filter((dep) => !dep.required);
      if (optionalDeps.length > 0) {
        breakPoints.push(resourceId);
      }

      // Look for conditional dependencies
      const conditionalDeps = dependencies.filter((dep) => dep.metadata?.conditional);
      if (conditionalDeps.length > 0) {
        breakPoints.push(resourceId);
      }
    }

    return [...new Set(breakPoints)]; // Remove duplicates
  }

  /**
   * Get affected fields for a circular chain
   */
  private getAffectedFields(chain: string[]): string[] {
    const affectedFields: string[] = [];

    for (const resourceId of chain) {
      const dependencies = this.dependencyGraph.dependencies.get(resourceId) || [];
      for (const dep of dependencies) {
        if (chain.includes(dep.reference.resourceId)) {
          affectedFields.push(`${resourceId}.${dep.fieldPath}`);
        }
      }
    }

    return affectedFields;
  }

  /**
   * Generate recommendations for resolving circular dependencies
   */
  private generateCircularDependencyRecommendations(
    chainAnalysis: CircularChainAnalysis
  ): CircularDependencyRecommendation[] {
    const recommendations: CircularDependencyRecommendation[] = [];

    // Recommend breaking at optional dependencies
    if (chainAnalysis.breakPoints.length > 0) {
      recommendations.push({
        type: 'break-optional-dependency',
        description: `Consider making dependencies optional at: ${chainAnalysis.breakPoints.join(', ')}`,
        severity: 'medium',
        affectedResources: chainAnalysis.breakPoints,
        implementation: 'Use conditional expressions or default values for these dependencies',
      });
    }

    // Recommend refactoring for high-severity chains
    if (chainAnalysis.severity > 0.7) {
      recommendations.push({
        type: 'refactor-architecture',
        description:
          'Consider refactoring the resource architecture to eliminate circular dependencies',
        severity: 'high',
        affectedResources: chainAnalysis.chain,
        implementation:
          'Extract shared dependencies into separate resources or use event-driven patterns',
      });
    }

    // Recommend using external configuration for long chains
    if (chainAnalysis.chainLength > 4) {
      recommendations.push({
        type: 'external-configuration',
        description:
          'Consider using external configuration (ConfigMaps, Secrets) to break the dependency chain',
        severity: 'medium',
        affectedResources: chainAnalysis.chain,
        implementation:
          'Move configuration values to ConfigMaps and reference them instead of cross-resource dependencies',
      });
    }

    return recommendations;
  }
}
