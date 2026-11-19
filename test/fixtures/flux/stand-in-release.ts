/**
 * A neutral stand-in with the shape of a Flux release's install manifests: a namespace, a
 * quota, CRDs, service accounts, cluster RBAC, a service, a network policy and two controllers.
 * It is NOT Flux; it keeps the unit tests small. The pinned upstream releases have their own test.
 *
 * One CRD has a field with `x-kubernetes-preserve-unknown-fields` and no `type`, as Flux's
 * HelmRelease `values` does, so the Kubernetes 1.33 schema fix has something to fix.
 */
import type { FluxManifestObject, FluxRelease } from '../../../src/factories/flux/install/types.js';

const NAMESPACE = 'flux-system';

const crd = (plural: string, group: string, kind: string, spec: object): FluxManifestObject => ({
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: { name: `${plural}.${group}` },
  spec: {
    group,
    names: { kind, plural, singular: kind.toLowerCase(), listKind: `${kind}List` },
    scope: 'Namespaced',
    versions: [
      {
        name: 'v2',
        served: true,
        storage: true,
        schema: {
          openAPIV3Schema: {
            type: 'object',
            properties: { spec: { type: 'object', properties: spec } },
          },
        },
      },
    ],
  },
});

const controller = (name: string): FluxManifestObject => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name, namespace: NAMESPACE, labels: { 'app.kubernetes.io/component': name } },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: name } },
    template: {
      metadata: { labels: { app: name } },
      spec: {
        serviceAccountName: name,
        nodeSelector: { 'kubernetes.io/os': 'linux' },
        containers: [{ name: 'manager', image: `registry.example.test/${name}:stand-in` }],
      },
    },
  },
});

export const fluxStandInRelease: FluxRelease = {
  version: 'v2.10.0',
  documents: [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NAMESPACE } },
    {
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: { name: 'critical-pods-flux-system', namespace: NAMESPACE },
      spec: { hard: { pods: '1000' } },
    },
    crd('helmreleases', 'helm.toolkit.fluxcd.io', 'HelmRelease', {
      interval: { type: 'string' },
      values: { 'x-kubernetes-preserve-unknown-fields': true },
    }),
    crd('helmrepositories', 'source.toolkit.fluxcd.io', 'HelmRepository', {
      url: { type: 'string' },
    }),
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: 'helm-controller', namespace: NAMESPACE },
    },
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: 'source-controller', namespace: NAMESPACE },
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: 'crd-controller-flux-system' },
      rules: [{ apiGroups: ['source.toolkit.fluxcd.io'], resources: ['*'], verbs: ['*'] }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: 'cluster-reconciler-flux-system' },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: 'cluster-admin',
      },
      subjects: [
        { kind: 'ServiceAccount', name: 'helm-controller', namespace: NAMESPACE },
        { kind: 'ServiceAccount', name: 'source-controller', namespace: NAMESPACE },
      ],
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'source-controller', namespace: NAMESPACE },
      spec: {
        selector: { app: 'source-controller' },
        ports: [{ name: 'http', port: 80, targetPort: 9090 }],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'allow-egress', namespace: NAMESPACE },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
        egress: [{}],
        ingress: [{ from: [{ podSelector: {} }] }],
      },
    },
    controller('helm-controller'),
    controller('source-controller'),
  ],
};
