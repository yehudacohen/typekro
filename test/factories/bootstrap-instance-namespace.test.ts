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

  it('dagsterBootstrap.toAlchemyResources emits the retained workload namespace first', async () => {
    const factory = dagsterBootstrap.factory('kro', { namespace: 'dagster' });
    const decls = await factory.toAlchemyResources({
      name: 'analytics',
      namespace: 'dagster',
    } as never);
    const nsDecl = decls[0];
    expect(nsDecl?.props.resource.kind).toBe('Namespace');
    expect(nsDecl?.props.resource.metadata?.name).toBe('dagster');
    expect(nsDecl?.props.retain).toBe(true);
    // The instance CR (last declaration) stays in the workload namespace.
    expect(decls.at(-1)?.props.namespace).toBe('dagster');
    // The instance CR itself is NOT retained (it's per-consumer, torn down normally).
    expect(decls.at(-1)?.props.retain).toBeUndefined();
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

  it('finding #2: same name in distinct FACTORY namespaces → DISTINCT identities (no collapse)', async () => {
    // The instance-relocation design forced both analytics/dev and analytics/prod
    // into `typekro-system`, collapsing them to the SAME alchemy id (the second
    // clobbering the first). Per the maintainer's decision (finding #2) the CR lives
    // in the FACTORY namespace, so analytics/dev and analytics/prod are kept distinct
    // by distinct FACTORY namespaces; the alchemy id qualified by the resolved
    // (factory) namespace never collapses.
    const dev = await dagsterBootstrap
      .factory('kro', { namespace: 'dev' })
      .toAlchemyResources({ name: 'analytics', namespace: 'dev' } as never);
    const prod = await dagsterBootstrap
      .factory('kro', { namespace: 'prod' })
      .toAlchemyResources({ name: 'analytics', namespace: 'prod' } as never);

    const devInstance = dev.at(-1);
    const prodInstance = prod.at(-1);
    // Different namespaces...
    expect(devInstance?.props.namespace).toBe('dev');
    expect(prodInstance?.props.namespace).toBe('prod');
    // ...and different alchemy ids — no collapse.
    expect(devInstance?.id).not.toBe(prodInstance?.id as string);
    // Their hoisted retained namespaces are also distinct (one per workload ns).
    expect(dev[0]?.props.resource.metadata?.name).toBe('dev');
    expect(prod[0]?.props.resource.metadata?.name).toBe('prod');
    expect(dev[0]?.id).not.toBe(prod[0]?.id as string);
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

  it('the hoisted namespace alchemy declaration is retained (never deleted on teardown)', async () => {
    const decls = await dagsterBootstrap
      .factory('kro')
      .toAlchemyResources({ name: 'demo', namespace: 'dagster' } as never);
    const nsDecl = decls[0];
    expect(nsDecl?.props.resource.kind).toBe('Namespace');
    expect(nsDecl?.props.resource.metadata?.name).toBe('dagster');
    expect(nsDecl?.props.retain).toBe(true);
    // The instance CR itself is NOT retained (it's per-consumer, torn down normally).
    expect(decls.at(-1)?.props.retain).toBeUndefined();
  });

  it('the hoisted namespace is a SINGLETON deduped by NAME across factories', async () => {
    // Two independent factories/stacks targeting the SAME workload namespace emit
    // the SAME retained namespace declaration (same id), so alchemy converges on
    // ONE shared, retained object rather than N fighting copies. Different kinds,
    // same workload namespace ('shared-ns') → one deduped namespace declaration.
    const a = await dagsterBootstrap
      .factory('kro')
      .toAlchemyResources({ name: 'a', namespace: 'shared-ns' } as never);
    const b = await valkeyBootstrap
      .factory('kro')
      .toAlchemyResources({ name: 'b', namespace: 'shared-ns' } as never);
    expect(a[0]?.props.resource.metadata?.name).toBe('shared-ns');
    expect(b[0]?.props.resource.metadata?.name).toBe('shared-ns');
    expect(a[0]?.id).toBe(b[0]?.id as string);
    expect(a[0]?.props.retain).toBe(true);
    expect(b[0]?.props.retain).toBe(true);
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
