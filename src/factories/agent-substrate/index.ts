import type { V1ResourceRequirements, V1Toleration } from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../../core/composition/imperative.js';
import { TypeKroError } from '../../core/errors.js';
import { setMetadataField, setReadinessEvaluator } from '../../core/metadata/resource-metadata.js';
import { Cel } from '../../core/references/cel.js';
import type { CallableComposition } from '../../core/types/deployment.js';
import type { KubernetesResource } from '../../core/types/index.js';
import { createResource } from '../shared.js';
import { substrateReadiness, substrateReadyCel, type SubstrateReadinessKind } from './readiness.js';
import type { AgentSubstrateManifest, AgentSubstrateReleaseDocument } from './release.js';
import { verifyAgentSubstrateRelease } from './release.js';
import { agentSubstrateV1_0_0 as release } from './releases/v1.0.0.js';

export const agentSubstrateVersion = 'v1.0.0';
export const agentSubstrateCommit = 'b34fbee742906494b5eb4f1f36987176bf8770a4';
/** Canonical sha256 of the reviewed v1.0.0 bundle; see `README.md` in this directory. */
export const agentSubstrateBundleSha256 =
  'efafeb40b52f619855adcd5d5f0c2c0ebae795dff216f01b030ce4c44af7c7e5';
/**
 * The control-plane namespace. The release's manifests, flags, Service DNS names and pod
 * certificate identities name it literally, so the installation is not relocatable.
 */
export const agentSubstrateNamespace = 'ate-system';

/** A gVisor WorkerPool running the release's `ateworker-gvisor` image. */
export interface AgentSubstrateWorkerPool {
  /** The pool's namespace, which the installation creates and owns. */
  readonly namespace: string;
  /** At most 63 characters, as the WorkerPool API requires. */
  readonly name: string;
  /** Worker pods to run; zero is allowed. */
  readonly replicas: number;
  /** A gVisor SandboxConfig. Omitted, the pool resolves the class default, `gvisor-default`. */
  readonly sandboxConfig?: string;
  readonly nodeSelector?: Readonly<Record<string, string>>;
  readonly tolerations?: readonly V1Toleration[];
  readonly resources?: V1ResourceRequirements;
}

export interface AgentSubstrateInstallationOptions {
  /**
   * SPIFFE IDs (exact match) of the clients the ingress router lets reach actors, passed as
   * `--ingress-allowed-spiffe-ids`. Unset, no client may reach actors through the router.
   * This is the only value substituted into the release's own objects.
   */
  readonly ingressAllowedSpiffeIds?: readonly string[];
  readonly workerPools?: readonly AgentSubstrateWorkerPool[];
}

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const dnsSubdomain =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u;
const spiffeId = /^spiffe:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._~%!$&'()*+;=:@-]+)+$/u;
const reservedNamespaces = new Set(['default', 'kube-system', 'kube-public', 'kube-node-lease']);

function refuse(message: string, context: Record<string, unknown>): never {
  throw new TypeKroError(message, 'AGENT_SUBSTRATE_INVALID_OPTIONS', context);
}

function validateOptions(options: AgentSubstrateInstallationOptions): void {
  const ids = options.ingressAllowedSpiffeIds ?? [];
  for (const id of ids) {
    if (!spiffeId.test(id)) refuse(`${JSON.stringify(id)} is not a SPIFFE ID.`, { id });
  }
  if (new Set(ids).size !== ids.length) refuse('The ingress SPIFFE IDs repeat.', { ids });
  const bundleNamespaces = new Set(
    release.documents
      .filter(({ manifest }) => manifest.kind === 'Namespace')
      .map(({ manifest }) => manifest.metadata.name)
  );
  const pools = new Set<string>();
  for (const pool of options.workerPools ?? []) {
    const where = `WorkerPool ${pool.namespace}/${pool.name}`;
    if (!dnsLabel.test(pool.namespace) || !dnsLabel.test(pool.name)) {
      refuse(`${where} needs a namespace and name that are DNS labels.`, { ...pool });
    }
    if (
      bundleNamespaces.has(pool.namespace) ||
      reservedNamespaces.has(pool.namespace) ||
      pool.namespace.startsWith('kube-')
    ) {
      refuse(`${where} must be in a namespace of its own, not ${pool.namespace}.`, { ...pool });
    }
    if (!Number.isSafeInteger(pool.replicas) || pool.replicas < 0) {
      refuse(`${where} needs a whole, non-negative replica count.`, { ...pool });
    }
    if (pool.sandboxConfig !== undefined && !dnsSubdomain.test(pool.sandboxConfig)) {
      refuse(`${where} names an invalid SandboxConfig.`, { ...pool });
    }
    const key = `${pool.namespace}/${pool.name}`;
    if (pools.has(key)) refuse(`${where} is declared twice.`, { ...pool });
    pools.add(key);
  }
}

/** The release objects with the ingress allowlist substituted into the router's arguments. */
function releaseObjects(
  options: AgentSubstrateInstallationOptions
): AgentSubstrateReleaseDocument[] {
  const documents = structuredClone(release.documents) as AgentSubstrateReleaseDocument[];
  const ids = options.ingressAllowedSpiffeIds ?? [];
  if (ids.length === 0) return documents;
  const router = documents.find(
    ({ manifest }) =>
      manifest.kind === 'Deployment' &&
      manifest.metadata.name === 'atenet-router' &&
      manifest.metadata.namespace === agentSubstrateNamespace
  )?.manifest as
    | { spec: { template: { spec: { containers: { name: string; args: string[] }[] } } } }
    | undefined;
  const container = router?.spec.template.spec.containers[0];
  if (container?.name !== 'atenet-router') {
    throw new TypeKroError(
      'The release has no atenet-router container to take the ingress allowlist.',
      'AGENT_SUBSTRATE_BUNDLE_MODIFIED',
      {}
    );
  }
  const preview = container.args.indexOf('--preview=');
  container.args.splice(
    preview < 0 ? container.args.length : preview,
    0,
    `--ingress-allowed-spiffe-ids=${ids.join(',')}`
  );
  return documents;
}

function workerPoolObjects(
  pools: readonly AgentSubstrateWorkerPool[]
): AgentSubstrateReleaseDocument[] {
  const namespaces = [...new Set(pools.map((pool) => pool.namespace))].sort();
  return [
    ...namespaces.map(
      (name): AgentSubstrateReleaseDocument => ({
        source: 'typekro',
        scope: 'Cluster',
        manifest: { apiVersion: 'v1', kind: 'Namespace', metadata: { name } },
      })
    ),
    ...pools.map(
      (pool): AgentSubstrateReleaseDocument => ({
        source: 'typekro',
        scope: 'Namespaced',
        manifest: {
          apiVersion: 'ate.dev/v1',
          kind: 'WorkerPool',
          metadata: { name: pool.name, namespace: pool.namespace },
          spec: {
            replicas: pool.replicas,
            workerImage: release.images['ateworker-gvisor'],
            sandboxClasses: [
              {
                name: 'gvisor',
                ...(pool.sandboxConfig ? { configRef: { name: pool.sandboxConfig } } : {}),
              },
            ],
            ...(pool.nodeSelector || pool.tolerations || pool.resources
              ? {
                  template: {
                    ...(pool.nodeSelector ? { nodeSelector: { ...pool.nodeSelector } } : {}),
                    ...(pool.tolerations ? { tolerations: structuredClone(pool.tolerations) } : {}),
                    ...(pool.resources ? { resources: structuredClone(pool.resources) } : {}),
                  },
                }
              : {}),
          },
        },
      })
    ),
  ];
}

/**
 * Apply order, as `ate-setup deploy ate-system` applies it: namespaces, CRDs, then RBAC,
 * configuration, Services, policies and the SandboxConfig admission policy, then the
 * SandboxConfig, the pod certificate controller, the control plane, and the WorkerPools.
 */
function phase({ kind, metadata }: AgentSubstrateManifest): number {
  if (kind === 'Namespace') return 0;
  if (kind === 'CustomResourceDefinition') return 1;
  if (kind === 'SandboxConfig') return 3;
  if (kind === 'Deployment' && metadata.name === 'podcertificate-controller') return 4;
  if (kind === 'Deployment' || kind === 'DaemonSet') return 5;
  if (kind === 'WorkerPool') return 6;
  return 2;
}

const readinessKinds = new Set<string>([
  'CustomResourceDefinition',
  'Deployment',
  'DaemonSet',
  'SandboxConfig',
  'WorkerPool',
]);

function pascal(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}

function resourceId({ kind, metadata }: AgentSubstrateManifest): string {
  return `substrate${pascal(kind)}${kind === 'WorkerPool' ? pascal(metadata.namespace ?? '') : ''}${pascal(metadata.name)}`;
}

let verified = false;

/**
 * Install the reviewed Agent Substrate v1.0.0 bundle through TypeKro's Kubernetes lifecycle.
 *
 * The bundle is the release rendered from its tagged commit with digest-pinned release images
 * (see `README.md`). It is checked against {@link agentSubstrateBundleSha256} before use. Root
 * `status.ready` is true when every CRD, rollout, SandboxConfig and WorkerPool is ready by the
 * same predicates the resource-level evaluators run.
 */
export function agentSubstrateInstallation(
  options: AgentSubstrateInstallationOptions = {}
): CallableComposition<object, { ready: boolean }> {
  if (!verified) {
    verifyAgentSubstrateRelease(release, agentSubstrateBundleSha256);
    verified = true;
  }
  validateOptions(options);
  const documents = [...releaseObjects(options), ...workerPoolObjects(options.workerPools ?? [])];
  return kubernetesComposition(
    {
      name: 'agent-substrate-installation-v1',
      kind: 'AgentSubstrateInstallation',
      spec: type({}),
      status: type({ ready: 'boolean' }),
    },
    () => {
      const ids = new Set<string>();
      const ready: string[] = [];
      const phases = new Map<
        number,
        { id: string; resource: { dependsOn(id: string): unknown } }[]
      >();
      for (const { scope, manifest } of documents) {
        const id = resourceId(manifest);
        if (ids.has(id)) {
          throw new TypeKroError(
            `Two installation objects share the id ${id}.`,
            'AGENT_SUBSTRATE_DUPLICATE_ID',
            { id }
          );
        }
        ids.add(id);
        const resource = createResource(
          { ...manifest, id } as unknown as KubernetesResource<
            Record<string, unknown>,
            Record<string, unknown>
          >,
          { scope: scope === 'Cluster' ? 'cluster' : 'namespaced' }
        );
        if (scope === 'Cluster') setMetadataField(resource, 'scopes', ['agent-substrate-cluster']);
        if (readinessKinds.has(manifest.kind)) {
          const kind = manifest.kind as SubstrateReadinessKind;
          setReadinessEvaluator(resource, substrateReadiness[kind]);
          ready.push(`(${substrateReadyCel(kind, id)})`);
        }
        const order = phase(manifest);
        const members = phases.get(order) ?? [];
        members.push({ id, resource });
        phases.set(order, members);
      }
      // Each phase waits for the one before it. Namespaces are never an explicit dependsOn
      // target: namespaced objects already wait for their Namespace.
      const ordered = [...phases.keys()].sort((left, right) => left - right);
      let previous: string[] = [];
      for (const order of ordered) {
        const members = phases.get(order) ?? [];
        for (const { resource } of members) for (const id of previous) resource.dependsOn(id);
        if (order !== 0) previous = members.map(({ id }) => id);
      }
      return { ready: Cel.expr<boolean>(ready.join(' && ')) };
    }
  );
}
