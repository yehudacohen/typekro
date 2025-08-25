# Performance Optimization

TypeKro is designed for performance, but understanding optimization techniques helps you build efficient infrastructure-as-code pipelines. This guide covers performance best practices for development, CI/CD, and production deployments.

## Performance Overview

TypeKro performance considerations span several areas:

- **Build-time performance** - TypeScript compilation and YAML generation
- **Deployment performance** - Resource creation and status checking
- **Runtime performance** - Status hydration and CEL evaluation  
- **Memory usage** - Large resource graphs and complex schemas
- **Network performance** - Kubernetes API interactions

## Build-Time Optimization

### TypeScript Compilation

```typescript
// tsconfig.json optimization
{
  "compilerOptions": {
    "target": "ES2022",           // Modern target for better performance
    "module": "ESNext",           // Efficient module system
    "moduleResolution": "bundler", // Faster resolution
    "incremental": true,          // Enable incremental compilation
    "tsBuildInfoFile": ".tsbuildinfo",
    
    // Skip type checking for dependencies
    "skipLibCheck": true,
    "skipDefaultLibCheck": true,
    
    // Optimize for speed
    "assumeChangesOnlyAffectDirectDependencies": true,
    
    // Reduce work
    "noUnusedLocals": false,      // Skip during development
    "noUnusedParameters": false
  },
  
  // Exclude unnecessary files
  "exclude": [
    "node_modules",
    "dist",
    "**/*.test.ts",
    "**/*.spec.ts"
  ]
}
```

### Efficient Resource Graph Patterns

```typescript
// ✅ Efficient: Lazy resource creation
const efficientGraph = toResourceGraph(
  { name: 'efficient-app', schema: { spec: AppSpec } },
  (schema) => {
    // Only create resources that are needed
    const resources: Record<string, any> = {
      app: simple.Deployment({
        name: schema.spec.name,
        image: schema.spec.image,
        replicas: schema.spec.replicas
      })
    };

    // Conditional resource creation
    if (schema.spec.needsDatabase) {
      resources.database = simple.Deployment({
        name: Cel.expr(schema.spec.name, "-db"),
        image: 'postgres:15'
      });
    }

    if (schema.spec.environment === 'production') {
      resources.monitoring = createMonitoringStack(schema.spec.name);
    }

    return resources;
  },
  statusBuilder
);

// ❌ Inefficient: Always create all resources
const inefficientGraph = toResourceGraph(
  { name: 'inefficient-app', schema: { spec: AppSpec } },
  (schema) => ({
    app: simple.Deployment({ /* ... */ }),
    database: simple.Deployment({ /* ... */ }),      // Always created
    monitoring: createMonitoringStack(),           // Always created
    cache: simple.Deployment({ /* ... */ }),        // Always created
    logging: createLoggingStack()                  // Always created
  }),
  statusBuilder
);
```

### Resource Graph Composition

```typescript
// ✅ Efficient: Compose smaller graphs
const coreAppGraph = toResourceGraph(
  { name: 'core-app', schema: { spec: CoreAppSpec } },
  (schema) => ({
    app: simple.Deployment({
      name: schema.spec.name,
      image: schema.spec.image
    }),
    service: simple.Service({
      name: Cel.expr(schema.spec.name, "-service"),
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: 3000 }]
    })
  }),
  statusBuilder
);

const databaseGraph = toResourceGraph(
  { name: 'database', schema: { spec: DatabaseSpec } },
  (schema) => ({
    database: simple.Deployment({
      name: schema.spec.name,
      image: 'postgres:15'
    }),
    service: simple.Service({
      name: Cel.expr(schema.spec.name, "-service"),
      selector: { app: schema.spec.name },
      ports: [{ port: 5432, targetPort: 5432 }]
    })
  }),
  statusBuilder
);

// Combine when needed
function createFullStack(appSpec: AppSpec, dbSpec?: DatabaseSpec) {
  const graphs = [coreAppGraph];
  
  if (dbSpec) {
    graphs.push(databaseGraph);
  }
  
  return graphs;
}
```

### Caching Strategies

```typescript
// Cache validated schemas
const schemaCache = new Map<string, any>();

function getCachedSchema<T>(
  cacheKey: string,
  input: unknown,
  validator: Type<T>
): T {
  if (schemaCache.has(cacheKey)) {
    return schemaCache.get(cacheKey);
  }
  
  const result = validator(input);
  if (result instanceof type.errors) {
    throw new ValidationError('Invalid schema', result);
  }
  
  schemaCache.set(cacheKey, result);
  return result;
}

// Cache resource creation
const resourceCache = new Map<string, Enhanced<any, any>>();

function getCachedResource<T>(
  cacheKey: string,
  factory: () => T
): T {
  if (resourceCache.has(cacheKey)) {
    return resourceCache.get(cacheKey);
  }
  
  const resource = factory();
  resourceCache.set(cacheKey, resource);
  return resource;
}

// Usage in resource graphs
const cachedGraph = toResourceGraph(
  definition,
  (schema) => {
    const cacheKey = JSON.stringify(schema.spec);
    
    return getCachedResource(cacheKey, () => ({
      app: simple.Deployment({
        name: schema.spec.name,
        image: schema.spec.image
      })
    }));
  },
  statusBuilder
);
```

## Deployment Performance

### Parallel Deployment

```typescript
// ✅ Deploy independent resources in parallel
async function parallelDeploy() {
  const factory = graph.factory('direct', {
    parallelDeployment: true,
    maxConcurrency: 5
  });
  
  // Deploy multiple apps concurrently
  const apps = ['app1', 'app2', 'app3', 'app4', 'app5'];
  
  const deployments = await Promise.all(
    apps.map(name => factory.deploy({
      name,
      image: Cel.template("%s:latest", name),
      replicas: 2
    }))
  );
  
  console.log(Cel.template("Deployed %d applications", deployments.length));
}

// ✅ Use Promise.allSettled for error resilience
async function resilientParallelDeploy() {
  const deploymentPromises = apps.map(async (app) => {
    try {
      const factory = graph.factory('direct');
      return await factory.deploy(app);
    } catch (error) {
      return { error: error.message, app: app.name };
    }
  });
  
  const results = await Promise.allSettled(deploymentPromises);
  
  const successful = results.filter(r => r.status === 'fulfilled');
  const failed = results.filter(r => r.status === 'rejected');
  
  console.log(Cel.template("✅ %d successful, ❌ %d failed", successful.length, failed.length));
}
```

### Efficient Status Checking

```typescript
// ✅ Batch status checks
async function batchStatusCheck(deployments: string[]) {
  const factory = graph.factory('direct');
  
  // Check all statuses in parallel
  const statusPromises = deployments.map(name => 
    factory.getStatus(name).catch(error => ({ name, error }))
  );
  
  const statuses = await Promise.all(statusPromises);
  
  return statuses.reduce((acc, status) => {
    if ('error' in status) {
      acc.errors.push(status);
    } else {
      acc.successful.push(status);
    }
    return acc;
  }, { successful: [], errors: [] });
}

// ✅ Use selective status updates
const optimizedFactory = graph.factory('direct', {
  statusUpdateInterval: 30000,    // Check every 30 seconds
  statusFields: ['phase', 'readyReplicas'], // Only check critical fields
  statusTimeout: 10000            // 10 second timeout per check
});
```

### Resource Batching

```typescript
// ✅ Batch Kubernetes API calls
async function batchedDeployment() {
  const resources = [];
  
  // Collect all resources first
  for (const config of appConfigs) {
    const graph = createAppGraph(config);
    resources.push(...graph.getResources());
  }
  
  // Apply all resources in batches
  const batchSize = 10;
  for (let i = 0; i < resources.length; i += batchSize) {
    const batch = resources.slice(i, i + batchSize);
    
    await Promise.all(
      batch.map(resource => kubectl.apply(resource))
    );
    
    // Small delay between batches to avoid overwhelming API server
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
```

## Runtime Performance

### Efficient CEL Expressions

```typescript
// ✅ Simple, fast CEL expressions
const efficientStatus = (schema, resources) => ({
  // Simple field access
  phase: resources.app.status.phase,
  readyReplicas: resources.app.status.readyReplicas,
  
  // Simple boolean logic
  ready: Cel.expr(resources.app.status.readyReplicas, '> 0'),
  
  // Cached template values
  url: Cel.template('http://%s', resources.service.spec.clusterIP)
});

// ❌ Complex, slow CEL expressions
const slowStatus = (schema, resources) => ({
  // Complex nested expressions
  complexHealth: Cel.expr(
    `(${resources.app.status.readyReplicas} * 100 / ${resources.app.spec.replicas}) > 80 && `,
    `${resources.database.status.readyReplicas} > 0 && `,
    `size(${resources.service.status.loadBalancer.ingress}) > 0 && `,
    `timestamp(${resources.app.metadata.creationTimestamp}) > timestamp("2024-01-01T00:00:00Z")`
  ),
  
  // Expensive string operations
  expensiveUrl: Cel.expr(
    `"https://" + `,
    `${resources.service.status.loadBalancer.ingress[0].hostname}.split(".")[0] + `,
    `".example.com/api/v1/" + `,
    `${resources.app.metadata.labels.version}`
  )
});
```

### Status Hydration Optimization

```typescript
// ✅ Selective status hydration
const selectiveStatus = {
  // Only hydrate frequently-needed fields
  critical: {
    ready: resources.app.status.readyReplicas > 0,
    phase: resources.app.status.phase
  },
  
  // Lazy-load expensive computations
  detailed: {
    get metrics() {
      return computeExpensiveMetrics(resources);
    },
    
    get performance() {
      return analyzePerformance(resources);
    }
  }
};

// ✅ Cache expensive status computations
const statusCache = new Map();

function getCachedStatus(key: string, computer: () => any, ttl = 60000) {
  const cached = statusCache.get(key);
  
  if (cached && Date.now() - cached.timestamp < ttl) {
    return cached.value;
  }
  
  const value = computer();
  statusCache.set(key, { value, timestamp: Date.now() });
  
  return value;
}

const cachedStatus = (schema, resources) => ({
  phase: resources.app.status.phase,
  
  expensiveMetrics: getCachedStatus(
    `metrics:${resources.app.metadata.name}`,
    () => computeExpensiveMetrics(resources),
    30000  // 30 second cache
  )
});
```

### Memory Management

```typescript
// ✅ Efficient memory usage patterns
class ResourceManager {
  private resourceCache = new WeakMap();
  private statusCache = new LRUCache<string, any>({ max: 1000 });
  
  createResource<T>(factory: () => T): T {
    // Use WeakMap to avoid memory leaks
    const cacheKey = factory;
    
    if (this.resourceCache.has(cacheKey)) {
      return this.resourceCache.get(cacheKey);
    }
    
    const resource = factory();
    this.resourceCache.set(cacheKey, resource);
    
    return resource;
  }
  
  getStatus(key: string, computer: () => any): any {
    if (this.statusCache.has(key)) {
      return this.statusCache.get(key);
    }
    
    const status = computer();
    this.statusCache.set(key, status);
    
    return status;
  }
  
  cleanup() {
    this.statusCache.clear();
    // WeakMap cleans itself up
  }
}

// ✅ Streaming for large datasets
async function* streamResourceGraphs(configs: AppConfig[]) {
  for (const config of configs) {
    const graph = createAppGraph(config);
    yield graph;
    
    // Allow garbage collection between yields
    await new Promise(resolve => setImmediate(resolve));
  }
}

// Usage
for await (const graph of streamResourceGraphs(largeConfigList)) {
  await deployGraph(graph);
  // Each graph can be garbage collected after deployment
}
```

## CI/CD Performance

### Build Optimization

```typescript
// package.json optimization
{
  "scripts": {
    "build": "tsc --build --incremental",
    "build:fast": "tsc --build --incremental --skipLibCheck",
    "typecheck": "tsc --noEmit --incremental",
    "generate": "bun run generate-yaml.ts",
    "deploy": "bun run build:fast && bun run generate && kubectl apply -f deploy/"
  }
}
```

### Docker Layer Optimization

```dockerfile
# Dockerfile optimization for TypeKro projects
FROM node:18-alpine as builder

# Install dependencies first (cached layer)
WORKDIR /app
COPY package*.json bun.lockb ./
RUN bun install --frozen-lockfile

# Copy source and build
COPY src/ ./src/
COPY tsconfig.json ./
RUN bun run build

# Production image
FROM node:18-alpine as runtime
WORKDIR /app

# Copy only production dependencies
COPY package*.json ./
RUN bun install --production --frozen-lockfile

# Copy built application
COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]
```

### Parallel CI Jobs

```yaml
# .github/workflows/optimized-deploy.yml
name: Optimized Deploy

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      cache-key: ${{ steps.cache.outputs.cache-hit }}
    steps:
      - uses: actions/checkout@v3
      
      - name: Cache dependencies
        id: cache
        uses: actions/cache@v3
        with:
          path: node_modules
          key: ${{ runner.os }}-deps-${{ hashFiles('**/bun.lockb') }}
          
      - name: Install dependencies
        if: steps.cache.outputs.cache-hit != 'true'
        run: bun install --frozen-lockfile
        
      - name: Build
        run: bun run build
        
      - name: Cache build
        uses: actions/cache@v3
        with:
          path: dist
          key: ${{ runner.os }}-build-${{ github.sha }}

  generate-yaml:
    needs: build
    runs-on: ubuntu-latest
    strategy:
      matrix:
        environment: [dev, staging, prod]
    steps:
      - uses: actions/checkout@v3
      
      - name: Restore build cache
        uses: actions/cache@v3
        with:
          path: dist
          key: ${{ runner.os }}-build-${{ github.sha }}
          
      - name: Generate YAML for ${{ matrix.environment }}
        run: |
          ENVIRONMENT=${{ matrix.environment }} bun run generate
          
      - name: Upload YAML
        uses: actions/upload-artifact@v3
        with:
          name: yaml-${{ matrix.environment }}
          path: deploy/instances/${{ matrix.environment }}/

  deploy:
    needs: [build, generate-yaml]
    runs-on: ubuntu-latest
    strategy:
      matrix:
        environment: [dev, staging, prod]
    steps:
      - name: Download YAML
        uses: actions/download-artifact@v3
        with:
          name: yaml-${{ matrix.environment }}
          path: deploy/
          
      - name: Deploy to ${{ matrix.environment }}
        run: |
          kubectl apply -f deploy/
```

## Monitoring and Profiling

### Performance Monitoring

```typescript
// Performance monitoring utilities
class PerformanceMonitor {
  private metrics = new Map<string, number[]>();
  
  time<T>(operation: string, fn: () => T): T {
    const start = performance.now();
    
    try {
      const result = fn();
      
      if (result instanceof Promise) {
        return result.finally(() => {
          this.recordMetric(operation, performance.now() - start);
        }) as T;
      }
      
      this.recordMetric(operation, performance.now() - start);
      return result;
    } catch (error) {
      this.recordMetric(operation, performance.now() - start);
      throw error;
    }
  }
  
  private recordMetric(operation: string, duration: number) {
    if (!this.metrics.has(operation)) {
      this.metrics.set(operation, []);
    }
    
    this.metrics.get(operation)!.push(duration);
  }
  
  getStats(operation: string) {
    const durations = this.metrics.get(operation) || [];
    if (durations.length === 0) return null;
    
    const sorted = durations.sort((a, b) => a - b);
    
    return {
      count: durations.length,
      min: Math.min(...durations),
      max: Math.max(...durations),
      avg: durations.reduce((a, b) => a + b) / durations.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)]
    };
  }
  
  report() {
    console.log('Performance Report:');
    for (const [operation, _] of this.metrics) {
      const stats = this.getStats(operation);
      console.log(`${operation}: avg=${stats?.avg.toFixed(2)}ms, p95=${stats?.p95.toFixed(2)}ms`);
    }
  }
}

// Usage
const monitor = new PerformanceMonitor();

const factory = await monitor.time('factory-creation', async () => {
  return graph.factory('direct');
});

const deployment = await monitor.time('deployment', async () => {
  return await factory.deploy(spec);
});

monitor.report();
```

### Memory Profiling

```typescript
// Memory usage monitoring
function trackMemoryUsage(operation: string) {
  const before = process.memoryUsage();
  
  return {
    end() {
      const after = process.memoryUsage();
      
      console.log(Cel.template(message, variables));
      console.log(Cel.template(message, variables));
      console.log(Cel.template(message, variables));
      console.log(Cel.template(message, variables));
    }
  };
}

// Usage
const memTracker = trackMemoryUsage('graph-creation');
const graph = createLargeResourceGraph();
memTracker.end();
```

## Performance Testing

### Load Testing

```typescript
// Load test for resource graph creation
async function loadTestGraphCreation() {
  const iterations = 1000;
  const concurrency = 10;
  
  const results = [];
  
  for (let batch = 0; batch < iterations / concurrency; batch++) {
    const batchPromises = Array.from({ length: concurrency }, async (_, i) => {
      const start = performance.now();
      
      const graph = toResourceGraph(
        { name: `test-app-${batch}-${i}`, schema: { spec: AppSpec } },
        (schema) => ({
          app: simple.Deployment({
            name: schema.spec.name,
            image: 'nginx:latest',
            replicas: 3
          })
        }),
        statusBuilder
      );
      
      const duration = performance.now() - start;
      return { batch, index: i, duration, graph };
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    // Small delay between batches
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  
  const durations = results.map(r => r.duration);
  console.log(Cel.template(message, variables));
  console.log(Cel.template(message, variables));
  console.log(Cel.template(message, variables));
  console.log(Cel.template(message, variables));
  
  return results;
}
```

### Benchmark Comparison

```typescript
// Benchmark different approaches
async function benchmarkFactories() {
  const configs = Array.from({ length: 100 }, (_, i) => ({
    name: `app-${i}`,
    image: 'nginx:latest',
    replicas: 3
  }));
  
  // Approach 1: Individual factory creation
  const start1 = performance.now();
  const graphs1 = configs.map(config => 
    toResourceGraph(
      { name: config.name, schema: { spec: AppSpec } },
      schema => ({ app: simple.Deployment(config) }),
      statusBuilder
    )
  );
  const duration1 = performance.now() - start1;
  
  // Approach 2: Cached factory
  const start2 = performance.now();
  const cachedFactory = createCachedFactory();
  const graphs2 = configs.map(config => cachedFactory.create(config));
  const duration2 = performance.now() - start2;
  
  console.log('Benchmark Results:');
  console.log(Cel.template(message, variables));
  console.log(Cel.template(message, variables));
  console.log(Cel.template(message, variables));
}
```

## Best Practices

### 1. Profile Before Optimizing

```typescript
// ✅ Measure actual performance bottlenecks
const profiler = new PerformanceMonitor();

// Profile your actual workflow
const factory = await profiler.time('factory-creation', 
  () => graph.factory('direct')
);

const deployment = await profiler.time('deployment',
  () => factory.deploy(spec)
);

// Only optimize the slowest operations
profiler.report();
```

### 2. Use Appropriate Data Structures

```typescript
// ✅ Use Map for frequent lookups
const resourceMap = new Map(resources.map(r => [r.name, r]));
const resource = resourceMap.get(name);  // O(1) lookup

// ❌ Avoid array.find for large datasets
const resource = resources.find(r => r.name === name);  // O(n) lookup
```

### 3. Minimize API Calls

```typescript
// ✅ Batch API operations
const resources = await Promise.all([
  k8s.apps.readNamespacedDeployment(name, namespace),
  k8s.core.readNamespacedService(Cel.expr(name, "-service"), namespace),
  k8s.core.readNamespacedConfigMap(Cel.expr(name, "-config"), namespace)
]);

// ❌ Sequential API calls
const deployment = await k8s.apps.readNamespacedDeployment(name, namespace);
const service = await k8s.core.readNamespacedService(Cel.expr(name, "-service"), namespace);
const configMap = await k8s.core.readNamespacedConfigMap(Cel.expr(name, "-config"), namespace);
```

### 4. Implement Circuit Breakers

```typescript
// ✅ Circuit breaker for external dependencies
class CircuitBreaker {
  private failures = 0;
  private lastFailTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  constructor(
    private threshold = 5,
    private timeout = 60000
  ) {}
  
  async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailTime > this.timeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }
    
    try {
      const result = await operation();
      this.reset();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }
  
  private recordFailure() {
    this.failures++;
    this.lastFailTime = Date.now();
    
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }
  
  private reset() {
    this.failures = 0;
    this.state = 'closed';
  }
}
```

## Troubleshooting Performance Issues

### Common Performance Problems

1. **Slow TypeScript compilation**
   - Enable incremental compilation
   - Use `skipLibCheck`
   - Optimize tsconfig.json

2. **Memory leaks in long-running processes**
   - Use WeakMap for caches
   - Implement cache eviction
   - Monitor memory usage

3. **Slow Kubernetes API calls**
   - Implement request batching
   - Use connection pooling
   - Add retry logic with backoff

4. **Complex CEL expressions**
   - Simplify expressions
   - Cache computed values
   - Use direct field access

### Performance Debugging

```bash
# Node.js performance profiling
node --prof your-script.js
node --prof-process isolate-*.log > processed.txt

# Memory heap dumps
node --inspect your-script.js
# Use Chrome DevTools to analyze heap

# Bun profiling
bun --smol your-script.js  # Optimize for memory
bun --profile your-script.js  # Profile execution
```

## Next Steps

- **[Troubleshooting](./troubleshooting.md)** - Debug performance and other issues
- **[Type Safety](./type-safety.md)** - Optimize type checking performance
- **[Examples](../examples/)** - See performance optimizations in action