/**
 * Typed `MutatingAdmissionPolicy` / `MutatingAdmissionPolicyBinding` factories.
 *
 * KEP-3962 mutating admission policies run CEL-based mutations inside the API
 * server: no webhook Deployment, no image, no certificate rotation, and the
 * failure mode is the API server's own. The API is beta from Kubernetes 1.34
 * (`admissionregistration.k8s.io/v1beta1`) and GA from 1.36
 * (`admissionregistration.k8s.io/v1`), so the factories take the group version
 * as an option rather than hard-coding one.
 *
 * Field names below were verified against a live 1.36.1 API server with
 * `kubectl explain mutatingadmissionpolicy.spec --recursive` and
 * `kubectl explain mutatingadmissionpolicybinding.spec --recursive`.
 */

import { type } from 'arktype';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

// =============================================================================
// Shared schema shapes
// =============================================================================

/** Group versions that have served `MutatingAdmissionPolicy` (beta 1.34, GA 1.36). */
export const MUTATING_ADMISSION_POLICY_API_VERSIONS = [
  'admissionregistration.k8s.io/v1',
  'admissionregistration.k8s.io/v1beta1',
] as const;

/** A group version that serves `MutatingAdmissionPolicy`. */
export type MutatingAdmissionPolicyApiVersion =
  (typeof MUTATING_ADMISSION_POLICY_API_VERSIONS)[number];

const ApiVersionSchema = type(
  '"admissionregistration.k8s.io/v1" | "admissionregistration.k8s.io/v1beta1"'
);

const LabelSelectorRequirementSchema = type({
  key: 'string',
  operator: '"In" | "NotIn" | "Exists" | "DoesNotExist"',
  'values?': 'string[]',
});

const LabelSelectorSchema = type({
  'matchLabels?': 'Record<string, string>',
  'matchExpressions?': LabelSelectorRequirementSchema.array(),
});

const NamedRuleWithOperationsSchema = type({
  'apiGroups?': 'string[]',
  'apiVersions?': 'string[]',
  'operations?': '("*" | "CREATE" | "UPDATE" | "DELETE" | "CONNECT")[]',
  'resources?': 'string[]',
  'resourceNames?': 'string[]',
  'scope?': '"*" | "Cluster" | "Namespaced"',
});

const MatchResourcesSchema = type({
  'matchPolicy?': '"Exact" | "Equivalent"',
  'namespaceSelector?': LabelSelectorSchema,
  'objectSelector?': LabelSelectorSchema,
  'resourceRules?': NamedRuleWithOperationsSchema.array(),
  'excludeResourceRules?': NamedRuleWithOperationsSchema.array(),
});

const MatchConditionSchema = type({
  name: 'string',
  expression: 'string',
});

const VariableSchema = type({
  name: 'string',
  expression: 'string',
});

const MutationSchema = type({
  patchType: '"ApplyConfiguration" | "JSONPatch"',
  'applyConfiguration?': { expression: 'string' },
  'jsonPatch?': { expression: 'string' },
});

// =============================================================================
// MutatingAdmissionPolicy
// =============================================================================

export const MutatingAdmissionPolicySpecSchema = type({
  'paramKind?': { 'apiVersion?': 'string', 'kind?': 'string' },
  'matchConstraints?': MatchResourcesSchema,
  'matchConditions?': MatchConditionSchema.array(),
  'variables?': VariableSchema.array(),
  mutations: MutationSchema.array(),
  /** @default 'Fail' (API server default). The guard uses `Ignore`. */
  'failurePolicy?': '"Ignore" | "Fail"',
  /** Required by the API. The factory defaults it to `Never`. */
  'reinvocationPolicy?': '"Never" | "IfNeeded"',
});
export type MutatingAdmissionPolicySpec = typeof MutatingAdmissionPolicySpecSchema.infer;

export const MutatingAdmissionPolicyConfigSchema = type({
  name: 'string',
  'id?': 'string',
  'labels?': 'Record<string, string>',
  'annotations?': 'Record<string, string>',
  /** @default 'admissionregistration.k8s.io/v1' */
  'apiVersion?': ApiVersionSchema,
  spec: MutatingAdmissionPolicySpecSchema,
});
export type MutatingAdmissionPolicyConfig = typeof MutatingAdmissionPolicyConfigSchema.infer;

/**
 * `MutatingAdmissionPolicy` has no `status` — verified on a live 1.36.1 API
 * server (`kubectl explain mutatingadmissionpolicy.status` reports
 * `field "status" does not exist`, and a created object round-trips with only
 * `apiVersion`, `kind`, `metadata`, `spec`).
 *
 * Unlike `ValidatingAdmissionPolicy`, which publishes `status.typeChecking` and
 * `status.conditions`, a mutating policy's CEL is compiled lazily at admission
 * time and there is nothing for a controller to report back. Readiness is
 * therefore "the object exists", i.e. the always-ready evaluator.
 */
export type MutatingAdmissionPolicyStatus = Record<string, never>;

/**
 * Create a cluster-scoped `MutatingAdmissionPolicy`.
 *
 * A policy on its own does nothing: it must be activated by a
 * {@link mutatingAdmissionPolicyBinding} that names it.
 */
export function mutatingAdmissionPolicy(
  config: Composable<MutatingAdmissionPolicyConfig>
): Enhanced<MutatingAdmissionPolicySpec, MutatingAdmissionPolicyStatus> {
  return createResource<MutatingAdmissionPolicySpec, MutatingAdmissionPolicyStatus>(
    {
      apiVersion: config.apiVersion ?? 'admissionregistration.k8s.io/v1',
      kind: 'MutatingAdmissionPolicy',
      metadata: {
        name: config.name,
        ...(config.labels && { labels: config.labels }),
        ...(config.annotations && { annotations: config.annotations }),
      },
      spec: {
        ...config.spec,
        // Required by the API server; `Never` matches the documented default
        // and keeps the CEL cost budget to a single evaluation per request.
        reinvocationPolicy: config.spec.reinvocationPolicy ?? 'Never',
      } as MutatingAdmissionPolicySpec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(
    // See MutatingAdmissionPolicyStatus: the kind has no status subresource, so
    // "created" is the only observable readiness signal.
    createAlwaysReadyEvaluator('MutatingAdmissionPolicy')
  );
}

// =============================================================================
// MutatingAdmissionPolicyBinding
// =============================================================================

export const MutatingAdmissionPolicyBindingSpecSchema = type({
  policyName: 'string',
  'paramRef?': {
    'name?': 'string',
    'namespace?': 'string',
    'parameterNotFoundAction?': '"Deny" | "Allow"',
    'selector?': LabelSelectorSchema,
  },
  /**
   * Narrows the policy's own `matchConstraints` for this binding. Omit to
   * activate the policy exactly as the policy declares it.
   */
  'matchResources?': MatchResourcesSchema,
});
export type MutatingAdmissionPolicyBindingSpec =
  typeof MutatingAdmissionPolicyBindingSpecSchema.infer;

export const MutatingAdmissionPolicyBindingConfigSchema = type({
  name: 'string',
  'id?': 'string',
  'labels?': 'Record<string, string>',
  'annotations?': 'Record<string, string>',
  /** @default 'admissionregistration.k8s.io/v1' */
  'apiVersion?': ApiVersionSchema,
  spec: MutatingAdmissionPolicyBindingSpecSchema,
});
export type MutatingAdmissionPolicyBindingConfig =
  typeof MutatingAdmissionPolicyBindingConfigSchema.infer;

/** A binding has no status either — same reasoning as the policy. */
export type MutatingAdmissionPolicyBindingStatus = Record<string, never>;

/**
 * Create a cluster-scoped `MutatingAdmissionPolicyBinding`, which is what
 * actually activates a {@link mutatingAdmissionPolicy} against the cluster.
 */
export function mutatingAdmissionPolicyBinding(
  config: Composable<MutatingAdmissionPolicyBindingConfig>
): Enhanced<MutatingAdmissionPolicyBindingSpec, MutatingAdmissionPolicyBindingStatus> {
  return createResource<MutatingAdmissionPolicyBindingSpec, MutatingAdmissionPolicyBindingStatus>(
    {
      apiVersion: config.apiVersion ?? 'admissionregistration.k8s.io/v1',
      kind: 'MutatingAdmissionPolicyBinding',
      metadata: {
        name: config.name,
        ...(config.labels && { labels: config.labels }),
        ...(config.annotations && { annotations: config.annotations }),
      },
      spec: config.spec as MutatingAdmissionPolicyBindingSpec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(createAlwaysReadyEvaluator('MutatingAdmissionPolicyBinding'));
}
