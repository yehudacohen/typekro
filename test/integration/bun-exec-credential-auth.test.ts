/**
 * Exec credential authentication against a real API server, through the Bun transport.
 *
 * Creates a ServiceAccount in a throwaway namespace and issues it a token. The test kubeconfig
 * authenticates ONLY through an exec credential plugin that prints that token, with an expiry in
 * the past so the client never caches it, and verifies the server with the cluster's own CA (no
 * skipTLSVerify). Checks that the server sees the ServiceAccount, that the plugin runs once per
 * request, and that the ServiceAccount's RBAC applies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as k8s from '@kubernetes/client-node';
import {
  createBunCompatibleApiClient,
  createBunCompatibleCoreV1Api,
} from '../../src/core/kubernetes/bun-api-client.js';
import { isClusterAvailable } from './shared-kubeconfig';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('Bun transport with exec credentials against a real API server', () => {
  const namespace = `typekro-exec-auth-${crypto.randomUUID().slice(0, 8)}`;
  const serviceAccount = 'exec-auth';
  let admin: k8s.KubeConfig;
  let directory: string;
  let counterFile: string;
  let execConfig: k8s.KubeConfig;

  beforeAll(async () => {
    admin = new k8s.KubeConfig();
    admin.loadFromDefault();
    const core = createBunCompatibleCoreV1Api(admin);
    const rbac = createBunCompatibleApiClient(admin, k8s.RbacAuthorizationV1Api);
    await core.createNamespace({ body: { metadata: { name: namespace } } });
    await core.createNamespacedServiceAccount({
      namespace,
      body: { metadata: { name: serviceAccount } },
    });
    await rbac.createNamespacedRoleBinding({
      namespace,
      body: {
        metadata: { name: 'exec-auth-view' },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' },
        subjects: [{ kind: 'ServiceAccount', name: serviceAccount, namespace }],
      },
    });
    const tokenRequest = await core.createNamespacedServiceAccountToken({
      name: serviceAccount,
      namespace,
      body: { spec: { audiences: [], expirationSeconds: 600 } },
    });
    const token = tokenRequest.status?.token;
    if (!token) throw new Error('TokenRequest returned no token');

    directory = mkdtempSync(join(tmpdir(), 'typekro-exec-auth-'));
    counterFile = join(directory, 'runs');
    writeFileSync(counterFile, '');
    writeFileSync(join(directory, 'token'), token);
    const script = [
      "const fs = require('node:fs');",
      'const dir = process.env.TYPEKRO_EXEC_DIR;',
      "fs.appendFileSync(dir + '/runs', 'run\\n');",
      'process.stdout.write(JSON.stringify({',
      "  apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential',",
      "  status: { token: fs.readFileSync(dir + '/token', 'utf8'),",
      "    expirationTimestamp: '2000-01-01T00:00:00Z' },",
      '}));',
    ].join('\n');

    const cluster = admin.getCurrentCluster();
    if (!cluster) throw new Error('No current cluster');
    execConfig = new k8s.KubeConfig();
    execConfig.loadFromOptions({
      clusters: [{ ...cluster, skipTLSVerify: false }],
      users: [
        {
          name: 'exec-user',
          exec: {
            apiVersion: 'client.authentication.k8s.io/v1',
            command: process.execPath,
            args: ['-e', script],
            env: [{ name: 'TYPEKRO_EXEC_DIR', value: directory }],
            interactiveMode: 'Never',
          },
        },
      ],
      contexts: [{ name: 'exec', cluster: cluster.name, user: 'exec-user' }],
      currentContext: 'exec',
    });
  });

  afterAll(async () => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    await createBunCompatibleCoreV1Api(admin)
      .deleteNamespace({ name: namespace })
      .catch(() => undefined);
  });

  const execRuns = () => readFileSync(counterFile, 'utf8').split('\n').filter(Boolean).length;

  it('authenticates as the ServiceAccount, running the plugin once per request', async () => {
    const auth = createBunCompatibleApiClient(execConfig, k8s.AuthenticationV1Api);
    const core = createBunCompatibleCoreV1Api(execConfig);

    const review = await auth.createSelfSubjectReview({ body: {} });
    expect(review.status?.userInfo?.username).toBe(
      `system:serviceaccount:${namespace}:${serviceAccount}`
    );
    expect(execRuns()).toBe(1);

    const configMaps = await core.listNamespacedConfigMap({ namespace });
    expect(Array.isArray(configMaps.items)).toBe(true);
    expect(execRuns()).toBe(2);
  });

  it("applies the ServiceAccount's RBAC", async () => {
    const failure = await createBunCompatibleCoreV1Api(execConfig)
      .listNamespacedSecret({ namespace: 'kube-system' })
      .then(
        () => new Error('listing kube-system secrets unexpectedly succeeded'),
        (error: unknown) => error
      );
    expect((failure as { code?: number }).code).toBe(403);
  });
});
