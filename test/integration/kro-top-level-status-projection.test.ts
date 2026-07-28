import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import type { KroResourceFactory } from '../../src/core/types/deployment.js';
import { configMap } from '../../src/factories/kubernetes/config/config-map.js';
import {
  createTestNamespace,
  deleteGeneratedCrdAndWait,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  type TestNamespaceLease,
} from './shared-kubeconfig.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;
const runToken = Math.random().toString(36).slice(2, 8);
const namespace = `typekro-status-projection-${runToken}`;
const group = `status-projection-${runToken}.typekro.dev`;
const kind = 'TopLevelStatusProjection';
const instanceName = `hydration-proof-${runToken}`;

setDefaultTimeout(300_000);

describeOrSkip('KRO top-level resource status projection', () => {
  let kubeConfig: k8s.KubeConfig;
  let namespaceLease: TestNamespaceLease | undefined;
  let factory: KroResourceFactory<{ name: string }, { version: string }> | undefined;
  let deploymentAttempted = false;

  beforeAll(async () => {
    kubeConfig = getIntegrationTestKubeConfig();
    namespaceLease = await createTestNamespace(namespace, kubeConfig);

    const graph = kubernetesComposition(
      {
        name: `top-level-status-projection-${runToken}`,
        apiVersion: `${group}/v1alpha1`,
        kind,
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ version: 'string' }),
      },
      () => {
        configMap({
          id: 'installationContract',
          metadata: { name: 'installation-contract', namespace },
          data: { version: '1.2.3' },
        });
        return { version: Cel.expr<string>('installationContract.data.version') };
      }
    );

    factory = graph.factory('kro', {
      namespace,
      kubeConfig,
      timeout: 180_000,
      waitForReady: true,
    });
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    const errors: unknown[] = [];

    if (factory && deploymentAttempted) {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        instanceName,
        [],
        kubeConfig,
        120_000
      ).catch((error) => errors.push(error));
    }

    await deleteGeneratedCrdAndWait(
      {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: `toplevelstatusprojections.${group}` },
      },
      `${group}/v1alpha1`,
      kind,
      kubeConfig
    ).catch((error) => errors.push(error));

    if (namespaceLease) {
      await deleteTestNamespaceAndWait(namespaceLease, kubeConfig).catch((error) =>
        errors.push(error)
      );
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'KRO top-level status projection cleanup failed');
    }
  });

  it('hydrates a ConfigMap data projection into the deployed instance status', async () => {
    if (!factory) throw new Error('KRO status projection factory was not initialized');
    deploymentAttempted = true;

    const deployed = await factory.deploy({ name: instanceName });

    expect(deployed.status.version).toBe('1.2.3');
    expect(deployed.status.version).not.toEqual({
      expression: 'installationContract.data.version',
    });
  });
});
