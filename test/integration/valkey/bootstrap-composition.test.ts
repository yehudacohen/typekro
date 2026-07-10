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

  it('rejects a KRO instance in the namespace its graph owns', () => {
    const factory = valkeyBootstrap.factory('kro', { namespace: 'valkey-system' });
    const unsafeSpec = {
      name: 'valkey-operator',
      namespace: 'valkey-system',
    };

    expect(() => factory.toYaml(unsafeSpec)).toThrow(
      /control-plane namespace separate from the owned operator namespace/
    );
    expect(() => factory.toAlchemyResources(unsafeSpec)).toThrow(
      /control-plane namespace separate from the owned operator namespace/
    );
  });

  it('accepts a separate KRO control-plane and operator namespace', () => {
    const factory = valkeyBootstrap.factory('kro', { namespace: 'typekro-system' });
    const yaml = factory.toYaml({
      name: 'valkey-operator',
      namespace: 'valkey-system',
    });

    expect(yaml).toContain('namespace: typekro-system');
    expect(yaml).toContain('namespace: valkey-system');
  });
});
