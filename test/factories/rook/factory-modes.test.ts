import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type } from 'arktype';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { DEFAULT_SINGLETON_NAMESPACE, singleton } from '../../../src/core/singleton/singleton.js';
import {
  DEFAULT_ROOK_CEPH_REPO_NAME,
  DEFAULT_ROOK_CEPH_VERSION,
  rookCephOperatorBootstrap,
  rookObjectStorageClaim,
} from '../../../src/factories/rook/index.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;
const ORIGINAL_KUBECONFIG = process.env.KUBECONFIG;
let kubeconfigDir: string | undefined;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
  kubeconfigDir = mkdtempSync(join(tmpdir(), 'typekro-rook-factory-modes-'));
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
    .map((document) => document.trim())
    .filter(Boolean);
}

function documentKind(document: string): string | undefined {
  return document.match(/^kind: (.+)$/m)?.[1];
}

function expectNoInternalMarkers(yaml: string): void {
  expect(yaml).not.toContain('__KUBERNETES_REF__');
  expect(yaml).not.toContain('__typekroSchemaKey');
  expect(yaml).not.toContain('[object Object]');
  expect(yaml).not.toContain('undefined');
}

describe('Rook operator bootstrap factory modes', () => {
  const spec = {
    name: 'rook-ceph',
    namespace: 'rook-ceph',
    version: DEFAULT_ROOK_CEPH_VERSION,
    logLevel: 'DEBUG',
    enableOBCWatchOperatorNamespace: true,
    resources: { requests: { cpu: '250m', memory: '256Mi' } },
    values: { monitoring: { enabled: true } },
  } as const;

  it('renders concrete direct-mode Namespace and HelmRelease manifests', () => {
    const factory = rookCephOperatorBootstrap.factory('direct', { namespace: 'rook-ceph' });
    const yaml = factory.toYaml(spec as never);
    const documents = splitDocs(yaml);
    const kinds = documents.map(documentKind);

    expect(kinds).toContain('Namespace');
    expect(kinds).toContain('HelmRelease');
    expect(kinds).toContain('HelmRepository');

    const release = documents.find((document) => documentKind(document) === 'HelmRelease');
    expect(release).toContain('chart: rook-ceph');
    expect(release).toContain(`version: ${DEFAULT_ROOK_CEPH_VERSION}`);
    expect(release).toMatch(
      new RegExp(`name: ${DEFAULT_ROOK_CEPH_REPO_NAME}\\s*\\n\\s+namespace: rook-ceph`)
    );
    expect(release).toMatch(/logLevel: DEBUG/);
    expect(release).toMatch(/enableOBCWatchOperatorNamespace: true/);
    expect(release).toMatch(/monitoring:\s*\n\s+enabled: true/);
    expectNoInternalMarkers(yaml);
  });

  it('renders a KRO operator-owner instance with an explicit lifecycle', () => {
    const factory = rookCephOperatorBootstrap.factory('kro', {
      namespace: 'platform-control',
    });
    const documents = splitDocs(factory.toYaml({ name: 'rook-ceph' } as never));
    const kinds = documents.map(documentKind);

    expect(kinds).toContain('RookCephOperatorBootstrap');
    // The dedicated control-plane instance Namespace leads (deps-first, outside
    // the KRO graph), followed by the instance CR itself.
    expect(kinds).toEqual(['Namespace', 'RookCephOperatorBootstrap']);
  });

  it('generates an RGD with graph-aware chart values and readiness status', () => {
    const factory = rookCephOperatorBootstrap.factory('kro', {
      namespace: 'platform-control',
    });
    const yaml = factory.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('kind: HelmRelease');
    expect(yaml).toContain('schema.spec.values');
    expect(yaml).toContain('c.type == "Ready"');
    expect(yaml).toContain('failed:');
    expectNoInternalMarkers(yaml);
  });

  it('decouples the instance into a control-plane namespace (ownsInstanceNamespace)', async () => {
    // rookCephOperatorBootstrap creates and owns its operator Namespace, so the
    // natural same-namespace call is made safe by placing the CR in `<ns>-kro`
    // rather than being rejected (regression fix for the v0.25.0 ownership guard).
    const factory = rookCephOperatorBootstrap.factory('kro', { namespace: 'rook-ceph' });
    const spec = { name: 'rook-ceph', namespace: 'rook-ceph' } as never;

    const yaml = factory.toYaml(spec);
    expect(yaml).toContain('namespace: rook-ceph-kro');
    expect(yaml).toContain('typekro.io/kro-instance-namespace');

    const decls = await factory.toAlchemyResources(spec);
    expect(decls[0]?.props.resource.kind).toBe('Namespace');
    expect(decls[0]?.props.resource.metadata?.name).toBe('rook-ceph-kro');
    expect(decls.at(-1)?.props.namespace).toBe('rook-ceph-kro');
  });

  it('rejects the same namespace invariant through composition nesting', () => {
    const parent = kubernetesComposition(
      {
        name: 'rook-nested-owner',
        kind: 'RookNestedOwner',
        spec: type({ name: 'string', operatorNamespace: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (parentSpec) => {
        const operator = rookCephOperatorBootstrap({
          name: 'rook-ceph',
          namespace: parentSpec.operatorNamespace,
        });
        return { ready: operator.status.ready };
      }
    );

    expect(() =>
      parent.factory('kro', { namespace: 'rook-ceph' }).toYaml({
        name: 'platform',
        operatorNamespace: 'rook-ceph',
      })
    ).toThrow('cannot also be an owned Namespace');
  });

  it('rejects unsafe singleton owners before GitOps or live-cluster side effects', async () => {
    const consumer = kubernetesComposition(
      {
        name: 'rook-singleton-consumer',
        kind: 'RookSingletonConsumer',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      () => {
        const operator = singleton(rookCephOperatorBootstrap, {
          id: 'unsafe-rook-owner',
          spec: {
            name: 'rook-ceph',
            namespace: DEFAULT_SINGLETON_NAMESPACE,
          },
        });
        return { ready: operator.status.ready };
      }
    );
    const factory = consumer.factory('kro', { namespace: 'apps' });
    const consumerSpec = { name: 'consumer' };

    expect(() => factory.toYaml(consumerSpec)).toThrow('cannot also be an owned Namespace');
    await expect(factory.deploy(consumerSpec)).rejects.toThrow('cannot also be an owned Namespace');
    await expect(factory.toAlchemyResources(consumerSpec)).rejects.toThrow(
      'cannot also be an owned Namespace'
    );
  });
});

describe('Rook object storage claim factory modes', () => {
  it('renders only an app-owned OBC in direct mode', () => {
    const factory = rookObjectStorageClaim.factory('direct', { namespace: 'apps' });
    const yaml = factory.toYaml({
      name: 'uploads',
      namespace: 'apps',
      storageClassName: 'rook-ceph-retain',
      bucket: { name: 'uploads', mode: 'generated' },
      maxObjects: '1000',
      maxSize: '2G',
    } as never);

    const documents = splitDocs(yaml);
    expect(documents).toHaveLength(1);
    expect(documentKind(documents[0] ?? '')).toBe('ObjectBucketClaim');
    expect(yaml).toContain('storageClassName: rook-ceph-retain');
    expect(yaml).toContain('generateBucketName: uploads');
    expect(yaml).toContain("maxObjects: '1000'");
    expect(yaml).toContain('maxSize: 2G');
    expect(yaml).not.toContain('kind: CephCluster');
    expect(yaml).not.toContain('kind: CephObjectStore');
    expect(yaml).not.toContain('kind: StorageClass');
    expectNoInternalMarkers(yaml);
  });

  it('omits both bucket-name fields for a brownfield StorageClass', () => {
    const factory = rookObjectStorageClaim.factory('direct', { namespace: 'apps' });
    const yaml = factory.toYaml({
      name: 'existing-assets',
      namespace: 'apps',
      storageClassName: 'existing-assets',
    } as never);

    expect(yaml).not.toContain('bucketName:');
    expect(yaml).not.toContain('generateBucketName:');
  });

  it('rejects KRO-managed OBCs before they can enter the controller apply race', () => {
    expect(() => rookObjectStorageClaim.factory('kro', { namespace: 'apps' })).toThrow(
      'does not support kro mode'
    );
    expect(() => rookObjectStorageClaim.toYaml()).toThrow('does not support kro mode');
    expect(() =>
      rookObjectStorageClaim.toYaml({
        name: 'uploads',
        namespace: 'apps',
        storageClassName: 'rook-ceph-retain',
      })
    ).toThrow('does not support kro mode');
  });

  it('rejects OBC composition nesting during KRO graph construction', () => {
    expect(() =>
      kubernetesComposition(
        {
          name: 'unsafe-obc-parent',
          kind: 'UnsafeObcParent',
          spec: type({
            name: 'string',
            namespace: 'string',
            storageClassName: 'string',
          }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          const claim = rookObjectStorageClaim({
            name: spec.name,
            namespace: spec.namespace,
            storageClassName: spec.storageClassName,
          });
          return { ready: claim.status.ready };
        }
      )
    ).toThrow('does not support kro mode and cannot be nested');
  });

  it('allows OBC nesting when the complete parent graph is explicitly direct-only', () => {
    const directParent = kubernetesComposition(
      {
        name: 'direct-obc-parent',
        kind: 'DirectObcParent',
        spec: type({
          name: 'string',
          namespace: 'string',
          storageClassName: 'string',
        }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const claim = rookObjectStorageClaim({
          name: spec.name,
          namespace: spec.namespace,
          storageClassName: spec.storageClassName,
        });
        return { ready: claim.status.ready };
      },
      { supportedModes: ['direct'] }
    );

    const yaml = directParent.factory('direct').toYaml({
      name: 'uploads',
      namespace: 'apps',
      storageClassName: 'rook-ceph-retain',
    });
    expect(yaml).toContain('kind: ObjectBucketClaim');
    expect(() => directParent.factory('kro')).toThrow('does not support kro mode');
  });
});
