// Maps composition inputs to chart values: CRDs installed and upgraded by the chart, and the
// controller's service account named for its EKS Pod Identity association. The caller's
// `values` are layered on top, and then the required values are applied last, so raw chart
// values can't turn off the CRDs or move the controller off its Pod Identity service account.

import {
  isMergeableValuesObject,
  materializeValuesMergeExpressions,
  mergeValuesExpression,
  withChartValueDefaults,
} from '../../../core/aspects/values-merge.js';
import { TypeKroError } from '../../../core/errors.js';

/** The chart values the composition owns, as dotted paths. */
export const EXTERNAL_SECRETS_RESERVED_CHART_VALUES = [
  'installCRDs',
  'serviceAccount.create',
  'serviceAccount.name',
] as const;

/**
 * Throws when concrete caller `values` set a reserved chart value to anything other than what
 * the composition sets. Values only known per instance (KRO mode) are not checked here; the
 * required values are merged over them instead.
 */
function assertNoReservedOverrides(
  values: unknown,
  required: { installCRDs: true; serviceAccount: { create: true; name: unknown } }
): void {
  if (!isMergeableValuesObject(values)) return;
  const conflicts: string[] = [];
  if ('installCRDs' in values && values.installCRDs !== required.installCRDs) {
    conflicts.push('installCRDs');
  }
  if ('serviceAccount' in values) {
    const serviceAccount = values.serviceAccount;
    if (!isMergeableValuesObject(serviceAccount)) {
      conflicts.push('serviceAccount');
    } else {
      if ('create' in serviceAccount && serviceAccount.create !== true) {
        conflicts.push('serviceAccount.create');
      }
      if ('name' in serviceAccount && serviceAccount.name !== required.serviceAccount.name) {
        conflicts.push('serviceAccount.name');
      }
    }
  }
  if (conflicts.length > 0) {
    throw new TypeKroError(
      `External Secrets chart values can't override ${conflicts.join(', ')}. The composition ` +
        'installs the CRDs and creates the controller service account named by ' +
        'serviceAccountName, which the EKS Pod Identity association binds; set ' +
        'serviceAccountName instead.',
      'EXTERNAL_SECRETS_RESERVED_CHART_VALUE',
      { conflicts }
    );
  }
}

export function mapExternalSecretsConfigToHelmValues(input: {
  serviceAccountName: string;
  values?: Record<string, unknown>;
}): Record<string, unknown> {
  const required = {
    installCRDs: true as const,
    // Pod Identity binds the IAM role to this service account; no annotation is needed.
    serviceAccount: { create: true as const, name: input.serviceAccountName },
  };
  assertNoReservedOverrides(input.values, required);
  const layered = mergeValuesExpression(
    withChartValueDefaults(
      {
        // Keep the CRDs, and with them every ExternalSecret, if the release is uninstalled.
        crds: { annotations: { 'helm.sh/resource-policy': 'keep' } },
      },
      input.values
    ),
    required
  );
  // With concrete values the merge resolves now; in KRO mode it is resolved per instance, still
  // with the required values last.
  return (
    isMergeableValuesObject(layered.base) && layered.overlays.every(isMergeableValuesObject)
      ? materializeValuesMergeExpressions(layered)
      : layered
  ) as Record<string, unknown>;
}
