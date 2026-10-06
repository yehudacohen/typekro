/**
 * Karpenter against the real CRDs — cluster-gated.
 *
 * Karpenter cannot provision nodes outside AWS, so this suite proves what a
 * cluster without EC2 can prove:
 *
 * 1. The pinned `karpenter-crd` chart installs from the official OCI registry
 *    through the singleton `HelmRepository` and `karpenterCrdHelmRelease`.
 * 2. The manifests `nodePool` and `ec2NodeClass` render (direct mode) pass
 *    server-side dry-run against those CRDs, OpenAPI and CEL rules included.
 * 3. Specs the validators reject are rejected by the CRDs too.
 * 4. KRO accepts the RGDs — the bootstrap, its singleton and a NodePool /
 *    EC2NodeClass composition — and reports them `Active`, which means KRO
 *    type-checked every CEL path against the live CRD schemas.
 *
 * Prerequisites: the `bun run scripts/e2e-setup.ts` environment (Flux, KRO)
 * and outbound access to public.ecr.aws.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type } from 'arktype';
import { loadAll } from 'js-yaml';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../src/core/config/defaults.js';
import { singleton } from '../../../src/core/singleton/singleton.js';
import { helmReleaseConditionSummary } from '../../../src/factories/helm/status.js';
import {
  karpenterBootstrap,
  karpenterHelmRepositoryBootstrap,
} from '../../../src/factories/karpenter/compositions/index.js';
import {
  DEFAULT_KARPENTER_REPOSITORY_NAME,
  DEFAULT_KARPENTER_REPOSITORY_URL,
  KARPENTER_DISCOVERY_TAG,
  KARPENTER_LABELS,
} from '../../../src/factories/karpenter/constants.js';
import {
  ec2NodeClass,
  karpenterCrdHelmRelease,
  nodePool,
} from '../../../src/factories/karpenter/resources/index.js';
import { karpenterReady } from '../../../src/factories/karpenter/resources/readiness.js';
import {
  validateEC2NodeClassSpec,
  validateNodePoolSpec,
} from '../../../src/factories/karpenter/utils/validation.js';
import type { EC2NodeClassSpec, NodePoolSpec } from '../../../src/factories/karpenter/types.js';
import { resourceGraphDefinition } from '../../../src/factories/kro/resource-graph-definition.js';
import {
  createCustomObjectsApiClient,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

const describeOrSkip = (await isClusterAvailable()) ? describe : describe.skip;
setDefaultTimeout(600_000);

const runToken = Date.now().toString(36).slice(-6);
const crdInstallName = `karpenter-crds-${runToken}`;
const rgdInstallName = `karpenter-rgds-${runToken}`;

interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; [key: string]: unknown };
  spec?: Record<string, unknown>;
}

const PLURALS: Record<string, string> = { NodePool: 'nodepools', EC2NodeClass: 'ec2nodeclasses' };

/** A composition using both CRD factories, as a consumer would. */
const capacity = kubernetesComposition(
  {
    name: 'karpenter-e2e-capacity',
    kind: 'KarpenterE2ECapacity',
    spec: type({ clusterName: 'string', nodeRole: 'string' }),
    status: type({ ready: 'boolean', nodes: 'number' }),
  },
  (spec) => {
    const nodeClass = ec2NodeClass({
      name: `e2e-${runToken}`,
      spec: {
        role: spec.nodeRole,
        amiSelectorTerms: [{ alias: 'al2023@latest' }],
        subnetSelectorTerms: [{ tags: { [KARPENTER_DISCOVERY_TAG]: spec.clusterName } }],
        securityGroupSelectorTerms: [{ tags: { [KARPENTER_DISCOVERY_TAG]: spec.clusterName } }],
        blockDeviceMappings: [
          {
            deviceName: '/dev/xvda',
            rootVolume: true,
            ebs: { volumeSize: '50Gi', volumeType: 'gp3' },
          },
        ],
        metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1 },
        kubelet: {
          maxPods: 110,
          systemReserved: { cpu: '100m' },
          evictionHard: { 'memory.available': '5%' },
        },
        tags: { cluster: spec.clusterName },
      },
      id: 'nodeClass',
    });
    const spot = nodePool({
      name: `e2e-spot-${runToken}`,
      spec: {
        template: {
          metadata: { labels: { workload: 'batch' } },
          spec: {
            nodeClassRef: { name: `e2e-${runToken}` },
            requirements: [
              { key: KARPENTER_LABELS.capacityType, operator: 'In', values: ['spot'] },
              { key: KARPENTER_LABELS.instanceCategory, operator: 'In', values: ['c', 'm', 'r'] },
              { key: KARPENTER_LABELS.instanceGeneration, operator: 'Gt', values: ['5'] },
              { key: KARPENTER_LABELS.instanceFamily, operator: 'Exists', minValues: 3 },
            ],
            taints: [{ key: 'workload', value: 'batch', effect: 'NoSchedule' }],
            startupTaints: [{ key: 'node.example.com/initializing', effect: 'NoExecute' }],
            expireAfter: '168h',
            terminationGracePeriod: '1h',
          },
        },
        disruption: {
          consolidationPolicy: 'WhenEmptyOrUnderutilized',
          consolidateAfter: '1m',
          budgets: [
            { nodes: '20%' },
            {
              nodes: '0',
              schedule: '0 8 * * mon-fri',
              duration: '10h',
              reasons: ['Underutilized'],
            },
          ],
        },
        limits: { cpu: '400', memory: '1600Gi' },
        weight: 10,
      },
      id: 'spotPool',
    });
    return { ready: karpenterReady(nodeClass, spot), nodes: spot.status.nodes };
  }
);

/** Installs only the CRDs, through the same Helm resources the bootstrap uses. */
const crdInstall = kubernetesComposition(
  {
    name: 'karpenter-e2e-crds',
    kind: 'KarpenterE2ECrds',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean', phase: 'string' }),
  },
  (spec) => {
    singleton(karpenterHelmRepositoryBootstrap, {
      id: 'karpenterHelmRepository',
      spec: {
        name: DEFAULT_KARPENTER_REPOSITORY_NAME,
        namespace: DEFAULT_FLUX_NAMESPACE,
        url: DEFAULT_KARPENTER_REPOSITORY_URL,
      },
    });
    // No `helm.sh/resource-policy: keep`, so teardown removes the CRDs again.
    const crds = karpenterCrdHelmRelease({
      name: spec.name,
      targetNamespace: 'kube-system',
      id: 'crds',
    });
    const summary = helmReleaseConditionSummary(crds);
    return { ready: summary.ready, phase: summary.phase };
  }
);

function manifests(yaml: string): Manifest[] {
  return (loadAll(yaml) as Manifest[]).filter((doc) => doc && typeof doc === 'object');
}

async function dryRun(manifest: Manifest): Promise<{ ok: boolean; message: string }> {
  const [group, version] = manifest.apiVersion.split('/');
  try {
    await createCustomObjectsApiClient(getIntegrationTestKubeConfig()).createClusterCustomObject({
      group: group ?? '',
      version: version ?? '',
      plural: PLURALS[manifest.kind] ?? '',
      body: manifest,
      dryRun: 'All',
      fieldValidation: 'Strict',
    });
    return { ok: true, message: '' };
  } catch (error: unknown) {
    const candidate = error as { body?: unknown; message?: string };
    return { ok: false, message: JSON.stringify(candidate.body ?? candidate.message ?? error) };
  }
}

describeOrSkip('Karpenter CRDs (pinned karpenter-crd chart)', () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    const kubeConfig = getIntegrationTestKubeConfig();
    const factory = crdInstall.factory('direct', {
      namespace: DEFAULT_FLUX_NAMESPACE,
      kubeConfig,
      waitForReady: true,
      timeout: 300_000,
    });
    cleanups.push(() =>
      deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        crdInstallName,
        [],
        kubeConfig,
        120_000
      )
    );
    const instance = await factory.deploy({ name: crdInstallName });
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Karpenter e2e cleanup failed');
  });

  it('accepts the rendered NodePool and EC2NodeClass', async () => {
    const docs = manifests(
      capacity
        .factory('direct', { namespace: 'default' })
        .toYaml({ clusterName: 'e2e', nodeRole: 'KarpenterNodeRole-e2e' })
    );
    expect(docs.map((doc) => doc.kind).sort()).toEqual(['EC2NodeClass', 'NodePool']);
    for (const doc of docs) {
      expect(await dryRun(doc)).toEqual({ ok: true, message: '' });
    }
  });

  it('rejects in the API server what the validators reject', async () => {
    const badPoolSpec: NodePoolSpec = {
      template: {
        spec: {
          nodeClassRef: { group: 'karpenter.k8s.aws', kind: 'EC2NodeClass', name: 'x' },
          requirements: [{ key: KARPENTER_LABELS.instanceCpu, operator: 'Gt', values: ['4', '8'] }],
        },
      },
    };
    const badClassSpec: EC2NodeClassSpec = {
      role: 'r',
      amiSelectorTerms: [{ alias: 'al2023@latest' }, { id: 'ami-0123456789abcdef0' }],
      subnetSelectorTerms: [{ tags: { a: 'b' } }],
      securityGroupSelectorTerms: [{ tags: { a: 'b' } }],
    };
    const badPool: Manifest = {
      apiVersion: 'karpenter.sh/v1',
      kind: 'NodePool',
      metadata: { name: `e2e-bad-${runToken}` },
      spec: { ...badPoolSpec },
    };
    const badClass: Manifest = {
      apiVersion: 'karpenter.k8s.aws/v1',
      kind: 'EC2NodeClass',
      metadata: { name: `e2e-bad-${runToken}` },
      spec: { ...badClassSpec },
    };

    const poolIssues = validateNodePoolSpec(badPoolSpec);
    const classIssues = validateEC2NodeClassSpec(badClassSpec);
    expect(poolIssues.some((issue) => issue.severity === 'error')).toBe(true);
    expect(classIssues.some((issue) => issue.severity === 'error')).toBe(true);
    expect((await dryRun(badPool)).ok).toBe(false);
    expect((await dryRun(badClass)).ok).toBe(false);
  });

  it('KRO accepts the Karpenter RGDs against the live CRD schemas', async () => {
    const kubeConfig = getIntegrationTestKubeConfig();
    const rgds = [
      karpenterHelmRepositoryBootstrap.toYaml(),
      karpenterBootstrap.toYaml(),
      capacity.toYaml(),
    ]
      .flatMap(manifests)
      .filter((doc) => doc.kind === 'ResourceGraphDefinition');
    const names = [...new Set(rgds.map((rgd) => rgd.metadata.name))];
    expect(names.sort()).toEqual([
      'karpenter-bootstrap',
      'karpenter-e2e-capacity',
      'karpenter-helm-repository',
    ]);

    const installer = kubernetesComposition(
      {
        name: 'karpenter-e2e-rgds',
        kind: 'KarpenterE2ERgds',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      () => {
        const install = (name: string, id: string) =>
          resourceGraphDefinition({
            id,
            metadata: { name },
            spec: rgds.find((rgd) => rgd.metadata.name === name)?.spec ?? {},
          });
        const repository = install('karpenter-helm-repository', 'repositoryRgd');
        // The bootstrap's externalRef needs the singleton's generated CRD first.
        install('karpenter-bootstrap', 'bootstrapRgd').dependsOn(repository);
        install('karpenter-e2e-capacity', 'capacityRgd');
        return { ready: true };
      }
    );
    const factory = installer.factory('direct', {
      namespace: 'default',
      kubeConfig,
      waitForReady: true,
      timeout: 180_000,
    });
    cleanups.push(() =>
      deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        rgdInstallName,
        [],
        kubeConfig,
        120_000,
        {
          scopes: ['cluster'],
          includeUnscopedResources: true,
        }
      )
    );
    await factory.deploy({ name: rgdInstallName });

    const customApi = createCustomObjectsApiClient(kubeConfig);
    for (const name of names) {
      const raw = (await customApi.getClusterCustomObject({
        group: 'kro.run',
        version: 'v1alpha1',
        plural: 'resourcegraphdefinitions',
        name,
      })) as { body?: { status?: { state?: string } }; status?: { state?: string } };
      const rgd = raw.body ?? raw;
      expect({ name, state: rgd.status?.state }).toEqual({ name, state: 'Active' });
    }
  });
});
