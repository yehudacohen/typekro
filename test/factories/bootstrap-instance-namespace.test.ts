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
