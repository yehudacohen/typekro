# Kubernetes Events API Server-Side Filtering Strategy

## Overview

This document outlines the server-side filtering strategy for Kubernetes Events API to minimize network traffic and improve performance when monitoring deployment-related events.

## Available Server-Side Filtering Options

### 1. Field Selectors

The Kubernetes Events API supports field selectors for the following fields:

```typescript
interface EventFieldSelectors {
  // Object that the event is about
  'involvedObject.name': string;
  'involvedObject.namespace': string;
  'involvedObject.kind': string;
  'involvedObject.uid': string;
  'involvedObject.apiVersion': string;
  'involvedObject.resourceVersion': string;
  'involvedObject.fieldPath': string;
  
  // Event metadata
  'metadata.name': string;
  'metadata.namespace': string;
  
  // Event details
  'reason': string;
  'source.component': string;
  'source.host': string;
  'type': 'Normal' | 'Warning' | 'Error';
  
  // Timing
  'firstTimestamp': string; // RFC3339 format
  'lastTimestamp': string;  // RFC3339 format
}
```

### 2. Resource Version for Time-Based Filtering

```typescript
interface WatchOptions {
  // Start watching from a specific resource version (time-based filtering)
  resourceVersion?: string;
  
  // Only return events newer than this resource version
  resourceVersionMatch?: 'NotOlderThan' | 'Exact';
  
  // Timeout for the watch request
  timeoutSeconds?: number;
}
```

### 3. Namespace Scoping

Events are automatically scoped to the namespace specified in the API call:
- `/api/v1/namespaces/{namespace}/events` - namespace-scoped events
- `/api/v1/events` - cluster-wide events (requires cluster-level permissions)

## Field Selector Strategy

### Basic Resource Filtering

For each deployed resource, we'll create field selectors to get only relevant events:

```typescript
// Example: Filter events for a specific Deployment
const fieldSelector = [
  'involvedObject.kind=Deployment',
  'involvedObject.name=my-webapp',
  'involvedObject.namespace=production'
].join(',');
```

### Multi-Resource Filtering

For deployments with multiple resources, we can use OR logic with field selectors:

```typescript
// Example: Filter events for multiple resources
const resources = [
  { kind: 'Deployment', name: 'webapp' },
  { kind: 'Service', name: 'webapp-service' },
  { kind: 'ConfigMap', name: 'webapp-config' }
];

// Create separate watch connections for each resource type to optimize filtering
const deploymentSelector = 'involvedObject.kind=Deployment,involvedObject.name=webapp';
const serviceSelector = 'involvedObject.kind=Service,involvedObject.name=webapp-service';
const configMapSelector = 'involvedObject.kind=ConfigMap,involvedObject.name=webapp-config';
```

### Child Resource Discovery Strategy

For resources that create child resources (e.g., Deployment → ReplicaSet → Pod), we'll use a two-phase approach:

1. **Phase 1**: Watch events for parent resources with known names
2. **Phase 2**: Discover child resources via owner references and add them to monitoring

```typescript
// Phase 1: Watch parent resource
const parentSelector = 'involvedObject.kind=Deployment,involvedObject.name=webapp';

// Phase 2: After discovering ReplicaSet created by Deployment
const childSelector = 'involvedObject.kind=ReplicaSet,involvedObject.name=webapp-abc123';
```

## Watch Connection Pooling Strategy

### Per-Namespace Connection Pooling

To minimize API connections while maximizing filtering efficiency:

```typescript
interface NamespaceWatchPool {
  namespace: string;
  connections: Map<string, WatchConnection>; // key: resource kind
  resources: Map<string, ResourceIdentifier[]>; // key: resource kind, value: resources of that kind
}

// Example: Pool connections by resource kind within namespace
const watchPools = new Map<string, NamespaceWatchPool>();

// For namespace 'production':
// - One watch for all Deployments: 'involvedObject.kind=Deployment'
// - One watch for all Services: 'involvedObject.kind=Service'  
// - One watch for all ConfigMaps: 'involvedObject.kind=ConfigMap'
```

### Dynamic Field Selector Updates

When new resources are discovered, update existing watch connections:

```typescript
// Initial: Watch for specific Deployment
let currentSelector = 'involvedObject.kind=Deployment,involvedObject.name=webapp';

// After discovering ReplicaSet: Update to include both
const updatedSelector = [
  'involvedObject.kind=Deployment,involvedObject.name=webapp',
  'involvedObject.kind=ReplicaSet,involvedObject.name=webapp-abc123'
].join(' OR '); // Note: Kubernetes doesn't support OR in field selectors

// Solution: Use separate watch connections for different resource types
```

## Resource Version Management

### Time-Based Filtering Implementation

```typescript
interface DeploymentEventMonitoring {
  deploymentStartTime: Date;
  resourceVersion: string; // Resource version at deployment start
  
  // Convert deployment start time to resource version for filtering
  getResourceVersionForTime(time: Date): Promise<string>;
}

// Implementation
async function getResourceVersionForDeploymentStart(
  k8sApi: k8s.CoreV1Api,
  namespace: string,
  deploymentStartTime: Date
): Promise<string> {
  // Get a recent event to establish current resource version
  const eventList = await k8sApi.listNamespacedEvent(
    namespace,
    undefined, // pretty
    undefined, // allowWatchBookmarks
    undefined, // continue
    undefined, // fieldSelector
    undefined, // labelSelector
    1 // limit to 1 event
  );
  
  // Use the resource version from the list metadata
  return eventList.body.metadata?.resourceVersion || '0';
}
```

## Field Selector Examples for Common Scenarios

### Single Resource Deployment

```typescript
// Deployment of a single webapp
const fieldSelectors = {
  deployment: 'involvedObject.kind=Deployment,involvedObject.name=webapp,involvedObject.namespace=production',
  service: 'involvedObject.kind=Service,involvedObject.name=webapp-service,involvedObject.namespace=production'
};
```

### Multi-Component Application

```typescript
// Complex application with multiple components
const appComponents = [
  { kind: 'Deployment', name: 'webapp' },
  { kind: 'Deployment', name: 'api' },
  { kind: 'Deployment', name: 'worker' },
  { kind: 'Service', name: 'webapp-service' },
  { kind: 'Service', name: 'api-service' },
  { kind: 'ConfigMap', name: 'app-config' },
  { kind: 'Secret', name: 'app-secrets' }
];

// Group by kind for efficient watching
const selectorsByKind = {
  Deployment: 'involvedObject.kind=Deployment', // Will be refined per deployment
  Service: 'involvedObject.kind=Service',
  ConfigMap: 'involvedObject.kind=ConfigMap',
  Secret: 'involvedObject.kind=Secret'
};
```

### Child Resource Monitoring

```typescript
// After discovering child resources
const childResourceSelectors = {
  // Parent resources (known at deployment time)
  deployment: 'involvedObject.kind=Deployment,involvedObject.name=webapp',
  
  // Child resources (discovered during deployment)
  replicaSet: 'involvedObject.kind=ReplicaSet,involvedObject.name=webapp-abc123',
  pods: 'involvedObject.kind=Pod', // Will need name-based filtering for specific pods
};
```

## Performance Benefits and Network Traffic Reduction

### Expected Performance Improvements

1. **Network Traffic Reduction**: 80-95% reduction in event data transfer
   - Without filtering: All cluster events (potentially thousands per minute)
   - With filtering: Only deployment-related events (typically 10-50 per deployment)

2. **CPU Usage Reduction**: 70-90% reduction in client-side processing
   - Server-side filtering eliminates need for client-side event relevance checking
   - Reduced JSON parsing and object creation

3. **Memory Usage Reduction**: 60-80% reduction in memory consumption
   - Fewer event objects stored in memory
   - Reduced garbage collection pressure

### Benchmarking Strategy

```typescript
interface PerformanceMetrics {
  // Network metrics
  totalBytesReceived: number;
  eventsReceived: number;
  eventsFiltered: number; // Client-side filtering after server-side
  
  // Processing metrics
  cpuTimeSpent: number;
  memoryUsage: number;
  
  // API metrics
  watchConnections: number;
  apiCallsPerSecond: number;
}

// Comparison: No filtering vs Server-side filtering vs Server+Client filtering
const benchmarkResults = {
  noFiltering: PerformanceMetrics,
  serverSideOnly: PerformanceMetrics,
  serverAndClientSide: PerformanceMetrics
};
```

## Implementation Phases

### Phase 1: Basic Field Selector Implementation
- Implement field selector generation for known resources
- Add single watch connection per resource
- Basic resource version management

### Phase 2: Connection Pooling Optimization
- Implement per-namespace watch connection pooling
- Group resources by kind for efficient watching
- Dynamic field selector updates

### Phase 3: Advanced Child Resource Discovery
- Implement owner reference tracking
- Add dynamic watch connection management for discovered resources
- Optimize field selectors for child resource patterns

### Phase 4: Performance Optimization
- Implement advanced resource version management
- Add connection reuse and caching
- Performance monitoring and metrics collection

## Error Handling and Fallbacks

### Watch Connection Failures
- Exponential backoff retry for watch connection failures
- Fallback to periodic polling if watch connections consistently fail
- Graceful degradation with reduced filtering efficiency

### Field Selector Limitations
- Handle cases where field selectors become too complex
- Fallback to broader filtering with increased client-side processing
- Monitor and alert on field selector performance issues

### Permission Issues
- Detect insufficient RBAC permissions for event watching
- Provide clear error messages and required permission documentation
- Allow deployment to continue without event monitoring if permissions are insufficient