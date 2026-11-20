/**
 * Authentication runs ONCE per request on the Bun API path.
 *
 * The generated client authenticates each request itself, through the configured auth method,
 * before the transport sees it. The transport then needs the TLS material, which
 * `KubeConfig.applyToHTTPSOptions()` only returns after running the authentication providers
 * again. For an uncached provider (an exec plugin whose credential has expired, or one that never
 * sets an expiry) that ran the plugin twice per request, and only the second run was inside the
 * request deadline. These tests count provider runs per request and check that the credential on
 * the wire comes from the single run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRequestTimeoutError } from '../../../src/core/deployment/poll-timeout.js';
import {
  createBunCompatibleCoreV1Api,
  createBunCompatibleKubernetesObjectApi,
} from '../../../src/core/kubernetes/bun-api-client.js';
import { getKubernetesClientNode } from '../../../src/core/kubernetes/client-node-runtime.js';

let server: http.Server;
let serverUrl: string;
let directory: string;
/** The Authorization header of each request the server answered. */
const authorizations: Array<string | undefined> = [];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'typekro-auth-once-'));
  server = http.createServer((req, res) => {
    authorizations.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/v1') {
      // Discovery, which KubernetesObjectApi reads before the object itself.
      res.end(
        JSON.stringify({
          kind: 'APIResourceList',
          groupVersion: 'v1',
          resources: [{ name: 'namespaces', kind: 'Namespace', namespaced: false, verbs: ['get'] }],
        })
      );
      return;
    }
    res.end('{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"default"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  serverUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

function kubeConfigFor(user: Record<string, unknown>) {
  const kc = new (getKubernetesClientNode().KubeConfig)();
  kc.loadFromOptions({
    clusters: [{ name: 'test', server: serverUrl, skipTLSVerify: true }],
    users: [{ name: 'test', ...user }],
    contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
    currentContext: 'test',
  });
  return kc;
}

/**
 * A real exec credential plugin (this runtime, running a one-line script). Each run appends a line
 * to a counter file and returns a token numbered by its run, with an expiry in the past, so the
 * client's exec cache never serves it and every authentication runs the plugin.
 */
function execUser(counterFile: string) {
  writeFileSync(counterFile, '');
  const script = [
    "const fs = require('node:fs');",
    'const file = process.env.TYPEKRO_EXEC_COUNTER;',
    "fs.appendFileSync(file, 'run\\n');",
    "const runs = fs.readFileSync(file, 'utf8').trim().split('\\n').length;",
    'process.stdout.write(JSON.stringify({',
    "  apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential',",
    "  status: { token: 'exec-' + runs, expirationTimestamp: '2000-01-01T00:00:00Z' },",
    '}));',
  ].join('\n');
  return {
    exec: {
      apiVersion: 'client.authentication.k8s.io/v1',
      command: process.execPath,
      args: ['-e', script],
      env: [{ name: 'TYPEKRO_EXEC_COUNTER', value: counterFile }],
      interactiveMode: 'Never',
    },
  };
}

const execRuns = (counterFile: string) =>
  readFileSync(counterFile, 'utf8').split('\n').filter(Boolean).length;

describe('Bun API path authenticates once per request', () => {
  it('runs an uncached exec credential plugin once per request', async () => {
    authorizations.length = 0;
    const counter = join(directory, 'exec-runs');
    const api = createBunCompatibleCoreV1Api(kubeConfigFor(execUser(counter)));

    await api.readNamespace({ name: 'default' });
    expect(execRuns(counter)).toBe(1);
    await api.readNamespace({ name: 'default' });
    expect(execRuns(counter)).toBe(2);

    expect(authorizations).toEqual(['Bearer exec-1', 'Bearer exec-2']);
  });

  it('sends the credential of the single run when the provider refreshes between calls', async () => {
    authorizations.length = 0;
    const kc = kubeConfigFor({});
    let generation = 0;
    kc.addAuthenticator({
      isAuthProvider: (user) => user?.name === 'test',
      applyAuthentication: async (_user, options) => {
        generation += 1;
        options.headers = { ...options.headers, Authorization: `Bearer generation-${generation}` };
      },
    });

    for (const api of [createBunCompatibleCoreV1Api(kc), createBunCompatibleCoreV1Api(kc)]) {
      await api.readNamespace({ name: 'default' });
    }
    await createBunCompatibleKubernetesObjectApi(kc).read({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'default' },
    });

    // Two typed reads, then the object API's discovery request and its read: four requests, four
    // provider runs, and each request carries its own run's token.
    expect(generation).toBe(4);
    expect(authorizations).toEqual([
      'Bearer generation-1',
      'Bearer generation-2',
      'Bearer generation-3',
      'Bearer generation-4',
    ]);
  });

  // The client runs the auth step before the transport; it must be inside the request deadline.
  it('times out a stalled authentication provider within the request budget', async () => {
    authorizations.length = 0;
    const kc = kubeConfigFor({});
    kc.addAuthenticator({
      isAuthProvider: (user) => user?.name === 'test',
      applyAuthentication: () => new Promise<void>(() => undefined),
    });

    const startedAt = Date.now();
    const failure = await createBunCompatibleCoreV1Api(kc, { default: 100 })
      .readNamespace({ name: 'default' })
      .then(
        () => new Error('request unexpectedly succeeded'),
        (error: unknown) => error
      );

    expect(isRequestTimeoutError(failure)).toBe(true);
    expect((failure as Error).message).toContain('kubeconfig credentials');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(authorizations).toHaveLength(0);
  });
});
