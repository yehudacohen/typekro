import { describe, expect, it } from 'bun:test';
import { relative } from 'node:path';
import {
  selectStorageClass,
  type StorageClassCandidate,
} from '../../scripts/integration-storage-selection.js';

const integrationRoot = new URL('../integration/', import.meta.url);
const cleanupScript = new URL('../../scripts/cleanup-test-namespaces.ts', import.meta.url);
const integrationRunner = new URL('../../scripts/run-integration-tests.sh', import.meta.url);
const sharedHarness = new URL('../integration/shared-kubeconfig.ts', import.meta.url);
const directDeletionEvidenceFiles = new Set([
  'kro-namespace-sibling-lifecycle.test.ts',
  'rook/object-storage-claim.test.ts',
  'semantic-planning-live.test.ts',
]);
const explicitNamespaceLifecycleFiles = new Set([
  'dagster/bootstrap-composition.test.ts',
  'kro-namespace-sibling-lifecycle.test.ts',
  'nats/jetstream-resources.test.ts',
  'rook/ceph-platform.test.ts',
]);

interface ForbiddenPattern {
  description: string;
  pattern: RegExp;
  allowedFiles?: ReadonlySet<string>;
}

const forbiddenPatterns: ForbiddenPattern[] = [
  {
    description: 'legacy name-only namespace helpers',
    pattern: /\b(?:ensureNamespaceExists|deleteNamespaceIfExists|deleteNamespaceAndWait)\b/,
  },
  {
    description: 'raw namespace create/delete calls outside the lease harness',
    pattern: /\.(?:create|delete)Namespace\s*\(/,
  },
  {
    description: 'manual PVC deletion that can mask factory teardown defects',
    pattern: /\.deleteNamespacedPersistentVolumeClaim\s*\(/,
  },
  {
    description: 'raw Kubernetes deletion outside the UID-guarded cleanup harness',
    pattern:
      /\.(?:deleteNamespaced[A-Z]\w*|deleteClusterCustomObject|deleteNamespacedCustomObject|deleteCollection\w*)\s*\(|\b(?:objectApi|customApi|coreApi|k8sApi)\s*\.\s*delete\s*\(/,
    allowedFiles: new Set(['kro-namespace-sibling-lifecycle.test.ts']),
  },
  {
    description: 'executable kubectl subprocesses',
    pattern: /Bun\.spawn(?:Sync)?\s*\(\s*\[\s*['"]kubectl['"]/s,
  },
  {
    description: 'silently swallowed factory teardown failures',
    pattern:
      /\.deleteInstance\s*\([^)]*\)\s*\.catch\s*\(\s*\(\)\s*=>\s*(?:\{\s*\}|undefined)\s*\)/s,
  },
  {
    description: 'broad stuck-resource cleanup sweeps',
    pattern: /\bcleanupStuck(?:Kro)?(?:Instances|Resources)\b/,
  },
];

describe('integration harness conformance', () => {
  it('requires caller-owned clusters to name a StorageClass explicitly', () => {
    const storageClasses: StorageClassCandidate[] = [
      {
        metadata: {
          name: 'stale-default',
          annotations: {
            'storageclass.kubernetes.io/is-default-class': 'true',
          },
        },
      },
      {
        metadata: { name: 'local-path' },
      },
    ];

    expect(() => selectStorageClass(storageClasses, undefined, false)).toThrow(
      'Existing clusters require an explicit RWO-capable StorageClass'
    );
    expect(selectStorageClass(storageClasses, 'local-path', false)).toBe('local-path');
    expect(selectStorageClass(storageClasses, undefined, true)).toBe('stale-default');
    expect(() => selectStorageClass(storageClasses, 'missing', false)).toThrow(
      'Configured StorageClass does not exist: missing'
    );
  });

  it('keeps live suites on UID-leased API-driven lifecycle primitives', async () => {
    const violations: string[] = [];
    const glob = new Bun.Glob('**/*.test.ts');

    for await (const path of glob.scan({ cwd: integrationRoot.pathname, absolute: true })) {
      const source = await Bun.file(path).text();
      const relativePath = relative(integrationRoot.pathname, path);
      for (const forbidden of forbiddenPatterns) {
        if (forbidden.allowedFiles?.has(relativePath)) continue;
        if (forbidden.pattern.test(source)) {
          violations.push(`${relativePath}: ${forbidden.description}`);
        }
      }
      if (/\.deleteInstance\s*\(/.test(source) && !directDeletionEvidenceFiles.has(relativePath)) {
        violations.push(
          `${relativePath}: direct deleteInstance call outside an explicit lifecycle evidence suite`
        );
      }
      if (
        /\b(?:assertTestNamespaceAbsent|captureTestNamespaceLease)\b/.test(source) &&
        !explicitNamespaceLifecycleFiles.has(relativePath)
      ) {
        violations.push(
          `${relativePath}: split namespace absence/capture flow instead of runWithExpectedTestNamespaces`
        );
      }
      if (/\bafterAll\s*\(/.test(source) && !/\bsetDefaultTimeout\s*\(/.test(source)) {
        violations.push(
          `${relativePath}: teardown hook relies on Bun's five-second default timeout`
        );
      }
      if (
        /\.deploy\s*\(/.test(source) &&
        !/TestFactoryCleanupRegistry|deleteTestFactoryInstanceAndRecoverNamespaces|\.deleteInstance\s*\(|\brunDestroy\b/.test(
          source
        )
      ) {
        violations.push(
          `${relativePath}: deploys live resources without factory or Alchemy lifecycle teardown`
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps interrupted-run cleanup label-scoped and UID-leased', async () => {
    const source = await Bun.file(cleanupScript).text();

    expect(source).toContain('TYPEKRO_TEST_NAMESPACE_LABEL');
    expect(source).toContain('deleteTestNamespaceAndWait');
    expect(source).not.toMatch(/testNamespacePatterns|\.deleteNamespace\s*\(/);
  });

  it('uses Kubernetes clients instead of kubectl for runner probes and fixtures', async () => {
    const source = await Bun.file(integrationRunner).text();

    expect(source).toContain('integration-cluster-harness.ts cluster-ready');
    expect(source).toContain('integration-cluster-harness.ts storage-class');
    expect(source).not.toMatch(/^\s*(?:if\s+!?\s*)?kubectl\b|=\$\(kubectl\b/m);
  });

  it('keeps namespace cleanup from mutating graph-owned child resources', async () => {
    const source = await Bun.file(sharedHarness).text();

    expect(source).not.toContain('deleteNamespacedPersistentVolumeClaim');
    expect(source).not.toMatch(/deleteCollection\w*\s*\(/);
  });
});
