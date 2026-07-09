/** Official Rook Ceph operator bootstrap composition. */

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { setMetadataField } from '../../../core/metadata/index.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_ROOK_CEPH_REPO_NAME,
  DEFAULT_ROOK_CEPH_REPO_URL,
  DEFAULT_ROOK_CEPH_VERSION,
  rookCephOperatorHelmRelease,
} from '../resources/helm.js';
import {
  type RookCephOperatorBootstrapConfig,
  RookCephOperatorBootstrapConfigSchema,
  RookCephOperatorBootstrapStatusSchema,
} from '../types.js';
import { mapRookCephOperatorConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { rookCephHelmRepositoryBootstrap } from './rook-ceph-helm-repository.js';

/**
 * Install the official cluster-scoped Rook Ceph operator via Flux Helm.
 *
 * This bootstrap intentionally does not create a CephCluster. Storage media,
 * failure domains, and cluster lifecycle remain explicit platform decisions.
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
    const isShared = spec.shared !== false;

    const helmValues = mapRookCephOperatorConfigToHelmValues({
      logLevel: spec.logLevel,
      enableOBCWatchOperatorNamespace: spec.enableOBCWatchOperatorNamespace,
      obcProvisionerNamePrefix: spec.obcProvisionerNamePrefix,
      obcAllowAdditionalConfigFields: spec.obcAllowAdditionalConfigFields,
      resources: spec.resources,
      values: spec.values,
    });

    const _namespace = namespace({
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

    const _repository = singleton(rookCephHelmRepositoryBootstrap, {
      id: 'rook-ceph-helm-repository',
      spec: {
        name: DEFAULT_ROOK_CEPH_REPO_NAME,
        namespace: DEFAULT_FLUX_NAMESPACE,
        url: DEFAULT_ROOK_CEPH_REPO_URL,
      },
    });

    const _release = rookCephOperatorHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
      id: 'rookCephOperatorHelmRelease',
    });

    if (isShared) {
      setMetadataField(_namespace, 'scopes', ['cluster']);
      setMetadataField(_release, 'scopes', ['cluster']);
    }

    return {
      ready: Cel.expr<boolean>(
        _release.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      phase: Cel.expr<'Ready' | 'Installing'>(
        _release.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
      ),
      failed: Cel.expr<boolean>(
        _release.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "False")'
      ),
      version: resolvedVersion,
    };
  }
);
