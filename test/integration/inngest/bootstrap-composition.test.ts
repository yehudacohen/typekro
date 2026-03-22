import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { ensureNamespaceExists } from '../shared-kubeconfig.js';

describe('Inngest Bootstrap Composition Tests', () => {
  let kubeConfig: any;
  const testNamespace = 'typekro-test-inngest-bootstrap';
  const inngestNs = 'inngest-test';

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
      [testNamespace, inngestNs].map((ns) =>
        deleteNamespaceAndWait(ns, kubeConfig)
      )
    );
  });

  it('should deploy Inngest and hydrate all status fields', async () => {
    const { inngestBootstrap } = await import(
      '../../../src/factories/inngest/compositions/inngest-bootstrap.js'
    );

    const factory = inngestBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });

    const instance = await factory.deploy({
      name: 'inngest',
      namespace: inngestNs,
      inngest: {
        eventKey: 'deadbeef0123456789abcdef01234567',
        signingKey: 'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
      },
    });

    // Spec fields
    expect(instance.spec.name).toBe('inngest');
    expect(instance.spec.namespace).toBe(inngestNs);
    expect(instance.spec.inngest.eventKey).toBe('deadbeef0123456789abcdef01234567');

    // All status fields — hydrated after waitForReady
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.failed).toBe(false);
    expect(instance.status.version).toBe('0.3.1');

    await factory.deleteInstance('inngest');
  }, 900000);

  it('should generate ResourceGraphDefinition YAML with CEL expressions', async () => {
    const { inngestBootstrap } = await import(
      '../../../src/factories/inngest/compositions/inngest-bootstrap.js'
    );

    const yaml: string = inngestBootstrap.toYaml();

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: inngest-bootstrap');
    expect(yaml).toContain('status:');
    expect(yaml).toContain('.exists(c, c.type == "Ready"');
    expect(yaml).toContain('Ready');
    expect(yaml).toContain('Installing');
  });

  it('should support both kro and direct deployment strategies', async () => {
    const { inngestBootstrap } = await import(
      '../../../src/factories/inngest/compositions/inngest-bootstrap.js'
    );

    const directFactory = inngestBootstrap.factory('direct', {
      namespace: testNamespace,
      kubeConfig,
    });

    const kroFactory = inngestBootstrap.factory('kro', {
      namespace: testNamespace,
      kubeConfig,
    });

    expect(directFactory.mode).toBe('direct');
    expect(kroFactory.mode).toBe('kro');
  });
});
