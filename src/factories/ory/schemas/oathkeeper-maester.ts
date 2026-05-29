/** Oathkeeper Maester chart and Rule CRD contracts for Ory k8s chart version 0.62.0. */

import type {
  OryGlobalValues,
  OryImageValues,
  OryObjectMap,
  OryPdbValues,
  OryPodRuntimeValues,
  OryResourceRequirementsValues,
  OryStringMap,
} from './chart-values.js';

/** Oathkeeper handler shape used by authenticators, authorizers, mutators, and errors. */
export interface OathkeeperRuleHandler {
  /** Handler-specific configuration. Upstream preserves arbitrary plugin config. */
  config?: Record<string, unknown>;
  /** Oathkeeper handler name. */
  handler: string;
}

/** URL and HTTP methods matched by an Oathkeeper rule. */
export interface OathkeeperRuleMatch {
  methods: string[];
  url: string;
}

/** Upstream target for matched Oathkeeper requests. */
export interface OathkeeperRuleUpstream {
  preserveHost?: boolean;
  stripPath?: string;
  url: string;
}

/** Spec for `oathkeeper.ory.sh/v1alpha1`, kind `Rule`. */
export interface OathkeeperRuleSpec {
  [key: string]: unknown;
  authenticators?: OathkeeperRuleHandler[];
  authorizer?: OathkeeperRuleHandler;
  configMapName?: string;
  errors?: OathkeeperRuleHandler[];
  match: OathkeeperRuleMatch;
  mutators?: OathkeeperRuleHandler[];
  upstream?: OathkeeperRuleUpstream;
}

/** Validation status reported by Oathkeeper Maester. */
export interface OathkeeperRuleValidationStatus {
  valid?: boolean;
  validationError?: string;
}

/** Status for `oathkeeper.ory.sh/v1alpha1`, kind `Rule`. */
export interface OathkeeperRuleStatus {
  [key: string]: unknown;
  validation?: OathkeeperRuleValidationStatus;
}

/** Resource config accepted by the TypeKro `oathkeeperRule` factory. */
export interface OathkeeperRuleConfig {
  /** TypeKro composition resource id. */
  id?: string;
  /** Kubernetes resource name. */
  name: string;
  /** Kubernetes namespace. */
  namespace?: string;
  /** Complete pinned upstream CRD spec. */
  spec: OathkeeperRuleSpec;
}

/** Oathkeeper Maester deployment values. */
export interface OryOathkeeperMaesterDeploymentValues extends OryPodRuntimeValues {
  priorityClassName?: string;
  resources?: OryResourceRequirementsValues;
  extraLabels?: OryStringMap;
  annotations?: OryStringMap;
  envs?: OryObjectMap;
  serviceAccount?: { annotations?: OryStringMap };
}

/** Values for the Ory Oathkeeper Maester chart. */
export interface OryOathkeeperMaesterChartValues {
  global?: OryGlobalValues;
  replicaCount?: number;
  revisionHistoryLimit?: number;
  singleNamespaceMode?: boolean;
  rulesConfigmapNamespace?: string;
  rulesFileName?: string;
  image?: OryImageValues;
  imagePullSecrets?: OryObjectMap[];
  securityContext?: OryObjectMap;
  podSecurityContext?: OryObjectMap;
  deployment?: OryOathkeeperMaesterDeploymentValues;
  affinity?: OryObjectMap;
  pdb?: OryPdbValues;
}
