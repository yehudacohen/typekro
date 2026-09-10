/**
 * Shared KRO-mode e2e assertion for issue #193.
 *
 * The invariant every operator-wrapping factory's KRO suite should hold: after
 * an instance is ready, objects KRO applied still carry its ownership labels,
 * and objects it did not apply — the ones the operator created for a KRO-owned
 * parent CR — carry none of them. A violation is what feeds KRO's ApplySet
 * pruner objects it never applied, which it then deletes on every requeue.
 */

import type * as k8s from '@kubernetes/client-node';
import { KRO_OWNERSHIP_LABELS } from '../../src/core/kro/labels.js';
import { createBunCompatibleKubernetesObjectApi } from '../../src/core/kubernetes/index.js';

/** The label KRO stamps on each object with the graph node that applied it. */
const KRO_NODE_ID_LABEL = 'kro.run/node-id';

export interface GroupVersionKind {
  apiVersion: string;
  kind: string;
}

/** The kinds an operator most often creates for a parent CR. */
export const DEFAULT_OWNERSHIP_ASSERTION_KINDS: GroupVersionKind[] = [
  { apiVersion: 'v1', kind: 'Service' },
  { apiVersion: 'v1', kind: 'ConfigMap' },
  { apiVersion: 'v1', kind: 'Secret' },
  { apiVersion: 'v1', kind: 'PersistentVolumeClaim' },
  { apiVersion: 'apps/v1', kind: 'Deployment' },
  { apiVersion: 'apps/v1', kind: 'StatefulSet' },
  { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget' },
];

export interface ForeignApplySetLabelViolation {
  kind: string;
  name: string;
  /** The ownership labels the object carries although KRO did not apply it. */
  labels: Record<string, string>;
  /** Where the offending labels were found. */
  path: 'metadata.labels' | 'spec.selector' | 'spec.template.metadata.labels';
}

export interface AssertNoForeignApplySetLabelsResult {
  /** Objects that carry `kro.run/node-id`, i.e. objects KRO applied. */
  kroApplied: Array<{ kind: string; name: string; nodeId: string }>;
  /** Objects KRO did not apply, which must carry none of the labels. */
  foreign: Array<{ kind: string; name: string }>;
}

interface ListedObject {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    selector?: Record<string, unknown>;
    template?: { metadata?: { labels?: Record<string, string> } };
  };
}

function ownershipLabelsIn(labels: Record<string, string> | undefined): Record<string, string> {
  if (!labels) return {};
  const found: Record<string, string> = {};
  for (const key of KRO_OWNERSHIP_LABELS) {
    const value = labels[key];
    if (value !== undefined) found[key] = value;
  }
  return found;
}

/** A 404 means the group/kind is not served here — anything else is a real failure. */
function isKindNotServed(error: unknown): boolean {
  const code = (error as { statusCode?: number; code?: number; body?: { code?: number } })
    ?.statusCode;
  const bodyCode = (error as { body?: { code?: number } })?.body?.code;
  return code === 404 || bodyCode === 404;
}

/**
 * A Service's `spec.selector` is a plain label map; every other kind's
 * `spec.selector` is a `LabelSelector` and is left alone here.
 */
function serviceSelectorLabels(kind: string, object: ListedObject): Record<string, string> {
  if (kind !== 'Service') return {};
  const selector = object.spec?.selector;
  if (!selector) return {};
  const stringEntries: Record<string, string> = {};
  for (const [key, value] of Object.entries(selector)) {
    if (typeof value === 'string') stringEntries[key] = value;
  }
  return ownershipLabelsIn(stringEntries);
}

/**
 * List `kinds` in `namespace` and assert that no object KRO did not apply
 * carries any label from {@link KRO_OWNERSHIP_LABELS} — on the object itself,
 * on a Service's selector, or on a workload's pod template — while objects KRO
 * did apply still carry them.
 *
 * "KRO applied it" is read from `kro.run/node-id`: KRO stamps the graph node id
 * on everything in its applied set, so an object without it was created by
 * something else. An operator child that inherited the parent's whole label map
 * therefore shows up as an object with `node-id` *and* an applyset id it has no
 * right to — which is why the node-id label alone is not the test; the check is
 * that the object's provenance and its ownership labels agree.
 *
 * @param kubeConfig connection to the cluster under test
 * @param namespace namespace the instance's objects live in
 * @param kinds group/kinds to sweep; defaults to
 *   {@link DEFAULT_OWNERSHIP_ASSERTION_KINDS}
 * @param expectedNodeIds when given, the graph node ids the instance declares.
 *   An object whose `kro.run/node-id` is not in this set was not applied by
 *   this instance even though it carries the label, i.e. an operator copied it.
 */
export async function assertNoForeignApplySetLabels(
  kubeConfig: k8s.KubeConfig,
  namespace: string,
  kinds: GroupVersionKind[] = DEFAULT_OWNERSHIP_ASSERTION_KINDS,
  expectedNodeIds?: readonly string[]
): Promise<AssertNoForeignApplySetLabelsResult> {
  const api = createBunCompatibleKubernetesObjectApi(kubeConfig);

  const violations: ForeignApplySetLabelViolation[] = [];
  const result: AssertNoForeignApplySetLabelsResult = { kroApplied: [], foreign: [] };
  const knownNodeIds = expectedNodeIds ? new Set(expectedNodeIds) : undefined;

  for (const { apiVersion, kind } of kinds) {
    let items: ListedObject[];
    try {
      const listed = await api.list(apiVersion, kind, namespace);
      items = ((listed as { items?: ListedObject[] }).items ?? []) as ListedObject[];
    } catch (error) {
      // Only a kind the cluster does not serve may be skipped. Swallowing
      // anything else would turn a broken client into a passing assertion.
      if (isKindNotServed(error)) continue;
      throw new Error(
        `Failed to list ${apiVersion} ${kind} in namespace "${namespace}": ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }

    for (const object of items) {
      const name = object.metadata?.name ?? '<unnamed>';
      const nodeId = object.metadata?.labels?.[KRO_NODE_ID_LABEL];
      const appliedByThisInstance =
        nodeId !== undefined && (knownNodeIds === undefined || knownNodeIds.has(nodeId));

      if (appliedByThisInstance) {
        result.kroApplied.push({ kind, name, nodeId: nodeId as string });
        continue;
      }

      result.foreign.push({ kind, name });

      const metadataLabels = ownershipLabelsIn(object.metadata?.labels);
      if (Object.keys(metadataLabels).length > 0) {
        violations.push({ kind, name, labels: metadataLabels, path: 'metadata.labels' });
      }

      const selectorLabels = serviceSelectorLabels(kind, object);
      if (Object.keys(selectorLabels).length > 0) {
        violations.push({ kind, name, labels: selectorLabels, path: 'spec.selector' });
      }

      const templateLabels = ownershipLabelsIn(object.spec?.template?.metadata?.labels);
      if (Object.keys(templateLabels).length > 0) {
        violations.push({
          kind,
          name,
          labels: templateLabels,
          path: 'spec.template.metadata.labels',
        });
      }
    }
  }

  if (violations.length > 0) {
    const detail = violations
      .map(
        (violation) =>
          `  ${violation.kind}/${violation.name} ${violation.path}: ` +
          `${Object.keys(violation.labels).join(', ')}`
      )
      .join('\n');
    throw new Error(
      `Objects in namespace "${namespace}" that KRO did not apply carry KRO ownership labels.\n` +
        `KRO's ApplySet pruner will delete them on every requeue (kubernetes-sigs/kro#1153).\n` +
        `${detail}\n` +
        'Fix in order: the always-on label-propagation guard (typeKroRuntimeBootstrap, #193), ' +
        "the operator's own propagation filter configured from KRO_OWNERSHIP_LABELS, or " +
        'isolating the CR in its own single-kind ResourceGraphDefinition.'
    );
  }

  return result;
}

/**
 * Assert the complement: the objects KRO applied still carry the ownership
 * labels. Stripping them from KRO's own writes breaks ownership the other way.
 */
export function assertKroAppliedObjectsKeepOwnershipLabels(
  objects: Array<{ kind: string; name: string; labels?: Record<string, string> }>
): void {
  const missing = objects.filter(
    (object) => object.labels?.['applyset.kubernetes.io/part-of'] === undefined
  );
  if (missing.length > 0) {
    throw new Error(
      'KRO-applied objects lost their ApplySet label — the guard must never ' +
        `strip labels from KRO's own writes: ${missing
          .map((object) => `${object.kind}/${object.name}`)
          .join(', ')}`
    );
  }
}
