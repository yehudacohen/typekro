import { createRequire } from 'node:module';

import type * as KubernetesClientNode from '@kubernetes/client-node';

const require = createRequire(import.meta.url);
let cachedClientNode: typeof KubernetesClientNode | undefined;

/**
 * Load the Kubernetes SDK only when a caller actually needs cluster I/O.
 *
 * The SDK's legacy HTTP dependency emits Node's `punycode` deprecation during
 * module evaluation. Keeping it behind this boundary makes TypeKro package
 * imports quiet and avoids loading the full client for planning and YAML work.
 */
export function getKubernetesClientNode(): typeof KubernetesClientNode {
  cachedClientNode ??= require('@kubernetes/client-node') as typeof KubernetesClientNode;
  return cachedClientNode;
}
