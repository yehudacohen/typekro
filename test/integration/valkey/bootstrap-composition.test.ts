import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { ensureNamespaceExists } from '../shared-kubeconfig.js';

describe('Valkey Bootstrap Composition Tests', () => {
  let kubeConfig: any;
  const testNamespace = 'typekro-test-valkey-bootstrap';
  const operatorNs = 'valkey-test-op';

  beforeAll(async () => {
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      await ensureNamespaceExists(testNamespace, kubeConfig);
    } catch (error) {
      console.error('❌ Failed to connect to cluster:', error);
      throw error;
    }
  });

  afterAll(async () => {
    const { deleteNamespaceAndWait } = await import('../shared-kubeconfig.js');
    await Promise.allSettled(
      [testNamespace, operatorNs].map((ns) =>
        deleteNamespaceAndWait(ns, kubeConfig)
      )
    );
  });

  it('should deploy operator and hydrate all status fields', async () => {
    const { valkeyBootstrap } = await import(
      '../../../src/factories/valkey/compositions/valkey-bootstrap.js'
    );

    const factory = valkeyBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });

    const instance = await factory.deploy({
      name: 'valkey-operator',
      namespace: operatorNs,
    });

    // Spec fields
    expect(instance.spec.name).toBe('valkey-operator');
    expect(instance.spec.namespace).toBe(operatorNs);

    // All status fields — hydrated after waitForReady
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.failed).toBe(false);
    expect(instance.status.version).toBe('v0.0.61');

    await factory.deleteInstance('valkey-operator');
  }, 900000);

  it('should generate ResourceGraphDefinition YAML with CEL status expressions', async () => {
    const { valkeyBootstrap } = await import(
      '../../../src/factories/valkey/compositions/valkey-bootstrap.js'
    );

    const yaml: string = valkeyBootstrap.toYaml();

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: valkey-bootstrap');
    expect(yaml).toContain('status:');
    expect(yaml).toContain('.exists(c, c.type == "Ready"');
    expect(yaml).toContain('Ready');
    expect(yaml).toContain('Installing');
    expect(yaml).toContain('kind: ClusterRole');
    expect(yaml).toContain('name: valkey-operator-manager-role');
    expect(yaml).toContain('kind: ClusterRoleBinding');
    expect(yaml).toContain('name: valkey-operator-controller-manager');
    expect(yaml).toContain('namespace: "${has(schema.spec.namespace) ? schema.spec.namespace');
  });

  it('should support both kro and direct deployment strategies', async () => {
    const { valkeyBootstrap } = await import(
      '../../../src/factories/valkey/compositions/valkey-bootstrap.js'
    );

    const directFactory = valkeyBootstrap.factory('direct', {
      namespace: testNamespace,
      kubeConfig,
    });

    const kroFactory = valkeyBootstrap.factory('kro', {
      namespace: testNamespace,
      kubeConfig,
    });

    expect(directFactory.mode).toBe('direct');
    expect(kroFactory.mode).toBe('kro');
  });
});
