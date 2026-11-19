// Node.js runtime check for the Kubernetes transport: under Node, TypeKro's API clients and watches
// are @kubernetes/client-node's own (undici since 2.0). Against a local HTTPS server that requires
// a client certificate from a private CA generated for this run, check that an API call and a watch
// both authenticate with the kubeconfig's client certificate, and that a wrong CA is refused.
// Needs `bun run build:lib` first and the `openssl` CLI. No cluster.
import { KubeConfig } from '@kubernetes/client-node';

import { createBunCompatibleCoreV1Api } from '../dist/core/kubernetes/bun-api-client.js';
import { createWatchForRuntime } from '../dist/core/kubernetes/bun-watch.js';
import { startMtlsTestServer } from './lib/mtls-test-server.mjs';
import { createTestPki, testKubeconfig } from './lib/test-pki.mjs';

const CLIENT_CN = 'typekro-node-client';
const pki = createTestPki({ clientCommonName: CLIENT_CN });
const otherPki = createTestPki();
const server = await startMtlsTestServer(pki);

function kubeConfig(caCert) {
  const kc = new KubeConfig();
  kc.loadFromString(
    testKubeconfig({
      server: server.url,
      caCert,
      clientCert: pki.clientCert,
      clientKey: pki.clientKey,
    })
  );
  return kc;
}

function check(condition, message) {
  if (!condition) throw new Error(`Node Kubernetes TLS check failed: ${message}`);
}

try {
  const namespace = await createBunCompatibleCoreV1Api(kubeConfig(pki.caCert)).readNamespace({
    name: 'default',
  });
  check(namespace.metadata?.name === 'default', `unexpected namespace ${JSON.stringify(namespace)}`);
  check(
    server.seen.at(-1)?.clientCn === CLIENT_CN,
    `API call did not present the client certificate: ${JSON.stringify(server.seen)}`
  );

  const events = [];
  await new Promise((resolve, reject) => {
    createWatchForRuntime(kubeConfig(pki.caCert))
      .watch(
        '/api/v1/namespaces/default/events',
        { timeoutSeconds: 5 },
        (phase) => events.push(phase),
        () => resolve()
      )
      .catch(reject);
  });
  check(events.join(',') === 'ADDED', `watch received ${JSON.stringify(events)}`);
  check(
    server.seen.at(-1)?.path === '/api/v1/namespaces/default/events' &&
      server.seen.at(-1)?.clientCn === CLIENT_CN,
    `watch did not present the client certificate: ${JSON.stringify(server.seen)}`
  );

  const answered = server.seen.length;
  const wrongCa = await createBunCompatibleCoreV1Api(kubeConfig(otherPki.caCert))
    .readNamespace({ name: 'default' })
    .then(
      () => undefined,
      (error) => error
    );
  check(wrongCa instanceof Error, 'an API call trusting the wrong CA succeeded');
  check(server.seen.length === answered, 'the server answered a client that should have failed');

  console.log(`Node Kubernetes TLS check passed on ${process.version}.`);
} finally {
  await server.close();
}
