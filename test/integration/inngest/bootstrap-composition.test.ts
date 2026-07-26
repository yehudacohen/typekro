import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(900_000);

import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import type { ResourceFactory } from '../../../src/core/types/deployment.js';
import type {
  InngestBootstrapConfig,
  InngestBootstrapStatus,
} from '../../../src/factories/inngest/types.js';
import {
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  requireTestStorageClass,
  runWithExpectedTestNamespace,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

describe('Inngest Bootstrap Composition Tests', () => {
  let kubeConfig: ReturnType<typeof getKubeConfig>;
  let factory: ResourceFactory<InngestBootstrapConfig, InngestBootstrapStatus> | undefined;
  let testNamespaceLease: TestNamespaceLease | undefined;
  let inngestNamespaceLease: TestNamespaceLease | undefined;
  let storageClass: string;
  const suffix = crypto.randomUUID().slice(0, 8);
  const testNamespace = `typekro-test-inngest-${suffix}`;
  const inngestNs = `inngest-test-${suffix}`;

  beforeAll(async () => {
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      storageClass = await requireTestStorageClass({ kubeConfig });
      testNamespaceLease = await createTestNamespace(testNamespace, kubeConfig);
    } catch (error) {
      console.error('❌ Failed to connect to cluster:', error);
      throw error;
    }
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    if (factory) {
      try {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          factory,
          'inngest',
          inngestNamespaceLease ? [inngestNamespaceLease] : [],
          kubeConfig,
          120_000,
          { scopes: ['cluster'] }
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (testNamespaceLease) {
      try {
        await deleteTestNamespaceAndWait(testNamespaceLease, kubeConfig);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Inngest integration cleanup did not complete safely');
    }
  });

  it('should deploy Inngest and hydrate all status fields', async () => {
    const { inngestBootstrap } = await import(
      '../../../src/factories/inngest/compositions/inngest-bootstrap.js'
    );

    factory = inngestBootstrap.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });

    const instance = await runWithExpectedTestNamespace(
      inngestNs,
      kubeConfig,
      (lease) => {
        inngestNamespaceLease = lease;
      },
      () =>
        factory!.deploy({
          name: 'inngest',
          namespace: inngestNs,
          inngest: {
            eventKey: 'deadbeef0123456789abcdef01234567',
            signingKey: 'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
          },
          postgresql: {
            persistence: { storageClass },
          },
          redis: {
            persistence: { storageClass },
          },
        })
    );

    // Spec fields
    expect(instance.spec.name).toBe('inngest');
    expect(instance.spec.namespace).toBe(inngestNs);
    expect(instance.spec.inngest.eventKey).toBe('deadbeef0123456789abcdef01234567');

    // All status fields — hydrated after waitForReady
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.failed).toBe(false);
    expect(instance.status.version).toBe('0.3.1');
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
    expect(yaml).toContain('create: false');
    expect(yaml).toContain("name: '${has(schema.spec.namespace) ? schema.spec.namespace :");
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
