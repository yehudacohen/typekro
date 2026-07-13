import { describe, expect, it } from 'bun:test';

import { KRO_INSTANCE_CONTROL_PLANE_NAMESPACE } from '../../src/core/config/defaults.js';
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
 * The fix AUTO-DETECTS self-ownership (reusing the guard's own detection) and
 * relocates the instance CR into a single, stable control-plane namespace
 * (`typekro-system`) — no per-composition flag. The workload namespace is still
 * created/owned; the finalizer can never be stranded by its own namespace
 * terminating.
 */
const CP = KRO_INSTANCE_CONTROL_PLANE_NAMESPACE;

describe('bootstrap factories: self-owned instance namespace is auto-relocated, not rejected', () => {
  it('constant is the shared typekro-system control-plane namespace', () => {
    expect(CP).toBe('typekro-system');
  });

  it('dagsterBootstrap serializes without throwing; instance in the control-plane namespace', () => {
    const factory = dagsterBootstrap.factory('kro', { namespace: 'dagster' });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({ name: 'analytics', namespace: 'dagster' } as never);
    }).not.toThrow();
    // Instance CR + its control-plane Namespace land in `typekro-system`.
    expect(yaml).toContain(`namespace: ${CP}`);
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
    expect(nsDecl?.props.resource.metadata?.name).toBe(CP);
    // The instance CR (last declaration) is namespaced to the control-plane namespace.
    expect(decls.at(-1)?.props.namespace).toBe(CP);
  });

  it('clickhouseOperatorBootstrap serializes without throwing', () => {
    const factory = clickhouseOperatorBootstrap.factory('kro', { namespace: 'clickhouse-system' });
    let yaml = '';
    expect(() => {
      yaml = factory.toYaml({
        name: 'clickhouse-operator',
        namespace: 'clickhouse-system',
      } as never);
    }).not.toThrow();
    expect(yaml).toContain(`namespace: ${CP}`);
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
    expect(yaml).toContain(`namespace: ${CP}`);
  });

  it('one stable control-plane namespace regardless of the workload namespace', () => {
    // Unlike the abandoned per-workload `<ns>-kro` model, EVERY workload namespace
    // relocates to the SAME single control-plane namespace — a constant that is
    // always a valid DNS-1123 label and resolvable without a spec.
    const factory = dagsterBootstrap.factory('kro');
    const dev = factory.toYaml({ name: 'analytics', namespace: 'dev' } as never);
    const prod = dagsterBootstrap
      .factory('kro')
      .toYaml({ name: 'analytics', namespace: 'prod' } as never);
    expect(dev).toContain(`namespace: ${CP}`);
    expect(dev).not.toContain('namespace: dev-kro');
    expect(prod).toContain(`namespace: ${CP}`);
    expect(prod).not.toContain('namespace: prod-kro');
    // Workload namespaces are still distinct on the instance spec.
    expect(dev).toMatch(/namespace: dev$/m);
    expect(prod).toMatch(/namespace: prod$/m);
  });

  it('the control-plane namespace is retained for BOTH Flux and Argo (P1-b)', () => {
    // The emitted control-plane Namespace must carry the prune opt-out for BOTH
    // major GitOps reconcilers, so a prune by whichever tool manages a consuming
    // app never deletes this shared namespace out from under another stack.
    const yaml = dagsterBootstrap
      .factory('kro')
      .toYaml({ name: 'demo', namespace: 'dagster' } as never);
    expect(yaml).toContain('kustomize.toolkit.fluxcd.io/prune: disabled');
    expect(yaml).toContain('argocd.argoproj.io/sync-options: Prune=false');
  });

  it('the control-plane namespace alchemy declaration is retained (never deleted on teardown)', async () => {
    const decls = await dagsterBootstrap
      .factory('kro')
      .toAlchemyResources({ name: 'demo', namespace: 'dagster' } as never);
    const nsDecl = decls[0];
    expect(nsDecl?.props.resource.kind).toBe('Namespace');
    expect(nsDecl?.props.resource.metadata?.name).toBe(CP);
    expect(nsDecl?.props.retain).toBe(true);
    // The instance CR itself is NOT retained (it's per-consumer, torn down normally).
    expect(decls.at(-1)?.props.retain).toBeUndefined();
  });

  it('the control-plane namespace is a deduped SINGLETON across factories (P1-b)', async () => {
    // Two independent factories (even for different workload namespaces, and
    // different composition kinds) relocate to the SAME control-plane namespace
    // with the SAME declaration id, so alchemy converges on ONE shared, retained
    // object rather than N fighting copies each trying to own/delete it.
    const a = await dagsterBootstrap
      .factory('kro')
      .toAlchemyResources({ name: 'a', namespace: 'dagster' } as never);
    const b = await clickhouseOperatorBootstrap
      .factory('kro')
      .toAlchemyResources({ name: 'b', namespace: 'clickhouse-system' } as never);
    expect(a[0]?.id).toBe(b[0]?.id as string);
    expect(a[0]?.props.resource.metadata?.name).toBe(CP);
    expect(b[0]?.props.resource.metadata?.name).toBe(CP);
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
    expect(yaml).toContain(`namespace: ${CP}`);
  });
});
