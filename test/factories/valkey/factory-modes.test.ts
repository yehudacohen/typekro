/**
 * Valkey v0.24 factory-mode contract.
 *
 * The bootstrap must preserve the complete installation owner boundary and
 * raw Helm values in both direct and KRO serialization. The resource factory
 * must also accept a nested schema proxy as its CRD spec so consumers can
 * compose persistent Valkey instances without TypeKro-specific glue.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type } from 'arktype';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { DEFAULT_SINGLETON_NAMESPACE, singleton } from '../../../src/core/singleton/singleton.js';
import { valkeyBootstrap } from '../../../src/factories/valkey/compositions/valkey-bootstrap.js';
import {
  DEFAULT_VALKEY_REPO_NAME,
  DEFAULT_VALKEY_VERSION,
} from '../../../src/factories/valkey/resources/helm.js';
import { valkey } from '../../../src/factories/valkey/resources/valkey.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;
const ORIGINAL_KUBECONFIG = process.env.KUBECONFIG;
let kubeconfigDir: string | undefined;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
  kubeconfigDir = mkdtempSync(join(tmpdir(), 'typekro-valkey-factory-modes-'));
  const kubeconfigPath = join(kubeconfigDir, 'kubeconfig');
  writeFileSync(
    kubeconfigPath,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- cluster: { server: "https://127.0.0.1:1" }',
      '  name: hermetic',
      'contexts:',
      '- context: { cluster: hermetic, user: hermetic }',
      '  name: hermetic',
      'current-context: hermetic',
      'users:',
      '- name: hermetic',
      '  user: {}',
      '',
    ].join('\n')
  );
  process.env.KUBECONFIG = kubeconfigPath;
});

afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) delete process.env.TYPEKRO_STRICT_CEL;
  else process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;

  if (ORIGINAL_KUBECONFIG === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = ORIGINAL_KUBECONFIG;

  if (kubeconfigDir) rmSync(kubeconfigDir, { recursive: true, force: true });
});

function splitDocs(yaml: string): string[] {
  return yaml
    .split(/^---$/m)
    .map((doc) => doc.trim())
    .filter((doc) => doc.length > 0);
}

function docKind(doc: string): string | undefined {
  return doc.match(/^kind: (.+)$/m)?.[1];
}

function expectFullyConcrete(yaml: string): void {
  expect(yaml).not.toContain('${schema.');
  expect(yaml).not.toContain('schema.spec');
  expect(yaml).not.toContain('__typekroSchemaKey');
  expect(yaml).not.toContain('__KUBERNETES_REF__');
  expect(yaml).not.toContain('[object Object]');
  expect(yaml).not.toContain('undefined');
}

const bootstrapSpec = {
  name: 'valkey-operator',
  namespace: 'valkey-system',
  customValues: {
    controller: {
      resources: {
        requests: { cpu: '100m' },
        limits: { memory: '256Mi' },
      },
    },
    replicaCount: 1,
  },
  values: {
    controller: { resources: { requests: { memory: '128Mi' } } },
    replicaCount: 2,
  },
} as const;

const valkeyCluster = kubernetesComposition(
  {
    name: 'valkey-cluster-contract',
    kind: 'ValkeyClusterContract',
    spec: type({
      name: 'string',
      namespace: 'string',
      valkey: {
        'shards?': 'number',
        'replicas?': 'number',
        'volumePermissions?': 'boolean',
        'anonymousAuth?': 'boolean',
        'servicePassword?': { name: 'string', key: 'string', 'optional?': 'boolean' },
        'storage?': {
          spec: {
            'accessModes?': 'string[]',
            'storageClassName?': 'string',
            resources: { requests: { storage: 'string' } },
          },
        },
      },
    }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    const cache = valkey({
      id: 'cache',
      name: spec.name,
      namespace: spec.namespace,
      spec: spec.valkey,
    });
    return { ready: cache.status.ready };
  }
);

describe('valkeyBootstrap factory modes', () => {
  it('direct mode emits one concrete, complete operator installation', () => {
    const yaml = valkeyBootstrap
      .factory('direct', { namespace: 'valkey-system' })
      .toYaml(bootstrapSpec as never);
    const docs = splitDocs(yaml);
    const kinds = docs.map(docKind);

    expect(kinds).toEqual(['Namespace', 'HelmRepository', 'HelmRelease']);
    expect(kinds).toContain('Namespace');
    expect(kinds).toContain('HelmRelease');
    expect(kinds).not.toContain('ClusterRole');
    expect(kinds).not.toContain('ClusterRoleBinding');
    expect(kinds).toContain('HelmRepository');

    const release = docs.find((doc) => docKind(doc) === 'HelmRelease');
    expect(release).toContain(`version: ${DEFAULT_VALKEY_VERSION}`);
    expect(release).toMatch(
      new RegExp(
        `sourceRef:\\s*\\n\\s+kind: HelmRepository\\s*\\n\\s+name: ${DEFAULT_VALKEY_REPO_NAME}\\s*\\n\\s+namespace: valkey-system`
      )
    );
    expect(release).toMatch(/replicaCount: 2/);
    expect(release).toMatch(/requests:\s*\n\s+cpu: 100m\s*\n\s+memory: 128Mi/);
    expect(release).toMatch(/limits:\s*\n\s+memory: 256Mi/);
    expectFullyConcrete(yaml);
  });

  it('KRO mode emits the operator-owner instance with the hoisted namespace leading', () => {
    const yaml = valkeyBootstrap
      .factory('kro', { namespace: 'valkey-system' })
      .toYaml(bootstrapSpec as never);
    const docs = splitDocs(yaml);

    // The hoisted workload Namespace leads (deps-first, outside the KRO graph),
    // followed by the instance CR itself (which stays in the workload namespace).
    expect(docs.map(docKind)).toEqual(['Namespace', 'ValkeyBootstrap']);
  });

  it('KRO mode preserves repository ownership, runtime values, status, and version', () => {
    const yaml = valkeyBootstrap.factory('kro', { namespace: 'valkey-system' }).toYaml();
    const docs = splitDocs(yaml);

    expect(docs).toHaveLength(1);
    expect(docs.every((doc) => docKind(doc) === 'ResourceGraphDefinition')).toBe(true);
    expect(yaml).toContain('kind: HelmRepository');
    expect(yaml).toContain('schema.spec.repositoryNamespace');
    expect(yaml).toContain('json.unmarshal(json.marshal(schema.spec.values))');
    expect(yaml).toContain("ready: '${has(valkeyHelmRelease.status.observedGeneration)");
    // The owned workload Namespace (which carried the version label) is hoisted out
    // of the RGD graph; the chart version still resolves in the HelmRelease.
    expect(yaml).not.toContain('kind: Namespace');
    expect(yaml).toContain('${has(schema.spec.version) ? schema.spec.version : "v0.0.61-chart"}');
    expect(yaml).not.toContain('__typekroSchemaKey');
  });

  it('hoists the owned namespace instead of relocating; instance stays in the workload ns', async () => {
    // valkeyBootstrap creates and owns its operator Namespace. Instead of relocating
    // the instance CR, the owned Namespace is HOISTED out of the RGD graph (retained,
    // deps-first) and the instance stays in its natural workload namespace — the
    // v0.25.0 ownership guard passes with no flag.
    const factory = valkeyBootstrap.factory('kro', { namespace: 'valkey-system' });
    const spec = { name: 'valkey-operator', namespace: 'valkey-system' } as never;

    const yaml = factory.toYaml(spec);
    expect(yaml).toMatch(/namespace: valkey-system$/m);
    expect(yaml).not.toContain('typekro-system');
    expect(yaml).toContain('typekro.io/kro-instance-namespace');

    const decls = await factory.toAlchemyResources(spec);
    expect(decls[0]?.props.resource.kind).toBe('Namespace');
    expect(decls[0]?.props.resource.metadata?.name).toBe('valkey-system');
    // The instance's OWN (1:1) namespace is NOT retained: reverse-topo teardown
    // deletes it after the RGD + instance.
    expect(decls[0]?.props.retain).toBeUndefined();
    expect(decls.at(-1)?.props.namespace).toBe('valkey-system');
  });

  it('hoists a nested-owned namespace named after the parent spec.namespace', () => {
    // A nested-owned namespace is hoisted out of the shared RGD like any other
    // (typekro never emits a Namespace into RGD YAML) — hoisted through nesting, with
    // the instance left in its natural namespace.
    const parent = kubernetesComposition(
      {
        name: 'valkey-nested-owner',
        kind: 'ValkeyNestedOwner',
        spec: type({ name: 'string', namespace: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (parentSpec) => {
        const operator = valkeyBootstrap({
          name: 'valkey-operator',
          namespace: parentSpec.namespace,
        });
        return { ready: operator.status.ready };
      }
    );

    const yaml = parent.factory('kro', { namespace: 'valkey-system' }).toYaml({
      name: 'platform',
      namespace: 'valkey-system',
    });
    expect(yaml).toMatch(/namespace: valkey-system$/m);
    expect(yaml).not.toContain('typekro-system');
    expect(yaml).toContain('typekro.io/kro-instance-namespace');
    // The shared RGD no longer owns the Namespace as a graph child.
    expect(parent.factory('kro', { namespace: 'valkey-system' }).toYaml()).not.toContain(
      'kind: Namespace'
    );

    // Pinning the instance into its own owned namespace is now SAFE (the namespace is
    // a sibling deleted after the RGD), so it no longer throws — it just hoists.
    expect(() =>
      parent
        .factory('kro', { namespace: 'valkey-system', instanceNamespace: 'valkey-system' })
        .toYaml({ name: 'platform', namespace: 'valkey-system' })
    ).not.toThrow();
  });

  it('hoists a nested-owned namespace named after a DIFFERENT field too (unconditional)', () => {
    // The v2 model has no structural "tracks spec.namespace" gate — EVERY owned
    // Namespace is hoisted out of the RGD regardless of which field names it.
    const parent = kubernetesComposition(
      {
        name: 'valkey-nested-otherfield',
        kind: 'ValkeyNestedOtherField',
        spec: type({ name: 'string', operatorNamespace: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (parentSpec) => {
        const operator = valkeyBootstrap({
          name: 'valkey-operator',
          namespace: parentSpec.operatorNamespace,
        });
        return { ready: operator.status.ready };
      }
    );

    let yaml = '';
    expect(() => {
      yaml = parent
        .factory('kro', { namespace: 'valkey-system' })
        .toYaml({ name: 'platform', operatorNamespace: 'valkey-system' });
    }).not.toThrow();
    expect(yaml).toContain('typekro.io/kro-instance-namespace');
    expect(parent.factory('kro', { namespace: 'valkey-system' }).toYaml()).not.toContain(
      'kind: Namespace'
    );
  });

  it('hoists singleton owner namespaces before declarative owner and consumer resources', async () => {
    const consumer = kubernetesComposition(
      {
        name: 'valkey-singleton-consumer',
        kind: 'ValkeySingletonConsumer',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      () => {
        const operator = singleton(valkeyBootstrap, {
          id: 'unsafe-valkey-owner',
          spec: {
            name: 'valkey-operator',
            namespace: DEFAULT_SINGLETON_NAMESPACE,
          },
        });
        return { ready: operator.status.ready };
      }
    );
    const factory = consumer.factory('kro', { namespace: 'apps' });
    const consumerSpec = { name: 'consumer' };

    const yaml = factory.toYaml(consumerSpec);
    expect(yaml.indexOf('kind: Namespace')).toBeLessThan(yaml.indexOf('kind: ValkeyBootstrap'));
    expect(yaml.indexOf('kind: ValkeyBootstrap')).toBeLessThan(
      yaml.indexOf('kind: ValkeySingletonConsumer')
    );
    expect(yaml).toContain('typekro.io/hoisted-namespaces: \'["typekro-singletons"]\'');

    const declarations = await factory.toAlchemyResources(consumerSpec);
    expect(declarations[0]?.props.resource.kind).toBe('Namespace');
    expect(declarations[0]?.props.resource.metadata?.name).toBe(DEFAULT_SINGLETON_NAMESPACE);
  });
});

describe('valkey CRD factory modes', () => {
  it('direct mode renders a persistent authenticated Valkey resource concretely', () => {
    const yaml = valkeyCluster.factory('direct', { namespace: 'apps' }).toYaml({
      name: 'queue',
      namespace: 'apps',
      valkey: {
        shards: 3,
        replicas: 1,
        volumePermissions: true,
        anonymousAuth: false,
        servicePassword: { name: 'queue-password', key: 'password', optional: false },
        storage: {
          spec: {
            accessModes: ['ReadWriteOnce'],
            storageClassName: 'fast',
            resources: { requests: { storage: '20Gi' } },
          },
        },
      },
    } as never);

    expect(splitDocs(yaml)).toHaveLength(1);
    expect(docKind(yaml)).toBe('Valkey');
    expect(yaml).toContain('nodes: 3');
    expect(yaml).toContain('replicas: 1');
    expect(yaml).toContain('storageClassName: fast');
    expect(yaml).toContain('storage: 20Gi');
    expect(yaml).toContain('name: queue-password');
    expectFullyConcrete(yaml);
  });

  it('KRO mode preserves nested natural proxy paths and the readiness contract', () => {
    const yaml = valkeyCluster.factory('kro', { namespace: 'apps' }).toYaml();

    expect(yaml).toContain('kind: ValkeyClusterContract');
    expect(yaml).toContain('${has(schema.spec.valkey.shards)');
    expect(yaml).toContain('${has(schema.spec.valkey.replicas)');
    expect(yaml).toContain('${has(schema.spec.valkey.storage)');
    expect(yaml).toContain('storageClassName: string');
    expect(yaml).toContain('ready: ${cache.status.ready}');
    expect(yaml).not.toContain('__typekroSchemaKey');
  });
});
