#!/usr/bin/env bun
/**
 * Cleanup script for leftover test namespaces
 * 
 * This script cleans up any test namespaces that were left behind by failed tests.
 * Run with: bun run scripts/cleanup-test-namespaces.ts
 */

import * as k8s from '@kubernetes/client-node';
import { createBunCompatibleCoreV1Api } from '../src/core/kubernetes/index.js';

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

  // Patterns for test namespaces
  const testNamespacePatterns = [
    /^typekro-e2e-basic-/,
    /^typekro-comprehensive-/,
    /^typekro-imperative-e2e-/,
    /^typekro-factory-pattern-/,
    /^typekro-tls-/,
    /^alchemy-test-/,
    /^typekro-test-/,
  ];

  try {
    const namespaces = await coreApi.listNamespace();
    
    const testNamespaces = namespaces.items
      .filter((ns) => {
        const name = ns.metadata?.name;
        if (!name) return false;
        return testNamespacePatterns.some((pattern) => pattern.test(name));
      })
      .map((ns) => ns.metadata!.name!);

    if (testNamespaces.length === 0) {
      console.log('✅ No leftover test namespaces found');
      return;
    }

    console.log(`🔍 Found ${testNamespaces.length} test namespaces to clean up:`);
    testNamespaces.forEach((ns) => console.log(`   - ${ns}`));

    // Delete all matching namespaces
    for (const ns of testNamespaces) {
      try {
        console.log(`🗑️ Deleting namespace: ${ns}`);
        await coreApi.deleteNamespace({ name: ns });
      } catch (error: any) {
        if (error.statusCode === 404) {
          console.log(`   ✅ Already deleted: ${ns}`);
        } else {
          console.warn(`   ⚠️ Failed to delete ${ns}: ${error.message}`);
        }
      }
    }

    // Wait for namespaces to be fully deleted
    console.log('⏳ Waiting for namespaces to be fully deleted...');
    const startTime = Date.now();
    const timeoutMs = 120000; // 2 minutes

    while (Date.now() - startTime < timeoutMs) {
      const remaining = await coreApi.listNamespace();
      const stillExist = remaining.items
        .filter((ns) => {
          const name = ns.metadata?.name;
          if (!name) return false;
          return testNamespacePatterns.some((pattern) => pattern.test(name));
        })
        .map((ns) => ns.metadata!.name!);

      if (stillExist.length === 0) {
        console.log('✅ All test namespaces have been deleted');
        return;
      }

      console.log(`   Still waiting for ${stillExist.length} namespaces: ${stillExist.join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    console.warn('⚠️ Timeout waiting for all namespaces to be deleted');
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    process.exit(1);
  }
}

main().catch(console.error);
