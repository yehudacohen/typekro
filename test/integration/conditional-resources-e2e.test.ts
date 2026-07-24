/**
 * Conditional Resources E2E Test
 *
 * End-to-end validation that compositions using plain JavaScript control
 * flow (`if (!spec.optional) { createResource(...) }`, `if/else` with
 * factory calls in both branches) deploy correctly via the KRO controller
 * and both branches reconcile to ready when the CR is deployed with and
 * without the optional field.
 *
 * This pins the behavior of:
 *   - processCompositionBodyAnalysis differential branch capture
 *   - conditionToCel has() wrapping on optional fields
 *   - applyDifferentialFieldConditionals field-level CEL ternary emission
 *   - resource-ID-keyed matching in resolveDefaultsByReExecution
 *
 * NOTE: We deploy via the factory API (KRO mode) rather than the direct
 * mode path because the conditional-resource behavior is KRO-specific —
 * in direct mode, the JS `if` runs concretely at composition time and
 * there's no CEL involvement at all. The KRO path is where the
 * framework's JS-to-CEL conversion actually matters.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { ConfigMap, Deployment } from '../../src/factories/simple/index.js';
import {
  createCoreV1ApiClient,
  createTestNamespace,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  TestFactoryCleanupRegistry,
} from './shared-kubeconfig.js';

const BASE_NAMESPACE = 'typekro-e2e-cond';
const TEST_TIMEOUT = 900_000;

const generateNamespace = (suffix: string): string => {
  const ts = Date.now().toString().slice(-6);
  return `${BASE_NAMESPACE}-${suffix}-${ts}`;
};

const clusterAvailable = await isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('Conditional Resources E2E (if/else → includeWhen)', () => {
  let kc: k8s.KubeConfig;
  let k8sApi: k8s.CoreV1Api;

  beforeAll(async () => {
    if (!clusterAvailable) return;
    kc = getIntegrationTestKubeConfig();
    k8sApi = createCoreV1ApiClient(kc);
  });

  // =========================================================================
  // Test 1: `if (!spec.optional) { createResource(...) }`
  // =========================================================================
  //
  // The sidecar ConfigMap is created only when the user does NOT provide
  // an `externalSidecarUrl`. Deploying without the field should create
  // the sidecar; deploying with it should skip the sidecar.
  it(
    'if (!spec.optional) gates resource creation via KRO includeWhen',
    async () => {
      const factoryNs = generateNamespace('ifnot-factory');
      const appNs1 = generateNamespace('ifnot-a');
      const appNs2 = generateNamespace('ifnot-b');

      const composition = kubernetesComposition(
        {
          name: 'cond-ifnot-app',
          kind: 'CondIfNotApp',
          spec: type({
            name: 'string',
            appNamespace: 'string',
            'externalSidecarUrl?': 'string',
          }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          // Main app ConfigMap — always created.
          ConfigMap({
            name: `${spec.name}-main`,
            namespace: spec.appNamespace,
            data: { role: 'main' },
            id: 'mainCfg',
          });

          // Sidecar ConfigMap — created only when the user did NOT
          // provide an external sidecar URL. The framework detects the
          // `if` + captures the resource via differential execution
          // and emits `includeWhen: ${!has(schema.spec.externalSidecarUrl)}`.
          if (!spec.externalSidecarUrl) {
            ConfigMap({
              name: `${spec.name}-sidecar`,
              namespace: spec.appNamespace,
              data: { role: 'sidecar-auto' },
              id: 'sidecarCfg',
            });
          }

          return { ready: true };
        }
      );

      // Generated YAML must contain BOTH ConfigMaps and the sidecar
      // must carry the negated-has includeWhen directive.
      const yaml = composition.toYaml();
      expect(yaml).toContain('id: mainCfg');
      expect(yaml).toContain('id: sidecarCfg');
      expect(yaml).toContain('!has(schema.spec.externalSidecarUrl)');

      const namespaceLeases = await Promise.all(
        [factoryNs, appNs1, appNs2].map((namespace) => createTestNamespace(namespace, kc))
      );

      const factory = composition.factory('kro', {
        namespace: factoryNs,
        kubeConfig: kc,
        waitForReady: true,
        timeout: 60_000,
      });
      const cleanupRegistry = new TestFactoryCleanupRegistry();
      cleanupRegistry.track(factory, 'no-ext', namespaceLeases);
      cleanupRegistry.track(factory, 'ext');

      try {
        // Deployment A: no externalSidecarUrl → sidecar SHOULD be created.
        const instanceA = await factory.deploy({
          name: 'no-ext',
          appNamespace: appNs1,
        });
        expect(instanceA.status.ready).toBe(true);

        // Verify mainCfg + sidecarCfg both exist in appNs1.
        const mainA = await k8sApi.readNamespacedConfigMap({
          name: 'no-ext-main',
          namespace: appNs1,
        });
        expect(mainA.data?.role).toBe('main');
        const sidecarA = await k8sApi.readNamespacedConfigMap({
          name: 'no-ext-sidecar',
          namespace: appNs1,
        });
        expect(sidecarA.data?.role).toBe('sidecar-auto');

        // Deployment B: externalSidecarUrl provided → sidecar should NOT be created.
        const instanceB = await factory.deploy({
          name: 'ext',
          appNamespace: appNs2,
          externalSidecarUrl: 'http://external-sidecar.example.com',
        });
        expect(instanceB.status.ready).toBe(true);

        // Verify main exists but sidecar does NOT.
        const mainB = await k8sApi.readNamespacedConfigMap({
          name: 'ext-main',
          namespace: appNs2,
        });
        expect(mainB.data?.role).toBe('main');
        await expect(
          k8sApi.readNamespacedConfigMap({ name: 'ext-sidecar', namespace: appNs2 })
        ).rejects.toThrow();
      } finally {
        await cleanupRegistry.cleanup(kc, 120_000);
      }
    },
    TEST_TIMEOUT
  );

  // =========================================================================
  // Test 2: `if/else` with factory calls in both branches
  // =========================================================================
  //
  // `useCustomImage` selects between two Deployment resources with
  // different images. KRO should create exactly one of them per CR,
  // depending on the field's value at reconcile time.
  it(
    'if/else creates opposite-includeWhen resources for each branch',
    async () => {
      const factoryNs = generateNamespace('ifelse-factory');
      const appNs1 = generateNamespace('ifelse-a');
      const appNs2 = generateNamespace('ifelse-b');

      const composition = kubernetesComposition(
        {
          name: 'cond-ifelse-app',
          kind: 'CondIfElseApp',
          spec: type({
            name: 'string',
            appNamespace: 'string',
            'useCustomImage?': 'boolean',
          }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          if (spec.useCustomImage) {
            Deployment({
              name: `${spec.name}-custom`,
              namespace: spec.appNamespace,
              image: 'nginx:1.25-alpine',
              id: 'customDeploy',
            });
          } else {
            Deployment({
              name: `${spec.name}-stock`,
              namespace: spec.appNamespace,
              image: 'nginx:stable-alpine',
              id: 'stockDeploy',
            });
          }
          return { ready: true };
        }
      );

      // YAML must contain BOTH Deployments with opposite includeWhen.
      const yaml = composition.toYaml();
      expect(yaml).toContain('id: customDeploy');
      expect(yaml).toContain('id: stockDeploy');
      expect(yaml).toContain('has(schema.spec.useCustomImage)');

      const namespaceLeases = await Promise.all(
        [factoryNs, appNs1, appNs2].map((namespace) => createTestNamespace(namespace, kc))
      );

      const factory = composition.factory('kro', {
        namespace: factoryNs,
        kubeConfig: kc,
        waitForReady: true,
        timeout: 60_000,
      });
      const cleanupRegistry = new TestFactoryCleanupRegistry();
      cleanupRegistry.track(factory, 'app-a', namespaceLeases);
      cleanupRegistry.track(factory, 'app-b');

      try {
        // Deployment A: no useCustomImage → stock branch should run.
        const instanceA = await factory.deploy({
          name: 'app-a',
          appNamespace: appNs1,
        });
        expect(instanceA.status.ready).toBe(true);

        // Verify stock deployment exists, custom does not.
        const { createAppsV1ApiClient } = await import('./shared-kubeconfig.js');
        const appsApi = createAppsV1ApiClient(kc);
        const stockA = await appsApi.readNamespacedDeployment({
          name: 'app-a-stock',
          namespace: appNs1,
        });
        expect(stockA.spec?.template.spec?.containers?.[0]?.image).toBe('nginx:stable-alpine');
        await expect(
          appsApi.readNamespacedDeployment({ name: 'app-a-custom', namespace: appNs1 })
        ).rejects.toThrow();

        // Deployment B: useCustomImage=true → custom branch should run.
        const instanceB = await factory.deploy({
          name: 'app-b',
          appNamespace: appNs2,
          useCustomImage: true,
        });
        expect(instanceB.status.ready).toBe(true);

        const customB = await appsApi.readNamespacedDeployment({
          name: 'app-b-custom',
          namespace: appNs2,
        });
        expect(customB.spec?.template.spec?.containers?.[0]?.image).toBe('nginx:1.25-alpine');
        await expect(
          appsApi.readNamespacedDeployment({ name: 'app-b-stock', namespace: appNs2 })
        ).rejects.toThrow();
      } finally {
        await cleanupRegistry.cleanup(kc, 120_000);
      }
    },
    TEST_TIMEOUT
  );
});
