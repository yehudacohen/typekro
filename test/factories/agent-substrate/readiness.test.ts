/**
 * Root `status.ready` of the Agent Substrate installation against the resource-level evaluators.
 *
 * The root expression is read from the emitted graph and run by the direct-mode CEL evaluator over
 * live objects; each object's evaluator runs over the same object. For every state below the
 * root must equal the conjunction of the evaluators, and the state's expected readiness.
 */
import { describe, expect, test } from 'bun:test';
import { loadAll } from 'js-yaml';

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

type Live = Record<string, unknown> & {
  kind: string;
  metadata: Record<string, unknown> & { name: string };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
};

const options: AgentSubstrateInstallationOptions = {
  workerPools: [
    { namespace: 'agents', name: 'default-config', replicas: 2 },
    { namespace: 'agents', name: 'pinned', replicas: 1, sandboxConfig: 'gvisor-default' },
    { namespace: 'idle', name: 'empty', replicas: 0 },
  ],
};

function graph(): { ready: string; resources: Map<string, Live> } {
  const [rgd] = loadAll(agentSubstrateInstallation(options).toYaml()) as {
    spec: { schema: { status: { ready: string } }; resources: { id: string; template: Live }[] };
  }[];
  if (!rgd) throw new Error('No graph emitted.');
  return {
    ready: rgd.spec.schema.status.ready.replace(/^\$\{/u, '').replace(/\}$/u, ''),
    resources: new Map(rgd.spec.resources.map(({ id, template }) => [id, template])),
  };
}

/** A live object that has finished rolling out. */
function settled(template: Live): Live {
  const live = structuredClone(template) as Live;
  live.metadata = { ...live.metadata, generation: 3, uid: 'uid' };
  const replicas = (live.spec?.replicas as number | undefined) ?? 1;
  switch (live.kind) {
    case 'CustomResourceDefinition':
      live.status = {
        conditions: [
          { type: 'NamesAccepted', status: 'True' },
          { type: 'Established', status: 'True' },
        ],
      };
      break;
    case 'Deployment':
      live.spec = { ...live.spec, replicas };
      live.status = {
        observedGeneration: 3,
        replicas,
        updatedReplicas: replicas,
        readyReplicas: replicas,
        availableReplicas: replicas,
      };
      break;
    case 'DaemonSet':
      live.status = {
        observedGeneration: 3,
        desiredNumberScheduled: 4,
        currentNumberScheduled: 4,
        updatedNumberScheduled: 4,
        numberReady: 4,
        numberAvailable: 4,
        numberMisscheduled: 0,
      };
      break;
    case 'WorkerPool': {
      const wanted = (
        live.spec?.sandboxClasses as { name: string; configRef?: { name: string } }[]
      )[0];
      live.status = {
        replicas,
        // readyReplicas is omitted when zero, as the API serializes it.
        ...(replicas > 0 ? { readyReplicas: replicas } : {}),
        selector: 'pool=x',
        sandboxClasses: [
          {
            name: wanted?.name,
            configRef: { name: wanted?.configRef?.name ?? 'gvisor-default' },
            conditions: [
              { type: 'Resolved', status: 'True', reason: 'Resolved', observedGeneration: 3 },
            ],
          },
        ],
      };
      break;
    }
  }
  return live;
}

const evaluator = new CelEvaluator();
const { ready, resources } = graph();

async function check(change: (live: Map<string, Live>) => void, expected: boolean) {
  const live = new Map([...resources].map(([id, template]) => [id, settled(template)]));
  change(live);
  const root = await evaluator.evaluate(
    { [CEL_EXPRESSION_BRAND]: true, expression: ready } as never,
    { resources: live } as never
  );
  const each = [...live.values()]
    .filter((object): object is Live => object.kind in substrateReadiness)
    .map((object) => substrateReadiness[object.kind as SubstrateReadinessKind](object).ready);
  expect(root).toBe(each.every(Boolean));
  expect(root).toBe(expected);
}

function find(live: Map<string, Live>, kind: string, name: string): Live {
  const object = [...live.values()].find(
    (item) => item.kind === kind && item.metadata.name === name
  );
  if (!object) throw new Error(`No ${kind}/${name}.`);
  return object;
}

function poolClass(pool: Live) {
  return (pool.status?.sandboxClasses as Record<string, unknown>[])[0] as Record<
    string,
    unknown
  > & {
    conditions: Record<string, unknown>[];
  };
}

describe('Agent Substrate root readiness agrees with the resource evaluators', () => {
  test('is ready once everything has settled, including a zero-replica pool', async () => {
    await check(() => {}, true);
  });

  test('waits for a CRD to be established', async () => {
    await check((live) => {
      find(live, 'CustomResourceDefinition', 'workerpools.ate.dev').status = {
        conditions: [{ type: 'NamesAccepted', status: 'True' }],
      };
    }, false);
  });

  test('waits for a control-plane rollout: new generation, old pods, or unavailable pods', async () => {
    await check((live) => {
      find(live, 'Deployment', 'ate-api-server').metadata.generation = 4;
    }, false);
    await check((live) => {
      const status = find(live, 'Deployment', 'atenet-router').status as Record<string, number>;
      status.replicas = (status.replicas ?? 0) + 1;
    }, false);
    await check((live) => {
      const status = find(live, 'Deployment', 'podcertificate-controller').status as Record<
        string,
        number
      >;
      status.availableReplicas = 0;
    }, false);
    await check((live) => {
      delete find(live, 'Deployment', 'ate-controller').status;
    }, false);
  });

  test('waits for the node rollout', async () => {
    await check((live) => {
      (find(live, 'DaemonSet', 'atelet').status as Record<string, number>).updatedNumberScheduled =
        3;
    }, false);
  });

  test('waits for worker pods, including a pool scaled up from zero', async () => {
    await check((live) => {
      delete (find(live, 'WorkerPool', 'default-config').status as Record<string, unknown>)
        .readyReplicas;
    }, false);
    await check((live) => {
      const pool = find(live, 'WorkerPool', 'empty');
      pool.spec = { ...pool.spec, replicas: 1 };
    }, false);
  });

  test('is not ready while a config switch is pending', async () => {
    await check((live) => {
      poolClass(find(live, 'WorkerPool', 'pinned')).pendingConfigRef = { name: 'gvisor-next' };
    }, false);
  });

  test('is not ready on a stale resolution or a stale config', async () => {
    // The controller has not resolved this generation yet.
    await check((live) => {
      find(live, 'WorkerPool', 'pinned').metadata.generation = 4;
    }, false);
    // Still on the old config the spec moved away from.
    await check((live) => {
      poolClass(find(live, 'WorkerPool', 'pinned')).configRef = { name: 'gvisor-old' };
    }, false);
    // The class does not resolve.
    await check((live) => {
      const resolved = poolClass(find(live, 'WorkerPool', 'default-config')).conditions[0];
      if (resolved) Object.assign(resolved, { status: 'False', reason: 'DefaultConfigNotFound' });
    }, false);
    // A pool with no configRef resolves to whatever config is the class default.
    await check((live) => {
      poolClass(find(live, 'WorkerPool', 'default-config')).configRef = { name: 'gvisor-custom' };
    }, true);
  });

  test('is not ready while an object is being deleted', async () => {
    await check((live) => {
      find(live, 'SandboxConfig', 'gvisor-default').metadata.deletionTimestamp =
        '2026-11-23T00:00:00Z';
    }, false);
  });
});

describe('WorkerPool readiness follows the upstream API', () => {
  const pool = (spec: Record<string, unknown>): Live =>
    settled({
      apiVersion: 'ate.dev/v1',
      kind: 'WorkerPool',
      metadata: { name: 'pool', namespace: 'agents' },
      spec: { replicas: 1, workerImage: 'ghcr.io/example/worker:v1', ...spec },
    });

  test('needs no configRef and no architecture selector', () => {
    expect(
      substrateReadiness.WorkerPool(pool({ sandboxClasses: [{ name: 'gvisor' }] })).ready
    ).toBe(true);
    expect(
      substrateReadiness.WorkerPool(
        pool({ sandboxClasses: [{ name: 'gvisor' }], template: { nodeSelector: { zone: 'a' } } })
      ).ready
    ).toBe(true);
  });

  test('reports not ready instead of failing on an object with no status', () => {
    const live = pool({ sandboxClasses: [{ name: 'gvisor' }] });
    delete live.status;
    expect(substrateReadiness.WorkerPool(live)).toEqual({
      ready: false,
      reason: 'WorkerPoolNotReady',
    });
  });
});
