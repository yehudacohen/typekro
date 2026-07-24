/** Explicitly owned Rook/Ceph operator installation. */

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_ROOK_CEPH_REPO_NAME,
  DEFAULT_ROOK_CEPH_REPO_URL,
  DEFAULT_ROOK_CEPH_VERSION,
  rookCephHelmRepository,
  rookCephOperatorHelmRelease,
} from '../resources/helm.js';
import {
  type RookCephOperatorBootstrapConfig,
  RookCephOperatorBootstrapConfigSchema,
  RookCephOperatorBootstrapStatusSchema,
} from '../types.js';
import { mapRookCephOperatorConfigToHelmValues } from '../utils/helm-values-mapper.js';

/**
 * Own a complete Rook operator installation.
 *
 * Use this composition only when the caller intentionally owns operator
 * teardown. Shared consumers should reference `rookCephOperatorBootstrap`
 * through `singleton(...)`; that owner boundary prevents consumer deletion
 * from uninstalling Rook.
 */
export const rookCephOperatorBootstrap = kubernetesComposition(
  {
    name: 'rook-ceph-operator-bootstrap',
    kind: 'RookCephOperatorBootstrap',
    spec: RookCephOperatorBootstrapConfigSchema,
    status: RookCephOperatorBootstrapStatusSchema,
  },
  (spec: RookCephOperatorBootstrapConfig) => {
    const resolvedNamespace = spec.namespace ?? 'rook-ceph';
    const resolvedVersion = spec.version ?? DEFAULT_ROOK_CEPH_VERSION;
    const repositoryName = spec.repositoryName ?? DEFAULT_ROOK_CEPH_REPO_NAME;
    const repositoryNamespace = spec.repositoryNamespace ?? resolvedNamespace;
    const repositoryUrl = spec.repositoryUrl ?? DEFAULT_ROOK_CEPH_REPO_URL;

    namespace({
      metadata: {
        name: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'rook-ceph-operator',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/version': resolvedVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'rookCephNamespace',
    });

    const graphMode = isKubernetesRef(spec.name);
    const ownsRepositoryNamespace = graphMode
      ? Cel.expr<boolean>(
          '!has(schema.spec.repositoryNamespaceOwnership) || schema.spec.repositoryNamespaceOwnership == "owned"'
        )
      : spec.repositoryNamespaceOwnership !== 'external';
    namespace({
      metadata: {
        name: repositoryNamespace,
        labels: {
          'app.kubernetes.io/name': 'rook-ceph-helm-source',
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'rookCephRepositoryNamespace',
    }).withIncludeWhen(
      graphMode
        ? Cel.expr<boolean>(
            ownsRepositoryNamespace,
            ' && ',
            repositoryNamespace,
            ' != ',
            resolvedNamespace
          )
        : ownsRepositoryNamespace && repositoryNamespace !== resolvedNamespace
    );

    const _repository = rookCephHelmRepository({
      name: repositoryName,
      namespace: repositoryNamespace,
      url: repositoryUrl,
      id: 'rookCephHelmRepository',
    });

    const release = rookCephOperatorHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      repositoryName,
      repositoryNamespace,
      repositoryUrl,
      values: mapRookCephOperatorConfigToHelmValues({
        logLevel: spec.logLevel,
        enableOBCWatchOperatorNamespace: spec.enableOBCWatchOperatorNamespace,
        obcProvisionerNamePrefix: spec.obcProvisionerNamePrefix,
        obcAllowAdditionalConfigFields: spec.obcAllowAdditionalConfigFields,
        resources: spec.resources,
        values: spec.values,
      }),
      id: 'rookCephOperatorHelmRelease',
    });

    return {
      ...helmReleaseConditionSummary(release.status.conditions),
      version: resolvedVersion,
    };
  }
);

/** Explicit lifecycle name for code that wants to emphasize ownership. */
export const rookCephOperatorInstallation = rookCephOperatorBootstrap;
