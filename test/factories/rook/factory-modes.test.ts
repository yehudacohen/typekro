import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    const factory = rookCephOperatorBootstrap.factory('kro', { namespace: 'rook-ceph' });
    const documents = splitDocs(factory.toYaml({ name: 'rook-ceph' } as never));
    const kinds = documents.map(documentKind);

    expect(kinds).toContain('RookCephOperatorBootstrap');
    expect(kinds).toEqual(['RookCephOperatorBootstrap']);
  });

  it('generates an RGD with graph-aware chart values and readiness status', () => {
    const factory = rookCephOperatorBootstrap.factory('kro', { namespace: 'rook-ceph' });
    const yaml = factory.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('kind: HelmRelease');
    expect(yaml).toContain('schema.spec.values');
    expect(yaml).toContain('c.type == "Ready"');
    expect(yaml).toContain('failed:');
    expectNoInternalMarkers(yaml);
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
      'rookObjectStorageClaim is direct-only'
    );
  });
});
