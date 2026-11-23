import { createHash } from 'node:crypto';
import { type } from 'arktype';
import { kubernetesComposition } from '../../core/composition/imperative.js';
import { setMetadataField } from '../../core/metadata/resource-metadata.js';
import { Cel } from '../../core/references/cel.js';
import type { KubernetesResource } from '../../core/types/index.js';
import { customResourceDefinitionReadinessEvaluator } from '../kubernetes/extensions/custom-resource-definition.js';
import { createResource } from '../shared.js';
import {
  substrateDaemonSetReadiness,
  substrateDeploymentReadiness,
  substrateSandboxConfigReadiness,
  substrateWorkerPoolReadiness,
} from './readiness.js';

export const agentSubstrateVersion = 'v1.0.0';
export const agentSubstrateCommit = 'b34fbee742906494b5eb4f1f36987176bf8770a4';

const clusterKinds = new Set(['Namespace', 'CustomResourceDefinition', 'ClusterRole', 'ClusterRoleBinding', 'SandboxConfig', 'PriorityClass']);
const substrateCrdNames = new Set(['workerpools.ate.dev', 'sandboxconfigs.ate.dev', 'csidriverconfigs.ate.dev']);
const controlPlane = ['ate-api-server', 'ate-idp-server', 'atenet-router', 'atenet-egress', 'ate-controller'] as const;
const immutableImage = /@sha256:[0-9a-f]{64}$/u;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

interface PodWorkloadSpec {
  readonly replicas?: number;
  readonly template?: { readonly spec?: {
    readonly containers?: readonly { readonly image?: string; readonly readinessProbe?: { readonly httpGet?: { readonly path?: string } } }[];
    readonly initContainers?: readonly { readonly image?: string }[];
  } };
}

export interface AgentSubstrateInstallationBundle {
  /** The release commit used to render the Kubernetes bundle. */
  readonly sourceCommit: typeof agentSubstrateCommit;
  readonly namespace: string;
  /** Set when the installation owns the release's pod certificate controller. */
  readonly certificateControllerNamespace?: string;
  /** Rendered release objects plus the selected WorkerPool and private storage references. */
  readonly manifests: readonly KubernetesResource[];
}

function phase(resource: KubernetesResource): number {
  if (resource.kind === 'Namespace' || resource.kind === 'CustomResourceDefinition') return 0;
  if (resource.kind === 'SandboxConfig' || resource.kind === 'Job' || resource.kind === 'StatefulSet') return 2;
  if (resource.kind === 'DaemonSet') return 6;
  if (resource.kind === 'WorkerPool') return 7;
  if (resource.kind !== 'Deployment') return 1;
  if (resource.metadata.name === 'ate-api-server') return 4;
  if (controlPlane.some(name => name === resource.metadata.name)) return 5;
  return 3;
}

function validateBundle(bundle: AgentSubstrateInstallationBundle): void {
  const namespaces = new Set([bundle.namespace, ...(bundle.certificateControllerNamespace ? [bundle.certificateControllerNamespace] : [])]);
  if (bundle.sourceCommit !== agentSubstrateCommit || [...namespaces].some(namespace => !dnsLabel.test(namespace))) {
    throw new Error('Agent Substrate requires a v1.0.0 installation bundle and a concrete namespace.');
  }
  const seen = new Set<string>();
  for (const manifest of bundle.manifests) {
    const { apiVersion, kind, metadata } = manifest;
    if (!apiVersion || !metadata.name || metadata.deletionTimestamp || manifest.status !== undefined
      || ['Actor', 'Actors', 'ActorTemplate', 'Worker', 'EgressPolicy', 'Secret'].includes(kind)) {
      throw new Error('The Agent Substrate installation requires clean Kubernetes manifests and references to externally held Secrets.');
    }
    if (kind === 'CustomResourceDefinition' && !substrateCrdNames.has(metadata.name)) {
      throw new Error('The bundle contains an unrelated custom resource definition.');
    }
    if ((kind === 'WorkerPool' || kind === 'SandboxConfig') && apiVersion !== 'ate.dev/v1') {
      throw new Error('The Agent Substrate bundle has an unsupported API version.');
    }
    if (kind === 'Namespace' && !namespaces.has(metadata.name)) {
      throw new Error('The bundle can own only its selected namespace.');
    }
    if (clusterKinds.has(kind) ? metadata.namespace !== undefined : !metadata.namespace || !namespaces.has(metadata.namespace)) {
      throw new Error('An Agent Substrate resource is outside its installation namespace or scope.');
    }
    if (kind === 'Deployment' || kind === 'DaemonSet' || kind === 'StatefulSet' || kind === 'Job') {
      const pod = (manifest.spec as PodWorkloadSpec | undefined)?.template?.spec;
      const containers = [...(pod?.containers ?? []), ...(pod?.initContainers ?? [])];
      if (!containers.length || containers.some(container => !container.image || !immutableImage.test(container.image))) {
        throw new Error('Agent Substrate workload images must be pinned by digest.');
      }
      if (kind === 'Deployment' && metadata.name === 'ate-api-server'
        && !pod?.containers?.some(container => container.readinessProbe?.httpGet?.path === '/readyz')) {
        throw new Error('The Agent Substrate API rollout must observe the release readiness check.');
      }
    }
    const key = `${metadata.namespace ?? ''}/${kind}/${metadata.name}`;
    if (seen.has(key)) throw new Error('The Agent Substrate bundle has a duplicate Kubernetes resource.');
    seen.add(key);
  }
  const required = [
    '/CustomResourceDefinition/workerpools.ate.dev', '/CustomResourceDefinition/sandboxconfigs.ate.dev',
    ...['DaemonSet/atelet', 'Service/api', 'Service/atenet-router', 'Service/atenet-egress',
      ...controlPlane.map(name => `Deployment/${name}`)].map(name => `${bundle.namespace}/${name}`),
  ];
  if (!required.every(key => seen.has(key)) || !bundle.manifests.some(resource => resource.kind === 'WorkerPool')
    || !bundle.manifests.some(resource => resource.kind === 'SandboxConfig')
    || !bundle.manifests.some(resource => resource.kind === 'NetworkPolicy')) {
    throw new Error('The pinned installation bundle is incomplete.');
  }
}

/** Install the exact release bundle through TypeKro's owned Kubernetes lifecycle. */
export function agentSubstrateInstallation(bundle: AgentSubstrateInstallationBundle) {
  validateBundle(bundle);
  const manifests = structuredClone(bundle.manifests);
  return kubernetesComposition({
    name: 'agent-substrate-installation-v1', kind: 'AgentSubstrateInstallation',
    spec: type({}), status: type({ ready: 'boolean' }),
  }, () => {
    const groups = new Map<number, string[]>();
    const pools = [];
    for (const manifest of [...manifests].sort((left, right) => phase(left) - phase(right))) {
      const id = `substrate${createHash('sha256').update(`${manifest.metadata.namespace ?? ''}/${manifest.kind}/${manifest.metadata.name}`).digest('hex').slice(0, 16)}`;
      const clusterScoped = clusterKinds.has(manifest.kind);
      const resource = createResource<{ replicas: number }, { readyReplicas: number }>({
        ...manifest, id, spec: manifest.spec as { replicas: number },
      }, { scope: clusterScoped ? 'cluster' : 'namespaced' });
      if (clusterScoped) setMetadataField(resource, 'scopes', ['agent-substrate-cluster']);
      if (manifest.kind === 'CustomResourceDefinition') resource.withReadinessEvaluator(customResourceDefinitionReadinessEvaluator);
      if (manifest.kind === 'Deployment') resource.withReadinessEvaluator(substrateDeploymentReadiness);
      if (manifest.kind === 'DaemonSet') resource.withReadinessEvaluator(substrateDaemonSetReadiness);
      if (manifest.kind === 'SandboxConfig') resource.withReadinessEvaluator(substrateSandboxConfigReadiness);
      if (manifest.kind === 'WorkerPool') {
        resource.withReadinessEvaluator(substrateWorkerPoolReadiness);
        pools.push(Cel.expr<boolean>(resource.status.readyReplicas, ' == ', resource.spec.replicas));
      }
      const order = phase(manifest);
      // The direct graph uses these same edges in reverse to remove owned resources.
      for (const [prior, dependencies] of groups) {
        if (prior < order) for (const dependency of dependencies) resource.dependsOn(dependency);
      }
      const peers = groups.get(order);
      if (peers) peers.push(id);
      else groups.set(order, [id]);
    }
    return { ready: pools.reduce((left, right) => Cel.expr<boolean>(left, ' && ', right)) };
  });
}
