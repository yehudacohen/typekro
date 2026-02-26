/**
 * Closure Planner - Analyzes closure dependencies and integrates them into deployment plans
 *
 * Extracted from engine.ts. Pure logic module with no I/O or K8s dependencies.
 */

import type { DependencyGraph, DependencyResolver } from '../dependencies/index.js';
import type {
  ClosureDependencyInfo,
  DeploymentClosure,
  EnhancedDeploymentPlan,
} from '../types/deployment.js';

/**
 * Analyze closure dependencies to determine execution levels
 */
export function analyzeClosureDependencies<TSpec>(
  closures: Record<string, DeploymentClosure>,
  spec: TSpec,
  dependencyGraph: DependencyGraph,
  dependencyResolver: DependencyResolver
): ClosureDependencyInfo[] {
  const closureDependencies: ClosureDependencyInfo[] = [];

  for (const [name, closure] of Object.entries(closures)) {
    const dependencies = extractClosureDependencies(closure, spec);

    // Determine execution level based on dependencies
    // For now, assign all closures to level -1 to ensure they run before all resources
    // This is especially important for closures that install CRDs (like fluxSystem)
    let level = -1;
    if (dependencies.length > 0) {
      for (const depId of dependencies) {
        const depLevel = getResourceLevel(depId, dependencyGraph, dependencyResolver);
        level = Math.max(level, depLevel + 1);
      }
    }

    closureDependencies.push({
      name,
      closure,
      dependencies,
      level,
    });
  }

  return closureDependencies;
}

/**
 * Extract dependencies from a closure by analyzing its configuration
 * This is a simplified implementation - in practice, we would need more sophisticated analysis
 */
function extractClosureDependencies<TSpec>(_closure: DeploymentClosure, _spec: TSpec): string[] {
  // For now, return empty dependencies since closures typically don't depend on Enhanced<> resources
  // In the future, this could analyze closure arguments for resource references
  return [];
}

/**
 * Get the execution level of a resource in the dependency graph
 */
function getResourceLevel(
  resourceId: string,
  dependencyGraph: DependencyGraph,
  dependencyResolver: DependencyResolver
): number {
  const deploymentPlan = dependencyResolver.analyzeDeploymentOrder(dependencyGraph);

  for (let levelIndex = 0; levelIndex < deploymentPlan.levels.length; levelIndex++) {
    const level = deploymentPlan.levels[levelIndex];
    if (level?.includes(resourceId)) {
      return levelIndex;
    }
  }

  return 0;
}

/**
 * Integrate closures into the deployment plan based on their dependencies
 */
export function integrateClosuresIntoPlan(
  deploymentPlan: { levels: string[][]; totalResources: number; maxParallelism: number },
  closureDependencies: ClosureDependencyInfo[]
): EnhancedDeploymentPlan {
  const enhancedLevels: Array<{ resources: string[]; closures: ClosureDependencyInfo[] }> = [];

  // Check if we have any closures at level -1 (pre-resource level)
  const preResourceClosures = closureDependencies.filter((c) => c.level === -1);

  // If we have pre-resource closures, add them as level 0 and shift everything else
  if (preResourceClosures.length > 0) {
    enhancedLevels.push({
      resources: [],
      closures: preResourceClosures,
    });
  }

  // Initialize levels with existing resources (shifted if we added a pre-resource level)
  for (let i = 0; i < deploymentPlan.levels.length; i++) {
    enhancedLevels.push({
      resources: deploymentPlan.levels[i] || [],
      closures: [],
    });
  }

  // Add closures to their appropriate levels (excluding level -1 which we already handled)
  for (const closureInfo of closureDependencies) {
    if (closureInfo.level === -1) {
      continue;
    }

    const adjustedLevel =
      preResourceClosures.length > 0 ? closureInfo.level + 1 : closureInfo.level;

    while (enhancedLevels.length <= adjustedLevel) {
      enhancedLevels.push({ resources: [], closures: [] });
    }

    const targetLevel = enhancedLevels[adjustedLevel];
    if (targetLevel) {
      targetLevel.closures.push(closureInfo);
    }
  }

  return {
    levels: enhancedLevels,
    totalResources: deploymentPlan.totalResources,
    totalClosures: closureDependencies.length,
    maxParallelism: Math.max(
      deploymentPlan.maxParallelism,
      Math.max(...enhancedLevels.map((level) => level.closures.length))
    ),
  };
}
