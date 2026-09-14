/**
 * The label keys KRO uses to claim ownership of the objects an instance applies.
 *
 * KRO stamps these on every object it applies for a `ResourceGraphDefinition`
 * instance and then uses them to decide what belongs to the instance. Any
 * *other* actor that copies them onto an object KRO did not apply corrupts that
 * bookkeeping — see `KRO_OWNERSHIP_LABELS` for what goes wrong and
 * `labelPropagationGuard()` for the cluster-side mitigation.
 */

/**
 * Label keys that only KRO may introduce on an object.
 *
 * Many operators copy the *entire* label map of the custom resource they
 * reconcile onto the children they create (Hyperspike Valkey does
 * `maps.Clone(valkey.Labels)`; the Altinity ClickHouse operator defaults to
 * `label.include: []`, meaning "include all"). When the parent CR is a node in
 * a KRO graph it carries the labels below, so the operator's children inherit
 * them and KRO then treats objects it never applied as members of its ApplySet.
 *
 * Each key and why it is in the set:
 *
 * - `applyset.kubernetes.io/part-of` — the ApplySet id KRO's pruner selects on.
 *   A child carrying it is listed as an ApplySet member for every GroupKind the
 *   graph declares; because its UID is not in the set KRO applied, the pruner
 *   deletes it on the next requeue, forever (kubernetes-sigs/kro#1153).
 * - `applyset.kubernetes.io/id` — the hashed companion of `part-of` that makes
 *   the ApplySet self-identifying. Copied onto a child it makes that child look
 *   like the ApplySet parent to any ApplySet-aware tooling, so it has to travel
 *   with `part-of` rather than being left behind.
 * - `kro.run/owned` — KRO's own "this object belongs to an instance" marker,
 *   read by KRO's ownership and adoption checks and by TypeKro's hoist guards.
 * - `kro.run/node-id` — the graph node that applied the object. A child that
 *   inherits it claims to be a node it is not, which mis-attributes both KRO's
 *   diffing and TypeKro's deployment-state discovery.
 * - `kro.run/kro-version` — the KRO build that applied the object. This is the
 *   one that bites on *upgrade* rather than on create: bumping KRO rewrites the
 *   value on the parent CR, the operator re-copies the new value onto the
 *   children, and where the operator also derives a `spec.selector` or a pod
 *   template from that same label map, the Service selector moves to a value no
 *   running pod carries. The Service silently loses all endpoints until the
 *   pods are recreated.
 *
 * `app.kubernetes.io/managed-by` is deliberately *not* in this set. KRO 0.9.2
 * overwrites it with `kro` on graph children, but it carries no ownership
 * meaning for the pruner and operators legitimately set it on their own
 * children; stripping it would fight the operator for no safety benefit.
 *
 * @see labelPropagationGuard - installs a cluster-side guard that enforces
 *   "only KRO may introduce these labels".
 */
export const KRO_OWNERSHIP_LABELS = [
  'applyset.kubernetes.io/part-of',
  'applyset.kubernetes.io/id',
  'kro.run/owned',
  'kro.run/node-id',
  'kro.run/kro-version',
] as const;

/** A key from {@link KRO_OWNERSHIP_LABELS}. */
export type KroOwnershipLabel = (typeof KRO_OWNERSHIP_LABELS)[number];

/** Type guard for {@link KRO_OWNERSHIP_LABELS} membership. */
export function isKroOwnershipLabel(key: string): key is KroOwnershipLabel {
  return (KRO_OWNERSHIP_LABELS as readonly string[]).includes(key);
}
