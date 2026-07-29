/**
 * Official OpenSearch Kubernetes operator integration for TypeKro.
 *
 * The operator bootstrap owns the cluster-scoped controller and CRDs. Cluster
 * compositions own only their declared namespace, OpenSearchCluster,
 * certificate, and network-policy resources.
 */
export * from './compositions/index.js';
export * from './resources/index.js';
export * from './types.js';
