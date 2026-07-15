import { describe, expect, it } from 'bun:test';
import {
  valkeyBootstrap,
  valkeyOperatorInstallation,
} from '../../../src/factories/valkey/compositions/valkey-bootstrap.js';

function splitDocs(yaml: string): string[] {
  return yaml
    .split(/^---$/m)
    .map((doc) => doc.trim())
    .filter(Boolean);
}

describe('Valkey operator installation contract', () => {
  it('uses one explicit owner for namespace, repository, and release in direct mode', () => {
    expect(valkeyOperatorInstallation).toBe(valkeyBootstrap);
    const factory = valkeyBootstrap.factory('direct', { namespace: 'control-plane' });
    const docs = splitDocs(
      factory.toYaml({
        name: 'valkey-operator',
        namespace: 'valkey-system',
      })
    );

    expect(docs.map((doc) => doc.match(/^kind: (.+)$/m)?.[1])).toEqual([
      'Namespace',
      'HelmRepository',
      'HelmRelease',
    ]);
    expect(docs.join('\n')).toContain('namespace: valkey-system');
    expect(docs.join('\n')).not.toContain('kind: ClusterRole');
    expect(docs.join('\n')).not.toContain('kind: ClusterRoleBinding');
  });

  it('generates a KRO owner RGD with authoritative HelmRelease status', () => {
    const yaml = valkeyBootstrap.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('kind: HelmRepository');
    expect(yaml).toContain('kind: HelmRelease');
    expect(yaml).toContain('.exists(c, c.type == "Ready"');
    expect(yaml).toContain('schema.spec.repositoryNamespace');
    expect(yaml).not.toContain('kind: ClusterRole');
    expect(yaml).not.toContain('kind: ClusterRoleBinding');
  });

  it('supports both deployment strategies', () => {
    expect(valkeyBootstrap.factory('direct', { namespace: 'test' }).mode).toBe('direct');
    expect(valkeyBootstrap.factory('kro', { namespace: 'test' }).mode).toBe('kro');
  });

  it('hoists the owned operator Namespace out of the RGD and retains it, CR stays put', async () => {
    // valkeyBootstrap owns its operator Namespace, and the natural call places the
    // instance CR in that same namespace. The fix HOISTS the owned Namespace OUT of
    // the RGD graph and re-emits it as a RETAINED resource created deps-first, so
    // the instance stays in its natural namespace (no `typekro-system` relocation)
    // and deleting the instance can never garbage-collect the namespace holding its
    // own finalizer.
    const factory = valkeyBootstrap.factory('kro', { namespace: 'valkey-system' });
    const spec = {
      name: 'valkey-operator',
      namespace: 'valkey-system',
    };

    // The instance bundle: the retained Namespace leads, then the CR instance —
    // and the CR is NOT relocated to any control-plane namespace.
    const instanceYaml = factory.toYaml(spec);
    expect(instanceYaml).not.toContain('typekro-system');
    expect(instanceYaml).toMatch(/namespace: valkey-system$/m);
    const instanceDocs = splitDocs(instanceYaml);
    expect(instanceDocs.map((doc) => doc.match(/^kind: (.+)$/m)?.[1])).toEqual([
      'Namespace',
      'ValkeyBootstrap',
    ]);
    // The retained Namespace carries retention markers for BOTH GitOps reconcilers.
    expect(instanceYaml).toContain('typekro.io/kro-instance-namespace');
    expect(instanceYaml).toContain('kustomize.toolkit.fluxcd.io/prune: disabled');
    expect(instanceYaml).toContain('argocd.argoproj.io/sync-options: Prune=false,Delete=false');

    // The shared RGD (namespace-less toYaml) no longer OWNS the Namespace as a graph
    // child, but still wires the workload resources into the schema namespace.
    const rgdYaml = valkeyBootstrap.factory('kro', { namespace: 'valkey-system' }).toYaml();
    expect(rgdYaml).toContain('kind: ResourceGraphDefinition');
    expect(rgdYaml).toContain('kind: HelmRelease');
    expect(rgdYaml).not.toContain('kind: Namespace');
    expect(rgdYaml).toContain('schema.spec.namespace');

    // The alchemy bundle: hoisted Namespace first (empty-gated on teardown), instance last.
    const decls = await factory.toAlchemyResources(spec);
    expect(decls[0]?.props.resource.kind).toBe('Namespace');
    expect(decls[0]?.props.resource.metadata?.name).toBe('valkey-system');
    // Findings #3 + #4: empty-gated teardown replaces retain-by-name-equality.
    expect(decls[0]?.props.namespaceEmptyGate).toBe(true);
    expect(decls[0]?.props.retain).toBeUndefined();
    expect(decls.at(-1)?.props.namespace).toBe('valkey-system');
    expect(decls.at(-1)?.props.retain).toBeUndefined();
  });

  it('an explicit instanceNamespace pins the CR to a separate control-plane namespace', () => {
    // Opting the CR into a dedicated control-plane namespace is done with the
    // explicit `instanceNamespace` factory option (which flows identically through
    // create/getInstances/deleteInstance, finding #2). The operator workloads still
    // target the workload namespace from `spec.namespace`.
    const factory = valkeyBootstrap.factory('kro', {
      namespace: 'valkey-system',
      instanceNamespace: 'typekro-system',
    });
    const yaml = factory.toYaml({
      name: 'valkey-operator',
      namespace: 'valkey-system',
    });

    // The CR metadata lands in the control-plane namespace...
    expect(yaml).toMatch(/namespace: typekro-system$/m);
    // ...and the operator workloads still target the workload namespace.
    expect(yaml).toContain('namespace: valkey-system');
  });
});
