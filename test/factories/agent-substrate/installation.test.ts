/**
 * The pinned Agent Substrate v1.0.0 installation: the vendored bundle's identity, its object
 * scopes against the real upstream CRDs and Kubernetes OpenAPI, its images, the canonical
 * namespace, and the narrow options.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';

import {
  agentSubstrateBundleSha256,
  agentSubstrateCommit,
  agentSubstrateInstallation,
  agentSubstrateNamespace,
  agentSubstrateVersion,
} from '../../../src/factories/agent-substrate/index.js';
import {
  type AgentSubstrateRelease,
  agentSubstrateReleaseSha256,
  verifyAgentSubstrateRelease,
  workloadImages,
} from '../../../src/factories/agent-substrate/release.js';
import { agentSubstrateV1_0_0 as release } from '../../../src/factories/agent-substrate/releases/v1.0.0.js';
import { loadKubernetesOpenApi } from '../../utils/kubernetes-openapi.js';

const kubernetes = loadKubernetesOpenApi(
  join(import.meta.dir, '../../fixtures/agent-substrate/kubernetes-v1.36.1-openapi.json')
);

interface Rendered {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
  spec?: Record<string, unknown>;
}

function render(options: Parameters<typeof agentSubstrateInstallation>[0] = {}): Rendered[] {
  return loadAll(
    agentSubstrateInstallation(options).factory('direct', { namespace: 'elsewhere' }).toYaml({})
  ) as Rendered[];
}

function tampered(
  change: (copy: { -readonly [K in keyof AgentSubstrateRelease]: unknown }) => void
) {
  const copy = structuredClone(release) as unknown as {
    -readonly [K in keyof AgentSubstrateRelease]: unknown;
  };
  change(copy);
  return copy as unknown as AgentSubstrateRelease;
}

describe('Agent Substrate v1.0.0 bundle', () => {
  test('is the reviewed render of the tagged commit', () => {
    expect(release.version).toBe(agentSubstrateVersion);
    expect(release.sourceCommit).toBe(agentSubstrateCommit);
    expect(agentSubstrateReleaseSha256(release)).toBe(agentSubstrateBundleSha256);
    expect(() => verifyAgentSubstrateRelease(release, agentSubstrateBundleSha256)).not.toThrow();
    // Every object names the upstream file it came from, which is recorded with its git blob.
    const files = new Set(release.sourceFiles.map(({ path }) => path));
    for (const { source } of release.documents) expect(files.has(source)).toBe(true);
    for (const { gitBlob } of release.sourceFiles) expect(gitBlob).toMatch(/^[0-9a-f]{40}$/u);
  });

  test('refuses an edited object, image or source identity', () => {
    const edits = [
      (copy: { documents: unknown; images: unknown; sourceCommit: unknown }) => {
        const [first] = copy.documents as { manifest: { metadata: { name: string } } }[];
        if (first) first.manifest.metadata.name = 'other';
      },
      (copy: { images: unknown }) => {
        (copy.images as Record<string, string>).ateapi = 'registry.example.test/ateapi:latest';
      },
      (copy: { sourceCommit: unknown }) => {
        copy.sourceCommit = '0'.repeat(40);
      },
    ];
    for (const edit of edits) {
      expect(() =>
        verifyAgentSubstrateRelease(tampered(edit as never), agentSubstrateBundleSha256)
      ).toThrow(/does not match its reviewed content/u);
    }
  });

  test('runs only release images pinned by digest, built from the tagged commit', () => {
    const images = Object.values(release.images);
    for (const image of images) {
      expect(image).toMatch(
        /^ghcr\.io\/agent-substrate\/substrate\/[a-z0-9-]+:v1\.0\.0@sha256:[0-9a-f]{64}$/u
      );
    }
    const used = release.documents.flatMap(({ manifest }) => workloadImages(manifest));
    expect(used.length).toBeGreaterThan(0);
    for (const image of used) expect(images).toContain(image);
    // A bundle whose own image map was rewritten, checksum and all, is still refused.
    const rewritten = tampered((copy) => {
      (copy.images as Record<string, string>).ateapi = 'registry.example.test/ateapi:latest';
    });
    expect(() =>
      verifyAgentSubstrateRelease(rewritten, agentSubstrateReleaseSha256(rewritten))
    ).toThrow(/not a v1\.0\.0 release image/u);
  });

  test('takes every scope from the bundle CRDs or the Kubernetes OpenAPI paths', () => {
    const crdScopes = new Map<string, string>();
    for (const { manifest } of release.documents) {
      if (manifest.kind !== 'CustomResourceDefinition') continue;
      const spec = manifest.spec as {
        group: string;
        scope: string;
        names: { kind: string };
        versions: { name: string }[];
      };
      for (const version of spec.versions) {
        crdScopes.set(`${spec.group}/${version.name}/${spec.names.kind}`, spec.scope);
      }
    }
    // The real upstream CRDs: SandboxConfig and CSIDriverConfig are cluster-scoped.
    expect(crdScopes.get('ate.dev/v1/SandboxConfig')).toBe('Cluster');
    expect(crdScopes.get('ate.dev/v1/CSIDriverConfig')).toBe('Cluster');
    expect(crdScopes.get('ate.dev/v1/WorkerPool')).toBe('Namespaced');
    for (const { manifest, scope } of release.documents) {
      const key = `${manifest.apiVersion}/${manifest.kind}`;
      expect(`${key} ${scope}`).toBe(`${key} ${crdScopes.get(key) ?? kubernetes.scopes[key]}`);
      expect(manifest.metadata.namespace === undefined).toBe(scope === 'Cluster');
    }
    const clusterKinds = new Set(
      release.documents
        .filter(({ scope }) => scope === 'Cluster')
        .map(({ manifest }) => manifest.kind)
    );
    for (const kind of [
      'ValidatingAdmissionPolicy',
      'ValidatingAdmissionPolicyBinding',
      'ClusterRole',
      'ClusterRoleBinding',
      'CustomResourceDefinition',
      'Namespace',
      'SandboxConfig',
    ]) {
      expect(clusterKinds.has(kind)).toBe(true);
    }
  });
});

describe('Agent Substrate installation', () => {
  test('applies the whole bundle in the canonical namespaces, whatever the factory namespace', () => {
    const rendered = render();
    expect(rendered).toHaveLength(release.documents.length);
    const namespaces = new Set(rendered.map(({ metadata }) => metadata.namespace).filter(Boolean));
    expect([...namespaces].sort()).toEqual([
      agentSubstrateNamespace,
      'podcertificate-controller-system',
    ]);
    // Cluster-scoped objects keep no namespace: the factory namespace is never applied to them.
    const scopes = new Map(
      release.documents.map(({ manifest, scope }) => [
        `${manifest.kind}/${manifest.metadata.namespace ?? ''}/${manifest.metadata.name}`,
        scope,
      ])
    );
    for (const { kind, metadata } of rendered) {
      const scope = scopes.get(`${kind}/${metadata.namespace ?? ''}/${metadata.name}`);
      expect(`${kind}/${metadata.name} ${scope}`).toBe(
        `${kind}/${metadata.name} ${metadata.namespace === undefined ? 'Cluster' : 'Namespaced'}`
      );
    }
    const router = rendered.find(
      ({ kind, metadata }) => kind === 'Deployment' && metadata.name === 'atenet-router'
    ) as unknown as { spec: { template: { spec: { containers: { args: string[] }[] } } } };
    expect(
      router.spec.template.spec.containers[0]?.args.some((arg) =>
        arg.startsWith('--ingress-allowed-spiffe-ids')
      )
    ).toBe(false);
  });

  test('substitutes only the ingress allowlist into the release objects', () => {
    const ids = ['spiffe://cluster.local/ns/app/sa/client', 'spiffe://cluster.local/ns/ops/sa/cli'];
    const plain = render();
    const allowed = render({ ingressAllowedSpiffeIds: ids });
    const differs = allowed.filter(
      (object, index) => JSON.stringify(object) !== JSON.stringify(plain[index])
    );
    expect(differs.map(({ kind, metadata }) => `${kind}/${metadata.name}`)).toEqual([
      'Deployment/atenet-router',
    ]);
    const args = (
      differs[0] as unknown as {
        spec: { template: { spec: { containers: { args: string[] }[] } } };
      }
    ).spec.template.spec.containers[0]?.args;
    expect(args?.slice(-2)).toEqual([
      `--ingress-allowed-spiffe-ids=${ids.join(',')}`,
      '--preview=',
    ]);
    for (const id of ['https://example.test', 'spiffe://cluster.local/ns/a,b/sa/c', 'spiffe://x']) {
      expect(() => agentSubstrateInstallation({ ingressAllowedSpiffeIds: [id] })).toThrow(
        /not a SPIFFE ID/u
      );
    }
  });

  test('adds gVisor WorkerPools with the release worker image and optional fields left optional', () => {
    const rendered = render({
      workerPools: [
        { namespace: 'agents', name: 'default-config', replicas: 0 },
        {
          namespace: 'agents',
          name: 'pinned',
          replicas: 2,
          sandboxConfig: 'gvisor-default',
          nodeSelector: { 'example.test/pool': 'agents' },
        },
      ],
    });
    const pools = rendered.filter(({ kind }) => kind === 'WorkerPool');
    expect(pools.map(({ spec }) => spec)).toEqual([
      {
        replicas: 0,
        workerImage: release.images['ateworker-gvisor'],
        sandboxClasses: [{ name: 'gvisor' }],
      },
      {
        replicas: 2,
        workerImage: release.images['ateworker-gvisor'],
        sandboxClasses: [{ name: 'gvisor', configRef: { name: 'gvisor-default' } }],
        template: { nodeSelector: { 'example.test/pool': 'agents' } },
      },
    ]);
    expect(
      rendered.filter(({ kind, metadata }) => kind === 'Namespace' && metadata.name === 'agents')
    ).toHaveLength(1);
  });

  test('refuses WorkerPools in the control-plane or system namespaces and invalid pools', () => {
    for (const namespace of [
      agentSubstrateNamespace,
      'podcertificate-controller-system',
      'kube-system',
      'default',
    ]) {
      expect(() =>
        agentSubstrateInstallation({ workerPools: [{ namespace, name: 'pool', replicas: 1 }] })
      ).toThrow(/namespace of its own/u);
    }
    expect(() =>
      agentSubstrateInstallation({
        workerPools: [{ namespace: 'agents', name: 'pool', replicas: -1 }],
      })
    ).toThrow(/non-negative/u);
    expect(() =>
      agentSubstrateInstallation({
        workerPools: [{ namespace: 'agents', name: 'p'.repeat(64), replicas: 1 }],
      })
    ).toThrow(/DNS labels/u);
    const pool = { namespace: 'agents', name: 'pool', replicas: 1 };
    expect(() => agentSubstrateInstallation({ workerPools: [pool, pool] })).toThrow(
      /declared twice/u
    );
  });
});
