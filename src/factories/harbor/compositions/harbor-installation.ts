import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { observedResource } from '../../../core/references/external-refs.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { certificate } from '../../cert-manager/resources/certificates.js';
import { configMap } from '../../kubernetes/config/config-map.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { networkPolicy } from '../../kubernetes/networking/network-policy.js';
import {
  DEFAULT_HARBOR_CHART_VERSION,
  DEFAULT_HARBOR_REPOSITORY_NAME,
  DEFAULT_HARBOR_REPOSITORY_URL,
  DEFAULT_HARBOR_VERSION,
  harborHelmRelease,
  harborHelmRepository,
} from '../resources/helm.js';
import {
  type HarborLocalInstallationConfig,
  HarborLocalInstallationConfigSchema,
  type HarborProductionInstallationConfig,
  HarborProductionInstallationConfigSchema,
  HarborInstallationStatusSchema,
} from '../types.js';
import {
  mapHarborLocalInstallationToHelmValues,
  mapHarborProductionInstallationToHelmValues,
} from '../utils/helm-values-mapper.js';

const DEFAULT_HARBOR_NAMESPACE = 'harbor-system';

/** Install the official Harbor chart with a bounded, explicitly non-HA development profile. */
export const harborLocalInstallation = kubernetesComposition(
  {
    name: 'harbor-local-installation',
    kind: 'HarborLocalInstallation',
    spec: HarborLocalInstallationConfigSchema,
    status: HarborInstallationStatusSchema,
  },
  (spec: HarborLocalInstallationConfig) => createHarborInstallation(spec, 'local-development')
);

/** Install the official Harbor chart with external state and HA component requirements. */
export const harborProductionInstallation = kubernetesComposition(
  {
    name: 'harbor-production-installation',
    kind: 'HarborProductionInstallation',
    spec: HarborProductionInstallationConfigSchema,
    status: HarborInstallationStatusSchema,
  },
  (spec: HarborProductionInstallationConfig) => createHarborInstallation(spec, 'production'),
  {
    schemaFieldValidations: {
      exposure:
        "self.tls.enabled && self.tls.source != 'none' && (self.type != 'ingress' || (has(self.ingress) && size(self.ingress.host) > 0)) && (self.tls.source != 'secret' || (has(self.tls.secretName) && size(self.tls.secretName) > 0))",
      certificate: 'size(self.secretName) > 0',
      storage: 'self.secure && !self.skipVerify',
      networkPolicy:
        'self.enabled && size(self.ingressNamespaceLabels) > 0 && (size(self.egressNamespaceLabels) > 0 || (has(self.egressCidrs) && size(self.egressCidrs) > 0))',
    },
  }
);

function createHarborInstallation(
  spec: HarborLocalInstallationConfig | HarborProductionInstallationConfig,
  profile: 'local-development' | 'production'
) {
  const graphMode = isKubernetesRef(spec.name);
  const targetNamespace = graphMode
    ? Cel.expr<string>('has(schema.spec.namespace) ? schema.spec.namespace : "harbor-system"')
    : (spec.namespace ?? DEFAULT_HARBOR_NAMESPACE);
  const ownsTargetNamespace = graphMode
    ? Cel.expr<boolean>(
        '!has(schema.spec.namespaceOwnership) || schema.spec.namespaceOwnership == "owned"'
      )
    : spec.namespaceOwnership !== 'external';
  const repositoryName = graphMode
    ? Cel.expr<string>('has(schema.spec.repositoryName) ? schema.spec.repositoryName : "harbor"')
    : (spec.repositoryName ?? DEFAULT_HARBOR_REPOSITORY_NAME);
  const repositoryNamespace = graphMode
    ? Cel.expr<string>(
        'has(schema.spec.repositoryNamespace) ? schema.spec.repositoryNamespace : (has(schema.spec.namespace) ? schema.spec.namespace : "harbor-system")'
      )
    : (spec.repositoryNamespace ?? targetNamespace);
  const repositoryUrl = graphMode
    ? Cel.expr<string>(
        'has(schema.spec.repositoryUrl) ? schema.spec.repositoryUrl : "https://helm.goharbor.io"'
      )
    : (spec.repositoryUrl ?? DEFAULT_HARBOR_REPOSITORY_URL);
  const ownsRepositoryNamespace = graphMode
    ? Cel.expr<boolean>(
        '!has(schema.spec.repositoryNamespaceOwnership) || schema.spec.repositoryNamespaceOwnership == "owned"'
      )
    : spec.repositoryNamespaceOwnership !== 'external';
  const chartVersion = graphMode
    ? Cel.expr<string>('has(schema.spec.chartVersion) ? schema.spec.chartVersion : "1.19.1"')
    : (spec.chartVersion ?? DEFAULT_HARBOR_CHART_VERSION);
  const harborVersion = graphMode
    ? Cel.expr<string>('has(schema.spec.harborVersion) ? schema.spec.harborVersion : "v2.15.1"')
    : (spec.harborVersion ?? DEFAULT_HARBOR_VERSION);
  const policyEnabled = graphMode
    ? Cel.expr<boolean>('has(schema.spec.networkPolicy) && schema.spec.networkPolicy.enabled')
    : (spec.networkPolicy?.enabled ?? false);

  namespace({
    id: 'harborNamespace',
    metadata: {
      name: targetNamespace,
      labels: {
        'app.kubernetes.io/name': 'harbor',
        'app.kubernetes.io/instance': spec.name,
        'app.kubernetes.io/managed-by': 'typekro',
        'typekro.dev/profile': profile,
      },
    },
  }).withIncludeWhen(ownsTargetNamespace);

  namespace({
    id: 'harborRepositoryNamespace',
    metadata: {
      name: repositoryNamespace,
      labels: {
        'app.kubernetes.io/name': 'harbor-helm-source',
        'app.kubernetes.io/managed-by': 'typekro',
      },
    },
  }).withIncludeWhen(
    graphMode
      ? Cel.expr<boolean>(
          '(!has(schema.spec.repositoryNamespaceOwnership) || schema.spec.repositoryNamespaceOwnership == "owned") && (has(schema.spec.repositoryNamespace) && schema.spec.repositoryNamespace != (has(schema.spec.namespace) ? schema.spec.namespace : "harbor-system"))'
        )
      : ownsRepositoryNamespace && repositoryNamespace !== targetNamespace
  );

  const repository = harborHelmRepository({
    id: 'harborRepository',
    name: repositoryName,
    namespace: repositoryNamespace,
    url: repositoryUrl,
  });

  configMap({
    id: 'harborMetadata',
    metadata: {
      name: graphMode
        ? Cel.expr<string>('schema.spec.name + "-typekro-metadata"')
        : `${spec.name}-typekro-metadata`,
      namespace: targetNamespace,
      labels: {
        'app.kubernetes.io/name': 'harbor',
        'app.kubernetes.io/managed-by': 'typekro',
      },
      annotations: {
        'typekro.dev/endpoint': spec.exposure.externalUrl,
        'typekro.dev/chart-version': chartVersion,
        'typekro.dev/harbor-version': harborVersion,
        'typekro.dev/profile': profile,
        'typekro.dev/tls-enabled': graphMode
          ? Cel.expr<string>(spec.exposure.tls.enabled, ' ? "true" : "false"')
          : String(spec.exposure.tls.enabled),
        'typekro.dev/network-policy-enabled': graphMode
          ? Cel.expr<string>(policyEnabled, ' ? "true" : "false"')
          : String(policyEnabled),
      },
    },
    immutable: true,
    data: {},
  });

  certificate({
    id: 'harborCertificate',
    name: graphMode
      ? Cel.expr<string>('schema.spec.certificate.secretName + "-certificate"')
      : `${spec.certificate?.secretName ?? spec.name}-certificate`,
    namespace: targetNamespace,
    spec: {
      secretName: graphMode
        ? Cel.expr<string>('schema.spec.certificate.secretName')
        : (spec.certificate?.secretName ?? ''),
      dnsNames: [
        graphMode
          ? Cel.expr<string>('schema.spec.exposure.ingress.host')
          : (spec.exposure.ingress?.host ?? ''),
      ],
      issuerRef: {
        name: graphMode
          ? Cel.expr<string>('schema.spec.certificate.issuerRef.name')
          : (spec.certificate?.issuerRef.name ?? ''),
        kind: graphMode
          ? Cel.expr<'Issuer' | 'ClusterIssuer'>(
              'has(schema.spec.certificate.issuerRef.kind) ? schema.spec.certificate.issuerRef.kind : "ClusterIssuer"'
            )
          : (spec.certificate?.issuerRef.kind ?? 'ClusterIssuer'),
        group: graphMode
          ? Cel.expr<string>(
              'has(schema.spec.certificate.issuerRef.group) ? schema.spec.certificate.issuerRef.group : "cert-manager.io"'
            )
          : (spec.certificate?.issuerRef.group ?? 'cert-manager.io'),
      },
      duration: graphMode
        ? Cel.expr<string>(
            'has(schema.spec.certificate.duration) ? schema.spec.certificate.duration : "2160h"'
          )
        : (spec.certificate?.duration ?? '2160h'),
      renewBefore: graphMode
        ? Cel.expr<string>(
            'has(schema.spec.certificate.renewBefore) ? schema.spec.certificate.renewBefore : "720h"'
          )
        : (spec.certificate?.renewBefore ?? '720h'),
    },
  }).withIncludeWhen(
    graphMode
      ? Cel.expr<boolean>('schema.spec.exposure.tls.source == "cert-manager"')
      : spec.exposure.tls.source === 'cert-manager'
  );

  const values =
    profile === 'production'
      ? mapHarborProductionInstallationToHelmValues(spec as HarborProductionInstallationConfig)
      : mapHarborLocalInstallationToHelmValues(spec as HarborLocalInstallationConfig);

  const storageCredentials = observedResource<Record<string, never>, Record<string, never>>({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: spec.storage.existingSecret, namespace: targetNamespace },
    id: 'harborStorageCredentials',
  });
  const adminCredentials = observeHarborSecret(
    'harborAdminCredentials',
    spec.adminPasswordSecret.name,
    targetNamespace
  );
  const encryptionKey = observeHarborSecret(
    'harborEncryptionKey',
    spec.componentSecrets.encryptionKey,
    targetNamespace
  );
  const coreCredentials = observeHarborSecret(
    'harborCoreCredentials',
    spec.componentSecrets.core,
    targetNamespace
  );
  const jobserviceCredentials = observeHarborSecret(
    'harborJobserviceCredentials',
    spec.componentSecrets.jobservice,
    targetNamespace
  );
  const registryCredentials = observeHarborSecret(
    'harborRegistryCredentials',
    spec.componentSecrets.registry,
    targetNamespace
  );
  const registryBasicAuth = observeHarborSecret(
    'harborRegistryBasicAuth',
    spec.componentSecrets.registryCredentials,
    targetNamespace
  );
  const databaseCredentials =
    profile === 'production'
      ? observedResource<Record<string, never>, Record<string, never>>({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: (spec as HarborProductionInstallationConfig).database.existingSecret,
            namespace: targetNamespace,
          },
          id: 'harborDatabaseCredentials',
        })
      : undefined;
  const cacheCredentials =
    profile === 'production'
      ? observedResource<Record<string, never>, Record<string, never>>({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: (spec as HarborProductionInstallationConfig).cache.existingSecret,
            namespace: targetNamespace,
          },
          id: 'harborCacheCredentials',
        })
      : undefined;

  const defaultPolicy = networkPolicy({
    id: 'harborNetworkPolicy',
    metadata: {
      name: graphMode ? Cel.expr<string>('schema.spec.name + "-network"') : `${spec.name}-network`,
      namespace: targetNamespace,
      labels: { 'app.kubernetes.io/name': 'harbor', 'app.kubernetes.io/managed-by': 'typekro' },
    },
    spec: {
      podSelector: { matchLabels: { release: spec.name, app: 'harbor' } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ _from: [{ podSelector: {} }] }],
      egress: harborEgressRules(spec, graphMode),
    },
  }).withIncludeWhen(policyEnabled);
  const ingressPolicy = networkPolicy({
    id: 'harborIngressNetworkPolicy',
    metadata: {
      name: graphMode ? Cel.expr<string>('schema.spec.name + "-ingress"') : `${spec.name}-ingress`,
      namespace: targetNamespace,
      labels: { 'app.kubernetes.io/name': 'harbor', 'app.kubernetes.io/managed-by': 'typekro' },
    },
    spec: {
      podSelector: { matchLabels: { release: spec.name, app: 'harbor' } },
      policyTypes: ['Ingress'],
      ingress: harborIngressRules(spec, graphMode),
    },
  }).withIncludeWhen(policyEnabled);

  const release = harborHelmRelease({
    id: 'harborRelease',
    name: spec.name,
    namespace: targetNamespace,
    version: chartVersion,
    repositoryName,
    repositoryNamespace,
    repositoryUrl,
    values,
  });
  release.dependsOn(repository);
  // KRO must model external Secret observations explicitly so its controller
  // delays the HelmRelease until they exist. Direct mode has no deployable
  // graph node for an external observation; its caller prepares those Secrets
  // before deploy(), and Flux readiness remains the integration check.
  if (graphMode) {
    release.dependsOn(storageCredentials);
    release.dependsOn(adminCredentials);
    release.dependsOn(encryptionKey);
    release.dependsOn(coreCredentials);
    release.dependsOn(jobserviceCredentials);
    release.dependsOn(registryCredentials);
    release.dependsOn(registryBasicAuth);
    if (databaseCredentials) release.dependsOn(databaseCredentials);
    if (cacheCredentials) release.dependsOn(cacheCredentials);
  }
  // Production always requires the policies, so they are safe hard
  // dependencies. The local profile permits policy omission; a dependency on
  // a skipped KRO child would otherwise make the HelmRelease unreconcilable.
  if (profile === 'production') {
    release.dependsOn(defaultPolicy);
    release.dependsOn(ingressPolicy);
  }

  const ready = Cel.expr<boolean>(
    release.status.conditions,
    '.exists(c, c.type == "Ready" && c.status == "True")'
  );
  const readyExpression =
    'harborRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")';
  const failed = Cel.expr<boolean>(
    release.status.conditions,
    '.exists(c, c.type == "Ready" && c.status == "False")'
  );
  return {
    ready,
    failed,
    phase: Cel.expr<'Installing' | 'Ready' | 'Failed'>(
      'harborRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "False") ? "Failed" : (harborRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing")'
    ),
    endpoint: Cel.expr<string>('harborMetadata.metadata.annotations["typekro.dev/endpoint"]'),
    chartVersion: Cel.expr<string>(
      'harborMetadata.metadata.annotations["typekro.dev/chart-version"]'
    ),
    harborVersion: Cel.expr<string>(
      'harborMetadata.metadata.annotations["typekro.dev/harbor-version"]'
    ),
    profile: Cel.expr<'local-development' | 'production'>(
      'harborMetadata.metadata.annotations["typekro.dev/profile"]'
    ),
    observedGeneration: Cel.expr<number>(
      'has(harborRelease.status.observedGeneration) ? harborRelease.status.observedGeneration : 0'
    ),
    tlsEnabled: Cel.expr<boolean>(
      'harborMetadata.metadata.annotations["typekro.dev/tls-enabled"] == "true"'
    ),
    // These fields are installation-capability readiness, not merely
    // credential-presence flags. An observed Secret is a prerequisite, but it
    // is not evidence that Harbor has successfully connected to the provider.
    // The HelmRelease Ready condition is the chart's bounded integration
    // acknowledgement, so do not report a provider ready ahead of it.
    storageReady: graphMode
      ? Cel.expr<boolean>(`${readyExpression} && harborStorageCredentials.metadata.name != ""`)
      : ready,
    databaseReady: databaseCredentials
      ? graphMode
        ? Cel.expr<boolean>(`${readyExpression} && harborDatabaseCredentials.metadata.name != ""`)
        : ready
      : ready,
    cacheReady: cacheCredentials
      ? graphMode
        ? Cel.expr<boolean>(`${readyExpression} && harborCacheCredentials.metadata.name != ""`)
        : ready
      : ready,
    networkPolicyReady: graphMode
      ? Cel.expr<boolean>(
          'harborMetadata.metadata.annotations["typekro.dev/network-policy-enabled"] != "true" || (harborNetworkPolicy.metadata.name != "" && harborIngressNetworkPolicy.metadata.name != "")'
        )
      : policyEnabled
        ? Cel.expr<boolean>(
            'harborNetworkPolicy.metadata.name != "" && harborIngressNetworkPolicy.metadata.name != ""'
          )
        : true,
    conditions: release.status.conditions,
  };
}

function observeHarborSecret(id: string, name: string, namespaceName: string) {
  return observedResource<Record<string, never>, Record<string, never>>({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: namespaceName },
    id,
  });
}

function harborIngressRules(
  spec: HarborLocalInstallationConfig | HarborProductionInstallationConfig,
  graphMode: boolean
) {
  if (graphMode) {
    return Cel.expr<
      NonNullable<NonNullable<import('@kubernetes/client-node').V1NetworkPolicy['spec']>['ingress']>
    >(
      'has(schema.spec.networkPolicy.ingressNamespaceLabels) ? [{"from":[{"namespaceSelector":{"matchLabels":schema.spec.networkPolicy.ingressNamespaceLabels}}],"ports":[{"protocol":"TCP","port":8080},{"protocol":"TCP","port":8443}]}] : []'
    );
  }
  const labels = spec.networkPolicy?.ingressNamespaceLabels;
  return labels
    ? [
        {
          _from: [{ namespaceSelector: { matchLabels: labels } }],
          ports: [
            { protocol: 'TCP' as const, port: 8080 },
            { protocol: 'TCP' as const, port: 8443 },
          ],
        },
      ]
    : [];
}

function harborEgressRules(
  spec: HarborLocalInstallationConfig | HarborProductionInstallationConfig,
  graphMode: boolean
) {
  if (graphMode) {
    return Cel.expr<
      NonNullable<NonNullable<import('@kubernetes/client-node').V1NetworkPolicy['spec']>['egress']>
    >(
      '[{"to":[{"podSelector":{}}]},{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"kube-system"}},"podSelector":{"matchLabels":{"k8s-app":"kube-dns"}}}],"ports":[{"protocol":"UDP","port":53},{"protocol":"TCP","port":53}]}] + (has(schema.spec.networkPolicy.egressNamespaceLabels) ? schema.spec.networkPolicy.egressNamespaceLabels : []).map(labels, {"to":[{"namespaceSelector":{"matchLabels":labels}}]}) + (has(schema.spec.networkPolicy.egressCidrs) ? schema.spec.networkPolicy.egressCidrs.map(cidr, {"to":[{"ipBlock":{"cidr":cidr}}]}) : [])'
    );
  }
  return [
    { to: [{ podSelector: {} }] },
    {
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
          podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
        },
      ],
      ports: [
        { protocol: 'UDP' as const, port: 53 },
        { protocol: 'TCP' as const, port: 53 },
      ],
    },
    ...(spec.networkPolicy?.egressNamespaceLabels ?? []).map((matchLabels) => ({
      to: [{ namespaceSelector: { matchLabels } }],
    })),
    ...(spec.networkPolicy?.egressCidrs ?? []).map((cidr) => ({
      to: [{ ipBlock: { cidr } }],
    })),
  ];
}

/** Explicit shared-platform lifecycle names. */
export const harborLocalPlatform = harborLocalInstallation;
export const harborProductionPlatform = harborProductionInstallation;
