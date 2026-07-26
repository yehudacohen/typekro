import { TypeKroError } from '../errors.js';
import type {
  ReadinessStrategyIdentity,
  RuntimeReadinessClassification,
} from '../planning/types.js';
import type { ReadinessEvaluator } from '../types/kubernetes.js';

type RegisteredStrategy = Extract<ReadinessStrategyIdentity, { kind: 'registered' }>;
type StrategyResolver = (
  configuration: RegisteredStrategy['configuration']
) => ReadinessEvaluator<unknown>;
type EvaluatorFunction = (...args: never[]) => unknown;

const evaluatorStrategies = new WeakMap<EvaluatorFunction, RegisteredStrategy>();
const runtimeClassifications = new WeakMap<EvaluatorFunction, RuntimeReadinessClassification>();
const strategyResolvers = new Map<string, StrategyResolver>();

function strategyKey(id: string, revision: string): string {
  return `${id}@${revision}`;
}

/** Register one stable readiness implementation that can be reconstructed from canonical data. */
export function registerPortableReadinessStrategy(
  id: string,
  revision: string,
  resolver: StrategyResolver
): void {
  const key = strategyKey(id, revision);
  const existing = strategyResolvers.get(key);
  if (existing && existing !== resolver) {
    throw new TypeKroError(
      `Portable readiness strategy ${key} is already registered with a different resolver.`,
      'READINESS_STRATEGY_CONFLICT',
      { id, revision }
    );
  }
  strategyResolvers.set(key, resolver);
}

/**
 * Register one configuration-free deterministic evaluator.
 *
 * This is the concise path for factory-local evaluators whose complete input
 * is the observed Kubernetes object. Parameterized evaluator families should
 * continue to register an explicit resolver and canonical configuration.
 */
export function registerPortableReadinessEvaluator<T>(
  id: string,
  revision: string,
  evaluator: ReadinessEvaluator<T>
): ReadinessEvaluator<T> {
  const resolver: StrategyResolver = () => evaluator as ReadinessEvaluator<unknown>;
  registerPortableReadinessStrategy(id, revision, resolver);
  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id,
    revision,
  });
}

/** Attach stable semantic identity to an evaluator while retaining its normal callable API. */
export function identifyPortableReadinessEvaluator<T>(
  evaluator: ReadinessEvaluator<T>,
  strategy: RegisteredStrategy
): ReadinessEvaluator<T> {
  evaluatorStrategies.set(evaluator, strategy);
  return evaluator;
}

/** Mark an evaluator as intentionally process-local and record why it is not portable. */
export function identifyRuntimeReadinessEvaluator<T>(
  evaluator: ReadinessEvaluator<T>,
  classification: RuntimeReadinessClassification
): ReadinessEvaluator<T> {
  runtimeClassifications.set(evaluator, classification);
  return evaluator;
}

/** Return the serializable strategy represented by an evaluator, when one exists. */
export function getPortableReadinessStrategy(
  evaluator: ReadinessEvaluator<unknown>
): RegisteredStrategy | undefined {
  return evaluatorStrategies.get(evaluator);
}

/** Return the explicit non-portability reason attached to a runtime evaluator. */
export function getRuntimeReadinessClassification(
  evaluator: ReadinessEvaluator<unknown>
): RuntimeReadinessClassification | undefined {
  return runtimeClassifications.get(evaluator);
}

/** Reconstruct a registered evaluator after a canonical artifact JSON round trip. */
export function resolvePortableReadinessStrategy(
  strategy: RegisteredStrategy
): ReadinessEvaluator<unknown> | undefined {
  return strategyResolvers.get(strategyKey(strategy.id, strategy.revision))?.(
    strategy.configuration
  );
}
