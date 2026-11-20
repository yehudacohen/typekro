/**
 * The Bun transport against a real TLS server.
 *
 * The server uses a private CA generated for this run and REQUIRES a client certificate signed by
 * it. The kubeconfig carries the CA and the client certificate and key as inline data, the way a
 * kind or kubeadm kubeconfig does. Both the API client and the watch read that material from the
 * KubeConfig (since @kubernetes/client-node 2.0 it is no longer on an https.Agent), so this checks
 * the whole chain end to end without a cluster.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createTestPki, type TestPki, testKubeconfig } from '../../scripts/lib/test-pki.mjs';
import { createBunCompatibleCoreV1Api } from '../../src/core/kubernetes/bun-api-client.js';
import { BunCompatibleWatch } from '../../src/core/kubernetes/bun-watch.js';
import { getKubernetesClientNode } from '../../src/core/kubernetes/client-node-runtime.js';

const CLIENT_CN = 'typekro-mtls-client';

let pki: TestPki;
let otherPki: TestPki;
let server: ChildProcessWithoutNullStreams;
let serverUrl: string;
/** The client certificate CN the server saw on each request it answered. */
const seen: Array<{ path: string; clientCn: string | undefined }> = [];

function kubeConfig(options: { caCert: string; withClientCert: boolean }) {
  const kc = new (getKubernetesClientNode().KubeConfig)();
  kc.loadFromString(
    testKubeconfig({
      server: serverUrl,
      caCert: options.caCert,
      ...(options.withClientCert ? { clientCert: pki.clientCert, clientKey: pki.clientKey } : {}),
    })
  );
  return kc;
}

// The server runs under Node, so the server side of every handshake is Node's own TLS stack and
// the client certificate check is OpenSSL's, independent of the Bun client under test.
beforeAll(async () => {
  pki = createTestPki({ clientCommonName: CLIENT_CN });
  otherPki = createTestPki();
  server = spawn('node', [
    new URL('../../scripts/lib/mtls-test-server.mjs', import.meta.url).pathname,
  ]);
  server.stderr.pipe(process.stderr);
  server.stdin.write(`${JSON.stringify(pki)}\n`);
  const lines = createInterface({ input: server.stdout });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`mTLS test server exited (${code})`)));
    lines.on('line', (line) => {
      const message = JSON.parse(line) as { port?: number; path?: string; clientCn?: string };
      if (message.port !== undefined) resolve(message.port);
      else seen.push({ path: message.path ?? '', clientCn: message.clientCn });
    });
  });
  serverUrl = `https://127.0.0.1:${port}`;
});

afterAll(async () => {
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.stdin.end();
  await exited;
});

/** Waits for the server to report the requests it answered, which arrive on its stdout. */
async function seenAfter(expected: number) {
  for (let attempt = 0; attempt < 50 && seen.length < expected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return seen;
}

function watchOnce(watch: BunCompatibleWatch) {
  const events: Array<{ phase: string; object: unknown }> = [];
  return new Promise<{ events: typeof events; error: unknown }>((resolve, reject) => {
    watch
      .watch(
        '/api/v1/namespaces/default/events',
        { timeoutSeconds: 5 },
        (phase, object) => events.push({ phase, object }),
        (error) => resolve({ events, error })
      )
      .catch(reject);
  });
}

describe('Bun transport over mutual TLS', () => {
  it('makes an API call with the kubeconfig client certificate', async () => {
    seen.length = 0;
    const api = createBunCompatibleCoreV1Api(
      kubeConfig({ caCert: pki.caCert, withClientCert: true })
    );

    const namespace = await api.readNamespace({ name: 'default' });

    expect(namespace.metadata?.name).toBe('default');
    expect(await seenAfter(1)).toEqual([
      { path: '/api/v1/namespaces/default', clientCn: CLIENT_CN },
    ]);
  });

  it('streams a watch over the same transport', async () => {
    seen.length = 0;
    const watch = new BunCompatibleWatch(kubeConfig({ caCert: pki.caCert, withClientCert: true }));

    const { events, error } = await watchOnce(watch);

    expect(events).toHaveLength(1);
    expect(events[0]?.phase).toBe('ADDED');
    expect((error as Error).name).toBe('TimeoutError'); // the server ended the stream
    expect(await seenAfter(1)).toEqual([
      { path: '/api/v1/namespaces/default/events', clientCn: CLIENT_CN },
    ]);
  });

  it('rejects a server certificate the kubeconfig CA did not sign', async () => {
    seen.length = 0;
    const config = kubeConfig({ caCert: otherPki.caCert, withClientCert: true });

    const apiFailure = await createBunCompatibleCoreV1Api(config)
      .readNamespace({ name: 'default' })
      .then(
        () => new Error('API call unexpectedly succeeded'),
        (error: unknown) => error
      );
    const { events, error: watchFailure } = await watchOnce(new BunCompatibleWatch(config));

    for (const failure of [apiFailure, watchFailure]) {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain('unexpectedly succeeded');
      expect(`${(failure as { code?: string }).code} ${(failure as Error).message}`).toMatch(
        /CERT|certificate|SELF_SIGNED|verify/i
      );
    }
    expect(events).toHaveLength(0);
    expect(await seenAfter(1)).toHaveLength(0);
  });

  // Shows the server really requires the client certificate, so the passing cases above prove the
  // transport sent it.
  it('is refused by the server without a client certificate', async () => {
    seen.length = 0;
    const failure = await createBunCompatibleCoreV1Api(
      kubeConfig({ caCert: pki.caCert, withClientCert: false })
    )
      .readNamespace({ name: 'default' })
      .then(
        () => new Error('API call unexpectedly succeeded'),
        (error: unknown) => error
      );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('unexpectedly succeeded');
    expect(await seenAfter(1)).toHaveLength(0);
  });
});
