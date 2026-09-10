/**
 * The KRO label-propagation guard.
 *
 * Enforces one invariant on the cluster: **only KRO may introduce KRO's
 * ownership labels on an object**. See `KRO_OWNERSHIP_LABELS` for why that
 * matters and `docs/advanced/integration-skill.md` for the operator-side
 * alternatives.
 *
 * The guard is one `MutatingAdmissionPolicy` plus one
 * `MutatingAdmissionPolicyBinding`. It is installed by
 * `typeKroRuntimeBootstrap()`, which knows KRO's namespace and controller
 * ServiceAccount because it installed them — the exemption is computed, not
 * guessed.
 */

import { KRO_OWNERSHIP_LABELS } from '../../../core/kro/labels.js';
import type { Enhanced } from '../../../core/types/index.js';
import {
  type MutatingAdmissionPolicyApiVersion,
  type MutatingAdmissionPolicyBindingSpec,
  type MutatingAdmissionPolicyBindingStatus,
  mutatingAdmissionPolicy,
  mutatingAdmissionPolicyBinding,
  type MutatingAdmissionPolicySpec,
  type MutatingAdmissionPolicyStatus,
} from './mutating-admission-policy.js';

/** Default name shared by the policy and its binding. */
export const LABEL_PROPAGATION_GUARD_NAME = 'typekro-kro-label-propagation-guard';

/** Default name of the KRO controller ServiceAccount created by the KRO chart. */
export const DEFAULT_KRO_SERVICE_ACCOUNT = 'kro';

/**
 * The resources the guard watches.
 *
 * These are the kinds operators actually create for a parent CR and that a KRO
 * graph is likely to declare, so they are the kinds whose accidental ApplySet
 * membership gets them pruned. The list is a constant rather than an option:
 * the guard is always-on and every consumer should get the same floor. Extend
 * it here — the CEL is written to tolerate any kind, so adding a rule needs no
 * expression change.
 */
export const LABEL_PROPAGATION_GUARD_RESOURCE_RULES = [
  {
    apiGroups: [''],
    apiVersions: ['v1'],
    operations: ['CREATE', 'UPDATE'],
    resources: ['services', 'configmaps', 'secrets', 'persistentvolumeclaims'],
  },
  {
    apiGroups: ['apps'],
    apiVersions: ['v1'],
    operations: ['CREATE', 'UPDATE'],
    resources: ['statefulsets', 'deployments'],
  },
  {
    apiGroups: ['policy'],
    apiVersions: ['v1'],
    operations: ['CREATE', 'UPDATE'],
    resources: ['poddisruptionbudgets'],
  },
] as const satisfies NonNullable<
  NonNullable<MutatingAdmissionPolicySpec['matchConstraints']>['resourceRules']
>;

export interface LabelPropagationGuardOptions {
  /**
   * Name shared by the policy and the binding.
   * @default LABEL_PROPAGATION_GUARD_NAME
   */
  name?: string;
  /** Namespace the KRO controller runs in — used to build the exempt username. */
  kroNamespace: string;
  /**
   * KRO controller ServiceAccount name.
   * @default DEFAULT_KRO_SERVICE_ACCOUNT
   */
  kroServiceAccount?: string;
  /**
   * Extra usernames that may introduce the labels. Every entry is a full
   * Kubernetes username, e.g. `system:serviceaccount:<ns>:<sa>`.
   */
  additionalExemptCallers?: readonly string[];
  /**
   * Group version to render. Beta clusters (1.34, 1.35) serve
   * `admissionregistration.k8s.io/v1beta1`; 1.36+ serves `.../v1`.
   * @default 'admissionregistration.k8s.io/v1'
   */
  apiVersion?: MutatingAdmissionPolicyApiVersion;
  /** Resource graph id of the policy. @default 'labelPropagationGuardPolicy' */
  policyId?: string;
  /** Resource graph id of the binding. @default 'labelPropagationGuardBinding' */
  bindingId?: string;
}

export interface LabelPropagationGuard {
  policy: Enhanced<MutatingAdmissionPolicySpec, MutatingAdmissionPolicyStatus>;
  binding: Enhanced<MutatingAdmissionPolicyBindingSpec, MutatingAdmissionPolicyBindingStatus>;
}

/** Render a CEL list literal of double-quoted strings. */
function celStringList(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

/** Build the `system:serviceaccount:<ns>:<sa>` username KRO's controller uses. */
export function serviceAccountUsername(namespace: string, serviceAccount: string): string {
  return `system:serviceaccount:${namespace}:${serviceAccount}`;
}

/**
 * Build the guard's CEL variables.
 *
 * The whole policy rests on one derived list per patch target:
 *
 * ```
 * guardedLabels.filter(k, k in <new> && !(k in <old>))
 * ```
 *
 * On CREATE `oldObject` is null, so `<old>` is `{}` and the filter reduces to
 * "remove it if it is present". On UPDATE `<old>` is the caller's `oldObject`,
 * so a label KRO already placed is never touched and only a label the caller is
 * *introducing* is removed. That is the invariant, stated once and reused for
 * `metadata.labels`, a Service's `spec.selector`, and a workload's selector and
 * pod-template labels.
 *
 * Two CEL details this relies on:
 *
 * - `has(a.b)` errors when `a` itself is missing, so every path is guarded
 *   left-to-right (`has(object.spec) && has(object.spec.template) && ...`).
 *   `&&` absorbs errors from the right-hand side, so the kind gate short-
 *   circuits the whole chain for kinds that have no such field.
 * - `object` and `oldObject` are unstructured, so `in` works on any object
 *   field, but a Deployment's `spec.selector` is a `LabelSelector` and a
 *   Service's is a plain map. The `isService` / `isWorkload` gates keep those
 *   two shapes apart rather than relying on `in` returning false.
 */
function buildGuardVariables(): NonNullable<MutatingAdmissionPolicySpec['variables']> {
  return [
    { name: 'guardedLabels', expression: celStringList(KRO_OWNERSHIP_LABELS) },
    {
      name: 'newLabels',
      expression: 'has(object.metadata.labels) ? object.metadata.labels : {}',
    },
    {
      name: 'oldLabels',
      expression:
        'oldObject != null && has(oldObject.metadata.labels) ? oldObject.metadata.labels : {}',
    },
    {
      name: 'isService',
      expression: 'request.resource.group == "" && request.resource.resource == "services"',
    },
    {
      name: 'isWorkload',
      expression:
        'request.resource.group == "apps" && (request.resource.resource == "deployments" || request.resource.resource == "statefulsets")',
    },
    {
      name: 'newServiceSelector',
      expression:
        'variables.isService && has(object.spec) && has(object.spec.selector) ? object.spec.selector : {}',
    },
    {
      name: 'oldServiceSelector',
      expression:
        'variables.isService && oldObject != null && has(oldObject.spec) && has(oldObject.spec.selector) ? oldObject.spec.selector : {}',
    },
    // A workload's `spec.selector` is immutable after create, so the strip only
    // ever fires on CREATE. It has to fire there: stripping a label from the
    // pod template while leaving it in `matchLabels` would make the object
    // invalid ("selector does not match template labels") and the create would
    // be rejected outright.
    {
      name: 'newMatchLabels',
      expression:
        'variables.isWorkload && has(object.spec) && has(object.spec.selector) && has(object.spec.selector.matchLabels) ? object.spec.selector.matchLabels : {}',
    },
    {
      name: 'oldMatchLabels',
      expression:
        'variables.isWorkload && oldObject != null && has(oldObject.spec) && has(oldObject.spec.selector) && has(oldObject.spec.selector.matchLabels) ? oldObject.spec.selector.matchLabels : {}',
    },
    {
      name: 'newTemplateLabels',
      expression:
        'variables.isWorkload && has(object.spec) && has(object.spec.template) && has(object.spec.template.metadata) && has(object.spec.template.metadata.labels) ? object.spec.template.metadata.labels : {}',
    },
    {
      name: 'oldTemplateLabels',
      expression:
        'variables.isWorkload && oldObject != null && has(oldObject.spec) && has(oldObject.spec.template) && has(oldObject.spec.template.metadata) && has(oldObject.spec.template.metadata.labels) ? oldObject.spec.template.metadata.labels : {}',
    },
    {
      name: 'metadataStrip',
      expression:
        'variables.guardedLabels.filter(k, k in variables.newLabels && !(k in variables.oldLabels))',
    },
    {
      name: 'serviceSelectorStrip',
      expression:
        'variables.guardedLabels.filter(k, k in variables.newServiceSelector && !(k in variables.oldServiceSelector))',
    },
    {
      name: 'matchLabelsStrip',
      expression:
        'variables.guardedLabels.filter(k, k in variables.newMatchLabels && !(k in variables.oldMatchLabels))',
    },
    {
      name: 'templateStrip',
      expression:
        'variables.guardedLabels.filter(k, k in variables.newTemplateLabels && !(k in variables.oldTemplateLabels))',
    },
  ];
}

/**
 * The single JSONPatch expression.
 *
 * Every `remove` is produced from a `*Strip` list that was already filtered to
 * keys present on the incoming object, so a patch never targets a missing path
 * (a JSON Patch `remove` on a missing member is an error, not a no-op).
 * `jsonpatch.escapeKey()` applies RFC 6901 escaping, which is what turns
 * `kro.run/owned` into the pointer segment `kro.run~1owned`.
 */
export const LABEL_PROPAGATION_GUARD_JSON_PATCH_EXPRESSION = [
  'variables.metadataStrip.map(k, JSONPatch{op: "remove", path: "/metadata/labels/" + jsonpatch.escapeKey(k)}) +',
  'variables.serviceSelectorStrip.map(k, JSONPatch{op: "remove", path: "/spec/selector/" + jsonpatch.escapeKey(k)}) +',
  'variables.matchLabelsStrip.map(k, JSONPatch{op: "remove", path: "/spec/selector/matchLabels/" + jsonpatch.escapeKey(k)}) +',
  'variables.templateStrip.map(k, JSONPatch{op: "remove", path: "/spec/template/metadata/labels/" + jsonpatch.escapeKey(k)})',
].join('\n');

/**
 * Build the guard's policy spec. Exported so unit tests and docs can render it
 * without constructing graph resources.
 */
export function labelPropagationGuardPolicySpec(
  options: LabelPropagationGuardOptions
): MutatingAdmissionPolicySpec {
  const exemptCallers = [
    serviceAccountUsername(
      options.kroNamespace,
      options.kroServiceAccount ?? DEFAULT_KRO_SERVICE_ACCOUNT
    ),
    ...(options.additionalExemptCallers ?? []),
  ];

  return {
    // `Ignore`: the guard is a safety net, not an admission gate. If CEL
    // evaluation fails the write must still go through — a broken guard that
    // blocks every Service create is worse than the pruning loop it prevents.
    failurePolicy: 'Ignore',
    // Mutating admission policies run before mutating webhooks. `IfNeeded` lets
    // the guard run again after a webhook that re-copies the parent labels,
    // which is the same defect one layer further out.
    reinvocationPolicy: 'IfNeeded',
    matchConstraints: {
      resourceRules: LABEL_PROPAGATION_GUARD_RESOURCE_RULES.map((rule) => ({
        apiGroups: [...rule.apiGroups],
        apiVersions: [...rule.apiVersions],
        operations: [...rule.operations],
        resources: [...rule.resources],
      })),
    },
    matchConditions: [
      {
        // KRO's own writes MUST keep the labels: strip them there and the
        // pruner loses track of what it applied, which breaks ownership the
        // other way round.
        name: 'exempt-kro-controller',
        expression: `!(request.userInfo.username in ${celStringList(exemptCallers)})`,
      },
    ],
    variables: buildGuardVariables(),
    mutations: [
      {
        patchType: 'JSONPatch',
        jsonPatch: { expression: LABEL_PROPAGATION_GUARD_JSON_PATCH_EXPRESSION },
      },
    ],
  };
}

/**
 * Render the label-propagation guard: one `MutatingAdmissionPolicy` and one
 * `MutatingAdmissionPolicyBinding`.
 *
 * @example
 * ```ts
 * const guard = labelPropagationGuard({ kroNamespace: 'kro-system' });
 * // guard.policy / guard.binding are graph resources
 * ```
 */
export function labelPropagationGuard(
  options: LabelPropagationGuardOptions
): LabelPropagationGuard {
  const name = options.name ?? LABEL_PROPAGATION_GUARD_NAME;
  const apiVersion = options.apiVersion ?? 'admissionregistration.k8s.io/v1';
  const labels = {
    'app.kubernetes.io/name': 'kro-label-propagation-guard',
    'app.kubernetes.io/part-of': 'typekro',
    'app.kubernetes.io/managed-by': 'typekro',
  };

  const policy = mutatingAdmissionPolicy({
    name,
    apiVersion,
    labels,
    id: options.policyId ?? 'labelPropagationGuardPolicy',
    spec: labelPropagationGuardPolicySpec(options),
  });

  const binding = mutatingAdmissionPolicyBinding({
    name,
    apiVersion,
    labels,
    id: options.bindingId ?? 'labelPropagationGuardBinding',
    // No `matchResources`: the binding activates the policy exactly as the
    // policy declares it. No `paramRef`: the policy has no `paramKind`.
    spec: { policyName: name },
  });

  return { policy, binding };
}
