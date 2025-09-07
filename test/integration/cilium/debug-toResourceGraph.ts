/**
 * Debug test using toResourceGraph instead of kubernetesComposition
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { toResourceGraph } from '../../../src/index.js';
import { helmRepository } from '../../../src/factories/helm/index.js';
import { getIntegrationTestKubeConfig, isClusterAvailable } from '../shared-kubeconfig.js';

const NAMESPACE = 'typekro-test';
const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('Debug toResourceGraph vs kubernetesComposition', () => {
  let kubeConfig: k8s.KubeConfig;
  let testNamespace: string;

  beforeAll(async () => {
    if (!clusterAvailable) return;
    kubeConfig = getIntegrationTestKubeConfig();
    testNamespace = NAMESPACE;
  });

  it('should deploy HelmRepository using toResourceGraph', async () => {
    console.log('🚀 Testing HelmRepository with toResourceGraph...');

    const RepoSpec = type({
      name: 'string',
    });

    const RepoStatus = type({
      ready: 'boolean',
    });

    const repoGraph = toResourceGraph(
      {
        name: 'debug-repo-torg',
        apiVersion: 'platform.example.com/v1alpha1',
        kind: 'DebugRepoToRG',
        spec: RepoSpec,
        status: RepoStatus,
      },
      (schema) => ({
        repo: helmRepository({
          name: schema.spec.name,
          namespace: testNamespace,
          url: 'https://helm.cilium.io/',
          id: 'repo',
        }),
      }),
      (schema, resources) => ({
        ready: true,
      })
    );

    const directFactory = await repoGraph.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      kubeConfig: kubeConfig,
    });

    const deploymentResult = await directFactory.deploy({
      name: 'debug-torg-repo',
    });

    expect(deploymentResult).toBeDefined();
    expect(deploymentResult.metadata.name).toBe('debug-torg-repo');

    console.log('✅ toResourceGraph HelmRepository deployment successful');
  });
});