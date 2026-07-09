/**
 * Valkey v0.24 factory-mode contract.
 *
 * The bootstrap must preserve the shared flux-system repository boundary and
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
import { valkeyBootstrap } from '../../../src/factories/valkey/compositions/valkey-bootstrap.js';
import {
  DEFAULT_VALKEY_REPO_NAME,
  DEFAULT_VALKEY_REPO_URL,
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
          'spec?': {
            'accessModes?': 'string[]',
            'storageClassName?': 'string',
            'resources?': { 'requests?': { 'storage?': 'string' } },
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
  it('direct mode emits concrete operator resources and keeps the shared repository external', () => {
    const yaml = valkeyBootstrap
      .factory('direct', { namespace: 'valkey-system' })
      .toYaml(bootstrapSpec as never);
    const docs = splitDocs(yaml);
    const kinds = docs.map(docKind);

    expect(kinds).toContain('Namespace');
    expect(kinds).toContain('HelmRelease');
    expect(kinds).not.toContain('ClusterRole');
    expect(kinds).not.toContain('ClusterRoleBinding');
    expect(kinds).not.toContain('HelmRepository');

    const release = docs.find((doc) => docKind(doc) === 'HelmRelease');
    expect(release).toContain(`version: ${DEFAULT_VALKEY_VERSION}`);
    expect(release).toMatch(
      new RegExp(
        `sourceRef:\\s*\\n\\s+kind: HelmRepository\\s*\\n\\s+name: ${DEFAULT_VALKEY_REPO_NAME}\\s*\\n\\s+namespace: flux-system`
      )
    );
    expect(release).toMatch(/replicaCount: 2/);
    expect(release).toMatch(/requests:\s*\n\s+cpu: 100m\s*\n\s+memory: 128Mi/);
    expect(release).toMatch(/limits:\s*\n\s+memory: 256Mi/);
    expectFullyConcrete(yaml);
  });

  it('KRO mode emits the singleton owner before the bootstrap instance', () => {
    const yaml = valkeyBootstrap
      .factory('kro', { namespace: 'valkey-system' })
      .toYaml(bootstrapSpec as never);
    const docs = splitDocs(yaml);

    expect(docs.map(docKind)).toEqual(['ValkeyHelmRepository', 'ValkeyBootstrap']);
    expect(docs[0]).toContain('namespace: typekro-singletons');
    expect(docs[0]).toContain('typekro.io/singleton-spec-fingerprint');
    expect(docs[0]).toContain(`name: ${DEFAULT_VALKEY_REPO_NAME}`);
    expect(docs[0]).toContain(`url: ${DEFAULT_VALKEY_REPO_URL}`);
  });

  it('KRO mode preserves repository ownership, runtime values, status, and version labels', () => {
    const yaml = valkeyBootstrap.factory('kro', { namespace: 'valkey-system' }).toYaml();
    const docs = splitDocs(yaml);

    expect(docs).toHaveLength(2);
    expect(docs.every((doc) => docKind(doc) === 'ResourceGraphDefinition')).toBe(true);
    expect(yaml.indexOf('name: valkey-helm-repository')).toBeLessThan(
      yaml.indexOf('name: valkey-bootstrap')
    );
    expect(yaml).toContain('ready: ${repository.metadata.generation > 0}');
    expect(yaml).toContain('namespace: flux-system');
    expect(yaml).toContain('json.unmarshal(json.marshal(schema.spec.values))');
    expect(yaml).toContain('ready: ${valkeyHelmRelease.status.conditions.exists');
    expect(yaml).toContain(
      'app.kubernetes.io/version: "${has(schema.spec.version) ? schema.spec.version : \\"v0.0.61\\"}"'
    );
    expect(yaml).not.toContain('__typekroSchemaKey');
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
    expect(yaml).toContain('nodes: "${has(schema.spec.valkey.shards)');
    expect(yaml).toContain('replicas: "${has(schema.spec.valkey.replicas)');
    expect(yaml).toContain('storage: "${has(schema.spec.valkey.storage)');
    expect(yaml).toContain('storageClassName: string');
    expect(yaml).toContain('ready: ${cache.status.ready}');
    expect(yaml).not.toContain('__typekroSchemaKey');
  });
});
