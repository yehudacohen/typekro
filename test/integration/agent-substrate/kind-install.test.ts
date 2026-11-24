/**
 * Installs the pinned Agent Substrate v1.0.0 bundle on a disposable cluster through the direct
 * factory, then uninstalls it.
 *
 * The API server admits every object (built-in schemas, the bundle's CRD schemas and CEL rules,
 * and the bundle's own ValidatingAdmissionPolicy), the CRDs become established, and the root
 * readiness computed from the live objects agrees with the resource-level evaluators. The control
 * plane does not become ready here: its CA pools, JWT pool, ConfigMaps, PostgreSQL and snapshot
 * store belong to their own owners and are not created.
 *
 * It installs cluster-scoped objects, so it runs only when asked, on a throwaway cluster:
 *
 *   kind create cluster --name typekro-substrate --config test/fixtures/agent-substrate/kind-cluster.yaml
 *   bun run test:integration:agent-substrate
 *   kind delete cluster --name typekro-substrate
 *
 * CI does not run it: the CI workflow has no Kubernetes cluster.
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { loadAll } from 'js-yaml';

setDefaultTimeout(900_000);

import { CEL_EXPRESSION_BRAND } from '../../../src/core/constants/brands.js';
import { CelEvaluator } from '../../../src/core/references/cel-evaluator.js';
import {
  type AgentSubstrateInstallationOptions,
  agentSubstrateInstallation,
} from '../../../src/factories/agent-substrate/index.js';
import {
  type SubstrateReadinessKind,
  substrateReadiness,
} from '../../../src/factories/agent-substrate/readiness.js';
import {
  createKubernetesObjectApiClient,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  isNotFoundError,
} from '../shared-kubeconfig.js';

// Asked for (TYPEKRO_AGENT_SUBSTRATE_LIVE=true) and no cluster: fail, never skip silently.
const requested = process.env.TYPEKRO_AGENT_SUBSTRATE_LIVE === 'true';
const available = requested && (await isClusterAvailable());
const enabled = available;
const describeOrSkip = requested ? describe : describe.skip;

const options: AgentSubstrateInstallationOptions = {
  ingressAllowedSpiffeIds: ['spiffe://cluster.local/ns/agents/sa/client'],
  workerPools: [{ namespace: 'typekro-substrate-agents', name: 'pool', replicas: 0 }],
};

/** Whether the error, or anything it wraps, is the ownership refusal. */
function refusesOwnership(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const candidate = error as {
    name?: string;
    cause?: unknown;
    errors?: unknown[];
    context?: unknown;
  };
  return (
    candidate.name === 'ResourceOwnershipError' ||
    refusesOwnership(candidate.cause, seen) ||
    (candidate.errors ?? []).some((inner) => refusesOwnership(inner, seen)) ||
    refusesOwnership(candidate.context, seen)
  );
}

interface Live {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; deletionTimestamp?: string };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

describeOrSkip('Agent Substrate v1.0.0 on a disposable cluster', () => {
  it('has a cluster to install on', () => {
    expect(available).toBe(true);
  });

  const kubeConfig = enabled ? getIntegrationTestKubeConfig() : undefined;
  const api = enabled ? createKubernetesObjectApiClient(kubeConfig) : undefined;
  const composition = agentSubstrateInstallation(options);
  const factory = composition.factory('direct', {
    ...(kubeConfig ? { kubeConfig } : {}),
    waitForReady: false,
    timeout: 600_000,
  });
  const [rgd] = loadAll(composition.toYaml()) as {
    spec: { schema: { status: { ready: string } }; resources: { id: string; template: Live }[] };
  }[];
  let instanceName: string | undefined;

  afterAll(async () => {
    if (instanceName) {
      await factory.deleteInstance(instanceName, { scopes: ['agent-substrate-cluster'] });
    }
  });

  async function read(object: Live): Promise<Live | undefined> {
    try {
      return (await api?.read({
        apiVersion: object.apiVersion,
        kind: object.kind,
        metadata: {
          name: object.metadata.name,
          ...(object.metadata.namespace ? { namespace: object.metadata.namespace } : {}),
        },
      })) as unknown as Live;
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw error;
    }
  }

  it('admits every object, establishes the CRDs and reports readiness consistently', async () => {
    const instance = (await factory.deploy({})) as { metadata?: { name?: string } };
    instanceName = instance.metadata?.name;
    expect(instanceName).toBeDefined();

    const resources = rgd?.spec.resources ?? [];
    const live = new Map<string, Live>();
    for (const { id, template } of resources) {
      const object = await read(template);
      expect(`${template.kind}/${template.metadata.name} ${object ? 'present' : 'missing'}`).toBe(
        `${template.kind}/${template.metadata.name} present`
      );
      if (object) live.set(id, object);
    }

    const deadline = Date.now() + 120_000;
    const crds = () => [...live.values()].filter(({ kind }) => kind === 'CustomResourceDefinition');
    while (
      Date.now() < deadline &&
      !crds().every((crd) => substrateReadiness.CustomResourceDefinition(crd).ready)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      for (const [id, object] of live) {
        if (object.kind === 'CustomResourceDefinition')
          live.set(id, (await read(object)) ?? object);
      }
    }
    for (const crd of crds())
      expect(substrateReadiness.CustomResourceDefinition(crd).ready).toBe(true);

    const root = await new CelEvaluator().evaluate(
      {
        [CEL_EXPRESSION_BRAND]: true,
        expression: (rgd?.spec.schema.status.ready ?? '').replace(/^\$\{/u, '').replace(/\}$/u, ''),
      } as never,
      { resources: live } as never
    );
    const each = [...live.values()]
      .filter((object) => object.kind in substrateReadiness)
      .map((object) => substrateReadiness[object.kind as SubstrateReadinessKind](object).ready);
    expect(root).toBe(each.every(Boolean));
  });

  it('enforces the bundle admission policy on SandboxConfigs', async () => {
    const config = {
      apiVersion: 'ate.dev/v1',
      kind: 'SandboxConfig',
      metadata: { name: 'typekro-substrate-asset-less' },
      spec: {
        sandboxClass: 'gvisor',
        defaultVersion: 'v1',
        versions: [
          {
            name: 'v1',
            state: 'Enabled',
            assets: {
              amd64: {
                other: { url: 'https://example.test/a', sha256: 'a'.repeat(64) },
              },
            },
          },
        ],
      },
    };
    // The policy is enforced once the API server has loaded it.
    let refusal = '';
    const deadline = Date.now() + 60_000;
    while (!refusal.includes('sandboxconfig-assets') && Date.now() < deadline) {
      try {
        await api?.create(config, undefined, 'All');
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      } catch (error) {
        const body = (error as { body?: unknown }).body;
        const text = typeof body === 'string' ? body : JSON.stringify(body ?? String(error));
        // Only the policy's own refusal ends the wait; anything else (a CRD or the policy not
        // yet served) is retried until the deadline and reported.
        refusal = text;
        if (text.includes('sandboxconfig-assets')) break;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    expect(refusal).toContain('sandboxconfig-assets');
  });

  it('uninstalls every object, cluster-scoped ones included', async () => {
    if (!instanceName) throw new Error('Nothing was installed.');
    await factory.deleteInstance(instanceName, {
      scopes: ['agent-substrate-cluster'],
      timeout: 600_000,
    });
    instanceName = undefined;
    for (const { template } of rgd?.spec.resources ?? []) {
      const object = await read(template);
      // A namespace may still be finalizing; nothing else may remain.
      if (object && template.kind === 'Namespace') {
        expect(object.metadata.deletionTimestamp).toBeDefined();
      } else {
        expect(`${template.kind}/${template.metadata.name} ${object ? 'remains' : 'deleted'}`).toBe(
          `${template.kind}/${template.metadata.name} deleted`
        );
      }
    }
  });
  it('refuses to adopt a pre-existing Namespace it did not create and leaves it untouched', async () => {
    const unowned: Live = {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'agents' },
    };
    expect(await read(unowned)).toBeUndefined();
    await api?.create({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'agents', labels: { owner: 'someone-else' } },
    });
    const before = (await read(unowned)) as Live & { metadata: { resourceVersion?: string } };
    try {
      const guarded = agentSubstrateInstallation({
        workerPools: [{ namespace: 'agents', name: 'default', replicas: 0 }],
      }).factory('direct', {
        ...(kubeConfig ? { kubeConfig } : {}),
        waitForReady: false,
        timeout: 120_000,
      });
      const failure = await guarded.deploy({}).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeDefined();
      expect(refusesOwnership(failure)).toBe(true);
      const after = (await read(unowned)) as Live & { metadata: { resourceVersion?: string } };
      expect(before.metadata.resourceVersion).toBeDefined();
      expect(after.metadata.resourceVersion).toEqual(before.metadata.resourceVersion as string);
      expect(JSON.stringify(after.metadata) ?? '').not.toContain('agent-substrate');
    } finally {
      await api?.delete(unowned as never);
    }
  });
});
