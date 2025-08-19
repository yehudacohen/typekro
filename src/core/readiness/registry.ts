/**
 * Readiness Evaluator Registry
 * 
 * Provides a global registry for readiness evaluators indexed by Kubernetes resource kind.
 * Factories automatically register their evaluators when withReadinessEvaluator() is called.
 */

import type { ReadinessEvaluator } from '../types/index.js';

interface ReadinessEvaluatorEntry {
  evaluator: ReadinessEvaluator;
  factoryName?: string | undefined;
  resourceKind: string;
  registeredAt: number;
}

export class ReadinessEvaluatorRegistry {
  private static instance: ReadinessEvaluatorRegistry;
  private kindToEvaluator = new Map<string, ReadinessEvaluatorEntry>();

  private constructor() {
    // Private constructor for singleton pattern
  }

  static getInstance(): ReadinessEvaluatorRegistry {
    if (!ReadinessEvaluatorRegistry.instance) {
      ReadinessEvaluatorRegistry.instance = new ReadinessEvaluatorRegistry();
    }
    return ReadinessEvaluatorRegistry.instance;
  }

  /**
   * Register evaluator by resource kind when withReadinessEvaluator is called
   */
  registerForKind(kind: string, evaluator: ReadinessEvaluator, factoryName?: string): void {
    const entry: ReadinessEvaluatorEntry = {
      evaluator,
      factoryName,
      resourceKind: kind,
      registeredAt: Date.now(),
    };

    this.kindToEvaluator.set(kind, entry);
  }

  /**
   * Lookup evaluator by resource kind
   */
  getEvaluatorForKind(kind: string): ReadinessEvaluator | null {
    const entry = this.kindToEvaluator.get(kind);
    return entry?.evaluator || null;
  }

  /**
   * Check if kind has registered evaluator
   */
  hasEvaluatorForKind(kind: string): boolean {
    return this.kindToEvaluator.has(kind);
  }

  /**
   * Get registry statistics for debugging
   */
  getStats(): {
    total: number;
    kinds: string[];
    entries: ReadinessEvaluatorEntry[];
  } {
    const entries = Array.from(this.kindToEvaluator.values());
    return {
      total: entries.length,
      kinds: Array.from(this.kindToEvaluator.keys()),
      entries,
    };
  }

  /**
   * Clear registry (mainly for testing)
   */
  clear(): void {
    this.kindToEvaluator.clear();
  }
}
