import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(900_000);
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  type TestDeletableFactory,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

// Live integration for the config-driven Caddy reverse proxy. `status.ready === true` after
// `waitForReady` is the core acceptance: the Deployment's readiness probe is a TCP check on :443, which
// only passes once Caddy is listening on https with a provisioned cert — i.e. `tls internal` minted one
// from its local CA. (A full curl-with-CA proxy proof is done manually against sela-eks.)
describe('Caddy ingress integration', () => {
  let kubeConfig: ReturnType<typeof getKubeConfig>;
  let factory: TestDeletableFactory | undefined;
  let factoryNamespaceLease: TestNamespaceLease;
  let caddyNamespaceLease: TestNamespaceLease | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  const factoryNs = `typekro-test-caddy-${suffix}`;
  const caddyNs = `caddy-e2e-${suffix}`;

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });
    [factoryNamespaceLease, caddyNamespaceLease] = await Promise.all([
      createTestNamespace(factoryNs, kubeConfig),
      createTestNamespace(caddyNs, kubeConfig),
    ]);
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    if (factory) {
      try {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          factory,
          'caddy',
          caddyNamespaceLease ? [caddyNamespaceLease] : [],
          kubeConfig,
          30_000,
          { scopes: ['cluster'] }
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await deleteTestNamespaceAndWait(factoryNamespaceLease, kubeConfig);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Caddy integration cleanup did not complete safely');
    }
  });

  it('deploys Caddy with tls internal and reports ready', async () => {
    const { makeCaddyIngress, renderCaddyfile } = await import(
      '../../../src/factories/caddy/index.js'
    );

    const caddyfile = renderCaddyfile([
      { host: 'whoami.caddy-e2e.internal', upstream: 'whoami.caddy-e2e.svc.cluster.local:80' },
    ]);

    // The live proof uses emptyDir so it does not deadlock on a
    // WaitForFirstConsumer StorageClass before the Deployment is applied.
    // PVC-backed rendering and dependency wiring are covered by unit tests.
    const deployedFactory = makeCaddyIngress({ ephemeral: true }).factory('direct', {
      namespace: factoryNs,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });
    factory = deployedFactory;

    const instance = await deployedFactory.deploy({
      name: 'caddy',
      namespace: caddyNs,
      caddyfile,
    });

    expect(instance.spec.name).toBe('caddy');
    expect(instance.spec.namespace).toBe(caddyNs);
    // ready === true only if the :443 readiness probe passed → tls internal cert provisioned + https up.
    expect(instance.status.ready).toBe(true);
    expect(instance.status.version).toBe('2.11.2');
  }, 900000);

  it('generates an RGD and supports both kro and direct modes', async () => {
    const { caddyIngress } = await import('../../../src/factories/caddy/index.js');

    const yaml = caddyIngress.toYaml();
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('schema.spec.caddyfile');

    expect(caddyIngress.factory('direct', { namespace: factoryNs, kubeConfig }).mode).toBe(
      'direct'
    );
    expect(caddyIngress.factory('kro', { namespace: factoryNs, kubeConfig }).mode).toBe('kro');
  });
});
