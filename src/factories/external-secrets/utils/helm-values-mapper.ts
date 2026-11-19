// Maps composition inputs to chart values: CRDs installed and upgraded by the chart, and the
// controller's service account named for its EKS Pod Identity association. The caller's
// `values` are layered on top.

import { withChartValueDefaults } from '../../../core/aspects/values-merge.js';

export function mapExternalSecretsConfigToHelmValues(input: {
  serviceAccountName: string;
  values?: Record<string, unknown>;
}): Record<string, unknown> {
  return withChartValueDefaults(
    {
      installCRDs: true,
      // Keep the CRDs, and with them every ExternalSecret, if the release is uninstalled.
      crds: { annotations: { 'helm.sh/resource-policy': 'keep' } },
      // Pod Identity binds the IAM role to this service account; no annotation is needed.
      serviceAccount: { create: true, name: input.serviceAccountName },
    },
    input.values
  ) as Record<string, unknown>;
}
