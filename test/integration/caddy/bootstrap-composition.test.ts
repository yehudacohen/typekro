import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { ensureNamespaceExists } from '../shared-kubeconfig.js';

// Live integration for the config-driven Caddy reverse proxy. `status.ready === true` after
// `waitForReady` is the core acceptance: the Deployment's readiness probe is a TCP check on :443, which
// only passes once Caddy is listening on https with a provisioned cert — i.e. `tls internal` minted one
// from its local CA. (A full curl-with-CA proxy proof is done manually against sela-eks.)
describe('Caddy ingress integration', () => {
  let kubeConfig: ReturnType<typeof getKubeConfig>;
  const factoryNs = 'typekro-test-caddy';
  const caddyNs = 'caddy-e2e';

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });
    await ensureNamespaceExists(factoryNs, kubeConfig);
  });

  afterAll(async () => {
    try {
      const { deleteNamespaceAndWait } = await import('../shared-kubeconfig.js');
      await Promise.allSettled(
        [factoryNs, caddyNs].map((ns) => deleteNamespaceAndWait(ns, kubeConfig))
      );
    } catch (e) {
      console.error('cleanup failed:', (e as Error).message);
    }
  }, 180000); // namespace teardown can exceed bun's 5s default hook timeout

  it('deploys Caddy with tls internal and reports ready', async () => {
    const { caddyIngress, renderCaddyfile } = await import('../../../src/factories/caddy/index.js');

    const caddyfile = renderCaddyfile([
      { host: 'whoami.caddy-e2e.internal', upstream: 'whoami.caddy-e2e.svc.cluster.local:80' },
    ]);

    const factory = caddyIngress.factory('direct', {
      namespace: factoryNs,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });

    const instance = await factory.deploy({
      name: 'caddy',
      namespace: caddyNs,
      caddyfile,
    });

    expect(instance.spec.name).toBe('caddy');
    expect(instance.spec.namespace).toBe(caddyNs);
    // ready === true only if the :443 readiness probe passed → tls internal cert provisioned + https up.
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.version).toBe('2.11.2');

    await factory.deleteInstance('caddy');
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
