/**
 * Readiness of the Agent Substrate installation, written once as CEL.
 *
 * Each predicate below is the readiness of one kind of object. The resource-level evaluator runs
 * it over the live object with cel-js, and the composition's root `status.ready` is the
 * conjunction of the same predicates over every installation object, so the two cannot
 * disagree. Every field access is guarded by `has()` in a lazy ternary, because cel-js reports
 * an error for a missing field (see the Traefik bootstrap's load-balancer projection for the
 * cel-go and cel-js differences this avoids).
 */
import { evaluate } from 'cel-js';
import { registerPortableReadinessEvaluator } from '../../core/readiness/index.js';
import type { ReadinessEvaluator, ResourceStatus } from '../../core/types/index.js';

export type SubstrateReadinessKind =
  | 'CustomResourceDefinition'
  | 'Deployment'
  | 'DaemonSet'
  | 'SandboxConfig'
  | 'WorkerPool';

const guard = (condition: string, then: string) => `(${condition} ? (${then}) : false)`;
const count = (self: string, field: string) =>
  `(has(${self}.status.${field}) ? ${self}.status.${field} : 0)`;
const notDeleting = (self: string) => `!has(${self}.metadata.deletionTimestamp)`;
const observedCurrent = (self: string) =>
  guard(
    `has(${self}.status.observedGeneration) && has(${self}.metadata.generation)`,
    `${self}.status.observedGeneration == ${self}.metadata.generation`
  );

/** The readiness predicate of a `kind` object named by the CEL identifier `self`. */
export function substrateReadyCel(kind: SubstrateReadinessKind, self: string): string {
  switch (kind) {
    case 'CustomResourceDefinition':
      return `${notDeleting(self)} && ${guard(
        `has(${self}.status)`,
        guard(
          `has(${self}.status.conditions)`,
          ['Established', 'NamesAccepted']
            .map(
              (type) =>
                `${self}.status.conditions.exists(c, c.type == '${type}' && c.status == 'True')`
            )
            .join(' && ')
        )
      )}`;
    case 'Deployment': {
      // The current generation is observed and every desired pod is updated, ready and available,
      // with no pod of an older ReplicaSet left. Zero desired replicas is ready once observed.
      const desired = `(has(${self}.spec.replicas) ? ${self}.spec.replicas : 1)`;
      return `${notDeleting(self)} && ${guard(
        `has(${self}.status)`,
        [
          observedCurrent(self),
          ...['replicas', 'updatedReplicas', 'readyReplicas', 'availableReplicas'].map(
            (field) => `${count(self, field)} == ${desired}`
          ),
        ].join(' && ')
      )}`;
    }
    case 'DaemonSet': {
      // As `kubectl rollout status`: every scheduled pod is updated, ready and available.
      const desired = count(self, 'desiredNumberScheduled');
      return `${notDeleting(self)} && ${guard(
        `has(${self}.status)`,
        [
          observedCurrent(self),
          ...['updatedNumberScheduled', 'numberReady', 'numberAvailable'].map(
            (field) => `${count(self, field)} == ${desired}`
          ),
        ].join(' && ')
      )}`;
    }
    case 'SandboxConfig':
      // No status subresource; its asset pins are checked when the bundle is built.
      return notDeleting(self);
    case 'WorkerPool': {
      // Every pod is ready, and each sandbox class has resolved this generation to the named
      // config (or, with no configRef, to the class default) with no config switch pending.
      // A pool of zero replicas is ready once its classes resolve.
      const resolved = `c.name == w.name && !has(c.pendingConfigRef) && ${guard(
        'has(c.configRef)',
        '(has(w.configRef) ? c.configRef.name == w.configRef.name : true)'
      )} && ${guard(
        'has(c.conditions)',
        `c.conditions.exists(k, k.type == 'Resolved' && k.status == 'True' && ${guard(
          `has(k.observedGeneration) && has(${self}.metadata.generation)`,
          `k.observedGeneration == ${self}.metadata.generation`
        )})`
      )}`;
      return `${notDeleting(self)} && ${guard(
        `has(${self}.status)`,
        [
          `${count(self, 'replicas')} == ${self}.spec.replicas`,
          `${count(self, 'readyReplicas')} == ${self}.spec.replicas`,
          guard(
            `has(${self}.status.sandboxClasses) && has(${self}.spec.sandboxClasses)`,
            `${self}.spec.sandboxClasses.all(w, ${self}.status.sandboxClasses.exists(c, ${resolved}))`
          ),
        ].join(' && ')
      )}`;
    }
  }
}

const REASONS: Record<SubstrateReadinessKind, string> = {
  CustomResourceDefinition: 'CustomResourceDefinitionNotEstablished',
  Deployment: 'RolloutPending',
  DaemonSet: 'NodeRolloutPending',
  SandboxConfig: 'SandboxConfigDeleting',
  WorkerPool: 'WorkerPoolNotReady',
};

function evaluator(kind: SubstrateReadinessKind): ReadinessEvaluator<unknown> {
  const expression = substrateReadyCel(kind, 'self');
  return registerPortableReadinessEvaluator(
    `typekro.readiness.agent-substrate.${kind}`,
    '2',
    (self: unknown): ResourceStatus => {
      let ready = false;
      try {
        ready = evaluate(expression, { self: self as Record<string, unknown> }) === true;
      } catch {
        ready = false;
      }
      return ready ? { ready } : { ready, reason: REASONS[kind] };
    }
  );
}

/** Resource-level evaluators, one per kind, running {@link substrateReadyCel}. */
export const substrateReadiness: Readonly<
  Record<SubstrateReadinessKind, ReadinessEvaluator<unknown>>
> = {
  CustomResourceDefinition: evaluator('CustomResourceDefinition'),
  Deployment: evaluator('Deployment'),
  DaemonSet: evaluator('DaemonSet'),
  SandboxConfig: evaluator('SandboxConfig'),
  WorkerPool: evaluator('WorkerPool'),
};
