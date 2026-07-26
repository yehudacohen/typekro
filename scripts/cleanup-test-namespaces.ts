#!/usr/bin/env bun
/** Clean up UID-leased integration namespaces left by interrupted test runs. */

import * as k8s from '@kubernetes/client-node';
import { createBunCompatibleCoreV1Api } from '../src/core/kubernetes/index.js';
import {
  deleteTestNamespaceAndWait,
  TYPEKRO_TEST_NAMESPACE_LABEL,
  type TestNamespaceLease,
} from '../test/integration/shared-kubeconfig.js';

async function main() {
  console.log('🧹 Starting cleanup of leftover test namespaces...');

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();

  // Configure to skip TLS verification for test environment
  const cluster = kc.getCurrentCluster();
  if (cluster) {
    (cluster as any).skipTLSVerify = true;
  }

  const coreApi = createBunCompatibleCoreV1Api(kc);

  const namespaces = await coreApi.listNamespace({
    labelSelector: `${TYPEKRO_TEST_NAMESPACE_LABEL}=owned`,
  });
  const leases = namespaces.items.map((namespace): TestNamespaceLease => {
    const name = namespace.metadata?.name;
    const uid = namespace.metadata?.uid;
    if (!name || !uid) {
      throw new Error('Refusing test cleanup because a labeled namespace has no name or UID');
    }
    return { name, uid };
  });

  if (leases.length === 0) {
    console.log('✅ No labeled integration namespaces found');
    return;
  }

  console.log(`🔍 Found ${leases.length} labeled integration namespace(s):`);
  leases.forEach(({ name, uid }) => console.log(`   - ${name} (${uid})`));

  const cleanupResults = await Promise.allSettled(
    leases.map((lease) => deleteTestNamespaceAndWait(lease, kc))
  );
  const failures = cleanupResults.flatMap((result, index) =>
    result.status === 'rejected'
      ? [{ namespace: leases[index]?.name ?? 'unknown', error: result.reason }]
      : []
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `Failed to clean ${failures.length} labeled integration namespace(s): ${failures
        .map(({ namespace }) => namespace)
        .join(', ')}`
    );
  }

  console.log('✅ All labeled integration namespaces were deleted');
}

await main();
