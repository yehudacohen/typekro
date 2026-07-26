import { describe, expect, it } from 'bun:test';

import { clickhouseOperatorBootstrap } from '../../src/factories/clickhouse/index.js';
import { clickstackBootstrap } from '../../src/factories/clickstack/index.js';
import { dagsterBootstrap } from '../../src/factories/dagster/index.js';
import { valkeyBootstrap } from '../../src/factories/valkey/index.js';

/**
 * Regression coverage for the v0.25.0 `UNSAFE_KRO_NAMESPACE_OWNERSHIP` guard
 * (commit bec5436) breaking TypeKro's OWN bootstrap factories.
 *
 * Each of these compositions creates and owns its target Namespace as a graph
 * child, and the natural call places the KRO instance in that same namespace
 * (`factory('kro', { namespace: X }).toYaml({ namespace: X })`) — which the
 * guard hard-rejected with no escape hatch.
 *
 * The fix leaves the instance CR in its NATURAL (workload) namespace and instead
 * HOISTS the owned Namespace OUT of the RGD graph, emitting it as a RETAINED
 * resource created deps-first (outside the graph). Because the namespace is no
 * longer a graph child, deleting the instance can never garbage-collect the
 * namespace holding its own finalizer — so the guard passes with no relocation.
 */

describe('bootstrap factories: self-owned namespace is hoisted + retained, not rejected', () => {
  it('dagsterBootstrap serializes without throwing; instance stays in the workload namespace', () => {
    const factory = dagsterBootstrap.factory('kro', { namespace: 'dagster' });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({ name: 'analytics', namespace: 'dagster' } as never);
    }).not.toThrow();
    // The instance CR stays in its natural workload namespace — never relocated.
    expect(yaml).toMatch(/namespace: dagster$/m);
    expect(yaml).not.toContain('typekro-system');
    // The owned workload namespace is hoisted out of the graph and emitted retained.
    expect(yaml).toContain('typekro.io/kro-instance-namespace');
    // The RGD (namespace-less toYaml) references the workload namespace on its
    // workloads but no longer OWNS the Namespace as a graph child.
    const rgd = dagsterBootstrap.factory('kro', { namespace: 'dagster' }).toYaml();
    expect(rgd).toContain('${schema.spec.namespace}');
    expect(rgd).not.toContain('kind: Namespace');
  });

  it('dagsterBootstrap.toAlchemyResources emits the hoisted namespace first, EMPTY-GATED', async () => {
    const factory = dagsterBootstrap.factory('kro', { namespace: 'dagster' });
    const decls = await factory.toAlchemyResources({
      name: 'analytics',
      namespace: 'dagster',
    } as never);
    const nsDecl = decls.find(
      (declaration) =>
        declaration.props.resource.kind === 'Namespace' &&
        declaration.props.resource.metadata?.name === 'dagster'
    );
    expect(nsDecl?.props.resource.kind).toBe('Namespace');
    expect(nsDecl?.props.resource.metadata?.name).toBe('dagster');
    // Findings #3 + #4: the namespace is EMPTY-GATED (delete-if-empty / retain-if-occupied)
    // rather than retain-by-name-equality. Alchemy's reverse-topo teardown runs its
    // delete AFTER the RGD + instance (both dependsOn it) — the delete-after-RGD ordering.
    expect(nsDecl?.props.namespaceEmptyGate).toBe(true);
    expect(nsDecl?.props.retain).toBeUndefined();
    // The RGD depends on the namespace and the instance depends on the RGD, so
    // reverse-topological teardown removes the instance, then RGD, then namespace.
    const rgdDecl = decls.find(
      (declaration) =>
        declaration.props.resource.kind === 'ResourceGraphDefinition' &&
        declaration.props.resource.metadata?.name === 'dagster-bootstrap'
    );
    expect(rgdDecl?.dependsOn).toContain(nsDecl?.id);
    // The instance CR (last declaration) stays in the workload namespace.
    expect(decls.at(-1)?.props.namespace).toBe('dagster');
    // The instance CR itself is neither retained nor empty-gated (torn down normally).
    expect(decls.at(-1)?.props.retain).toBeUndefined();
    expect(decls.at(-1)?.props.namespaceEmptyGate).toBeUndefined();
  });

  it('clickhouseOperatorBootstrap serializes without throwing (instance in workload ns)', () => {
    const factory = clickhouseOperatorBootstrap.factory('kro', { namespace: 'clickhouse-system' });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({
        name: 'clickhouse-operator',
        namespace: 'clickhouse-system',
      } as never);
    }).not.toThrow();
    expect(yaml).toMatch(/namespace: clickhouse-system$/m);
    expect(yaml).toContain('typekro.io/kro-instance-namespace');
    expect(yaml).not.toContain('typekro-system');
  });

  it('valkeyBootstrap serializes without throwing (instance in workload ns)', () => {
    const factory = valkeyBootstrap.factory('kro', { namespace: 'valkey-operator-system' });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({
        name: 'valkey-operator',
        namespace: 'valkey-operator-system',
      } as never);
    }).not.toThrow();
    expect(yaml).toMatch(/namespace: valkey-operator-system$/m);
    expect(yaml).toContain('typekro.io/kro-instance-namespace');
  });

  it('finding #2: same-named instances in different factory namespaces share ONE alchemy id (a different k8s namespace is NOT an alchemy scope)', async () => {
    // The alchemy id is the legacy namespace-agnostic kind+name (round-6 finding #1) —
    // reverted from the namespace-hashed id that broke existing state. The honest
    // consequence (finding #2): a different k8s FACTORY namespace does NOT by itself
    // create a different alchemy scope. `analytics` deployed from a `dev` factory and
    // from a `prod` factory expose the SAME alchemy id; materialized in the SAME
    // alchemy stack they would COLLIDE (last write wins). Isolating them is the
    // CALLER's responsibility — separate alchemy stacks/scopes — NOT something the
    // differing k8s namespace does automatically. This test pins that reality; it must
    // NOT assert automatic isolation.
    const dev = await dagsterBootstrap
      .factory('kro', { namespace: 'dev' })
      .toAlchemyResources({ name: 'analytics', namespace: 'dev' } as never);
    const prod = await dagsterBootstrap
      .factory('kro', { namespace: 'prod' })
      .toAlchemyResources({ name: 'analytics', namespace: 'prod' } as never);

    const devInstance = dev.at(-1);
    const prodInstance = prod.at(-1);
    // The CR lands in its own factory namespace (a k8s placement fact only)...
    expect(devInstance?.props.namespace).toBe('dev');
    expect(prodInstance?.props.namespace).toBe('prod');
    // ...but that does NOT isolate them in alchemy: they share the SAME alchemy id, so
    // in one stack the second clobbers the first. Distinctness requires SEPARATE
    // alchemy stacks/scopes (the caller's job), not the differing k8s namespace.
    expect(devInstance?.id).toBe(prodInstance?.id as string);
    // The hoisted retained-namespace declaration IS keyed by the workload ns NAME, so
    // those two happen to differ here — but that is the namespace singleton's id, not
    // the instance CR's, and does not isolate the CRs from each other.
    const devNamespace = dev.find(
      (declaration) =>
        declaration.props.resource.kind === 'Namespace' &&
        declaration.props.resource.metadata?.name === 'dev'
    );
    const prodNamespace = prod.find(
      (declaration) =>
        declaration.props.resource.kind === 'Namespace' &&
        declaration.props.resource.metadata?.name === 'prod'
    );
    expect(devNamespace?.props.resource.metadata?.name).toBe('dev');
    expect(prodNamespace?.props.resource.metadata?.name).toBe('prod');
    expect(devNamespace?.id).not.toBe(prodNamespace?.id as string);
  });

  it('the hoisted namespace is retained for BOTH Flux and Argo (survives Application deletion)', () => {
    // The emitted workload Namespace must carry the prune opt-out for BOTH major
    // GitOps reconcilers, and the Argo option must survive Application DELETION
    // (`Delete=false`), not merely a sync-prune (`Prune=false` alone does not).
    const yaml = dagsterBootstrap
      .factory('kro')
      .toYaml({ name: 'demo', namespace: 'dagster' } as never);
    expect(yaml).toContain('kustomize.toolkit.fluxcd.io/prune: disabled');
    expect(yaml).toContain('argocd.argoproj.io/sync-options: Prune=false,Delete=false');
  });

  it('the hoisted namespace alchemy declaration is EMPTY-GATED on teardown (delete-if-empty)', async () => {
    const decls = await dagsterBootstrap
      .factory('kro')
      .toAlchemyResources({ name: 'demo', namespace: 'dagster' } as never);
    const nsDecl = decls.find(
      (declaration) =>
        declaration.props.resource.kind === 'Namespace' &&
        declaration.props.resource.metadata?.name === 'dagster'
    );
    expect(nsDecl?.props.resource.kind).toBe('Namespace');
    expect(nsDecl?.props.resource.metadata?.name).toBe('dagster');
    // Findings #3 + #4: replaces the old retain-by-name-equality distinction. Every
    // hoisted namespace is empty-gated — deleted ONLY if empty, retained if another
    // stack/user still has resources inside it — so `retain` is no longer set.
    expect(nsDecl?.props.namespaceEmptyGate).toBe(true);
    expect(nsDecl?.props.retain).toBeUndefined();
    // The instance CR itself is not empty-gated (it's per-consumer, torn down normally).
    expect(decls.at(-1)?.props.namespaceEmptyGate).toBeUndefined();
  });

  it('the hoisted namespace is a SINGLETON deduped by NAME across factories', async () => {
    // Two independent factories/stacks targeting the SAME workload namespace emit
    // the SAME namespace declaration (same id), so alchemy converges on ONE shared
    // object rather than N fighting copies. Its teardown is empty-gated: whichever
    // stack tears down last (leaving it empty) deletes it; while any stack still has
    // resources inside, the gate retains it — no cross-stack refcount needed.
    const a = await dagsterBootstrap
      .factory('kro')
      .toAlchemyResources({ name: 'a', namespace: 'shared-ns' } as never);
    const b = await valkeyBootstrap
      .factory('kro')
      .toAlchemyResources({ name: 'b', namespace: 'shared-ns' } as never);
    const aNamespace = a.find(
      (declaration) =>
        declaration.props.resource.kind === 'Namespace' &&
        declaration.props.resource.metadata?.name === 'shared-ns'
    );
    const bNamespace = b.find(
      (declaration) =>
        declaration.props.resource.kind === 'Namespace' &&
        declaration.props.resource.metadata?.name === 'shared-ns'
    );
    expect(aNamespace?.props.resource.metadata?.name).toBe('shared-ns');
    expect(bNamespace?.props.resource.metadata?.name).toBe('shared-ns');
    expect(aNamespace?.id).toBe(bNamespace?.id as string);
    expect(aNamespace?.props.namespaceEmptyGate).toBe(true);
    expect(bNamespace?.props.namespaceEmptyGate).toBe(true);
  });

  it('clickstackBootstrap serializes without throwing (instance in workload ns)', () => {
    const factory = clickstackBootstrap.factory('kro', { namespace: 'clickstack' });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({
        name: 'clickstack',
        namespace: 'clickstack',
        clickhouse: {
          host: 'ch.clickstack.svc.cluster.local',
          nativePort: 9000,
          username: 'default',
          password: 'secret',
        },
        apiKey: 'test-key',
      } as never);
    }).not.toThrow();
    expect(yaml).toMatch(/namespace: clickstack$/m);
    expect(yaml).toContain('typekro.io/kro-instance-namespace');
  });
});
