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
 * guard hard-rejected with no escape hatch. With `ownsInstanceNamespace`, the
 * instance CR is decoupled into a derived control-plane namespace (`X-kro`),
 * so the workload namespace is still created/owned while the finalizer can
 * never be stranded by its own namespace terminating.
 */
describe('bootstrap factories: self-owned instance namespace is decoupled, not rejected', () => {
  it('dagsterBootstrap serializes without throwing; instance in the control-plane namespace', () => {
    const factory = dagsterBootstrap.factory('kro', { namespace: 'dagster' });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({ name: 'analytics', namespace: 'dagster' } as never);
    }).not.toThrow();
    // Instance CR + its control-plane Namespace land in `dagster-kro`.
    expect(yaml).toContain('namespace: dagster-kro');
    expect(yaml).toContain('typekro.io/kro-instance-namespace');
    // The workload namespace is still carried on the instance spec.
    expect(yaml).toMatch(/namespace: dagster$/m);
    // The RGD (namespace-less toYaml) still creates and owns the workload namespace.
    expect(dagsterBootstrap.toYaml()).toContain('${schema.spec.namespace}');
  });

  it('dagsterBootstrap.toAlchemyResources emits the control-plane namespace first', async () => {
    const factory = dagsterBootstrap.factory('kro', { namespace: 'dagster' });
    const decls = await factory.toAlchemyResources({
      name: 'analytics',
      namespace: 'dagster',
    } as never);
    const nsDecl = decls[0];
    expect(nsDecl?.props.resource.kind).toBe('Namespace');
    expect(nsDecl?.props.resource.metadata?.name).toBe('dagster-kro');
    // The instance CR (last declaration) is namespaced to the control-plane namespace.
    expect(decls.at(-1)?.props.namespace).toBe('dagster-kro');
  });

  it('clickhouseOperatorBootstrap serializes without throwing', () => {
    const factory = clickhouseOperatorBootstrap.factory('kro', { namespace: 'clickhouse-system' });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({ name: 'clickhouse-operator', namespace: 'clickhouse-system' } as never);
    }).not.toThrow();
    expect(yaml).toContain('namespace: clickhouse-system-kro');
  });

  it('valkeyBootstrap serializes without throwing', () => {
    const factory = valkeyBootstrap.factory('kro', { namespace: 'valkey-operator-system' });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({
        name: 'valkey-operator',
        namespace: 'valkey-operator-system',
      } as never);
    }).not.toThrow();
    expect(yaml).toContain('namespace: valkey-operator-system-kro');
  });

  it('derives the control-plane namespace from the CONCRETE spec, not factory creation', () => {
    // Regression for P1-a: the control-plane namespace was resolved at
    // `.factory('kro')` time (before a spec exists), so a factory created with no
    // namespace put every instance in `default-kro` regardless of `spec.namespace`.
    // Now the SPEC's workload namespace wins.
    const factory = dagsterBootstrap.factory('kro');
    const yaml = factory.toYaml({ name: 'demo', namespace: 'workloads' } as never);
    expect(yaml).toContain('namespace: workloads-kro');
    expect(yaml).not.toContain('namespace: default-kro');
  });

  it('one factory, two specs with different namespaces → two distinct control-plane namespaces (no collision)', () => {
    // A single factory reused across specs must NOT collide instances on a single
    // (kind, name, namespace) key — each workload namespace gets its own `<ns>-kro`.
    const factory = dagsterBootstrap.factory('kro');
    const dev = factory.toYaml({ name: 'analytics', namespace: 'dev' } as never);
    const prod = factory.toYaml({ name: 'analytics', namespace: 'prod' } as never);
    expect(dev).toContain('namespace: dev-kro');
    expect(dev).not.toContain('namespace: prod-kro');
    expect(prod).toContain('namespace: prod-kro');
    expect(prod).not.toContain('namespace: dev-kro');
  });

  it('the control-plane namespace is marked retained (prune-disabled) shared infrastructure', () => {
    // Regression for P1-b (GitOps side): the emitted control-plane Namespace must
    // carry the Flux prune opt-out so a consumer's Kustomization reconcile never
    // deletes this shared namespace out from under another stack's instances.
    const yaml = dagsterBootstrap.factory('kro').toYaml({ name: 'demo', namespace: 'dagster' } as never);
    expect(yaml).toContain('kustomize.toolkit.fluxcd.io/prune: disabled');
  });

  it('the control-plane namespace alchemy declaration is retained (never deleted on teardown)', async () => {
    // Regression for P1-b (alchemy side): the namespace declaration must be marked
    // `retain` so a single stack's teardown/prune leaves it on-cluster.
    const decls = await dagsterBootstrap
      .factory('kro')
      .toAlchemyResources({ name: 'demo', namespace: 'dagster' } as never);
    const nsDecl = decls[0];
    expect(nsDecl?.props.resource.kind).toBe('Namespace');
    expect(nsDecl?.props.resource.metadata?.name).toBe('dagster-kro');
    expect(nsDecl?.props.retain).toBe(true);
    // The instance CR itself is NOT retained (it's per-consumer, torn down normally).
    expect(decls.at(-1)?.props.retain).toBeUndefined();
  });

  it('two factories on the same workload namespace produce the same retained control-plane namespace (no conflicting owned copies)', async () => {
    // P1-b: independent stacks targeting the same workload namespace resolve the
    // SAME control-plane namespace with the SAME (retained) declaration id, so
    // they converge on one shared, retained object rather than fighting to own
    // and delete separate copies.
    const a = await dagsterBootstrap
      .factory('kro')
      .toAlchemyResources({ name: 'a', namespace: 'dagster' } as never);
    const b = await dagsterBootstrap
      .factory('kro')
      .toAlchemyResources({ name: 'b', namespace: 'dagster' } as never);
    expect(a[0]?.id).toBe(b[0]?.id as string);
    expect(a[0]?.props.resource.metadata?.name).toBe('dagster-kro');
    expect(a[0]?.props.retain).toBe(true);
    expect(b[0]?.props.retain).toBe(true);
  });

  it('clickstackBootstrap serializes without throwing', () => {
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
    expect(yaml).toContain('namespace: clickstack-kro');
  });
});
