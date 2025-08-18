# Examples

Explore real-world TypeKro applications and patterns. Each example includes complete, runnable code and explanations of key concepts.

## Basic Examples

Perfect for getting started with TypeKro fundamentals.

### [Simple Web App](./simple-webapp.md)
A basic web application with service exposure. Great for understanding the core TypeKro concepts.

**What you'll learn:**
- Basic resource graph creation
- Factory functions usage
- Direct deployment

```typescript
const app = toResourceGraph('webapp', (schema) => ({
  deployment: simpleDeployment({
    name: schema.spec.name,
    image: schema.spec.image,
    ports: [{ containerPort: 3000 }]
  }),
  service: simpleService({
    name: `${schema.spec.name}-service`,
    selector: { app: schema.spec.name },
    ports: [{ port: 80, targetPort: 3000 }]
  })
}));
```

### [Database Integration](./database.md)
Web application with PostgreSQL database, demonstrating cross-resource references.

**What you'll learn:**
- Cross-resource references
- Environment configuration
- Service discovery patterns

```typescript
const stack = toResourceGraph('webapp-db', (schema) => ({
  database: simpleDeployment({
    name: `${schema.spec.name}-db`,
    image: 'postgres:15'
  }),
  app: simpleDeployment({
    name: schema.spec.name,
    env: {
      DATABASE_HOST: database.status.podIP  // Cross-resource reference
    }
  })
}));
```

### [Microservices](./microservices.md)
Multi-service application with API gateway and service mesh integration.

**What you'll learn:**
- Multiple service coordination
- Service mesh patterns
- API gateway configuration

## Advanced Examples

For experienced users exploring complex scenarios.

### [Multi-Environment](./multi-environment.md)
Single codebase deployed across development, staging, and production environments.

**What you'll learn:**
- Environment-specific configuration
- Resource scaling patterns
- GitOps workflows

### [CI/CD Integration](./cicd.md)
Complete CI/CD pipeline with GitHub Actions, ArgoCD, and automated testing.

**What you'll learn:**
- GitOps integration
- Automated deployments
- Testing strategies

### [Monitoring Stack](./monitoring.md)
Comprehensive monitoring setup with Prometheus, Grafana, and alerting.

**What you'll learn:**
- Monitoring infrastructure
- Custom metrics
- Alert configuration

## Real-World Patterns

### Configuration Management

```typescript
// Environment-specific configs
const getConfig = (env: string) => ({
  development: { replicas: 1, resources: { cpu: '100m' } },
  staging: { replicas: 2, resources: { cpu: '200m' } },
  production: { replicas: 5, resources: { cpu: '500m' } }
}[env]);

const deployment = simpleDeployment({
  name: schema.spec.name,
  replicas: getConfig(schema.spec.environment).replicas,
  resources: getConfig(schema.spec.environment).resources
});
```

### Service Discovery

```typescript
// Services can reference each other naturally
const apiService = simpleService({
  name: 'api-service',
  selector: { app: 'api' }
});

const frontend = simpleDeployment({
  name: 'frontend',
  env: {
    API_URL: `http://${apiService.metadata.name}:${apiService.spec.ports[0].port}`
  }
});
```

### Conditional Resources

```typescript
const resources = {
  app: simpleDeployment({ /* ... */ }),
  
  // Only create ingress in production
  ...(schema.spec.environment === 'production' && {
    ingress: simpleIngress({
      name: `${schema.spec.name}-ingress`,
      rules: [{
        host: `${schema.spec.name}.example.com`,
        http: {
          paths: [{
            path: '/',
            backend: {
              service: {
                name: `${schema.spec.name}-service`,
                port: { number: 80 }
              }
            }
          }]
        }
      }]
    })
  })
};
```

## Example Categories

### By Complexity
- **Beginner**: Simple webapp, basic database
- **Intermediate**: Microservices, multi-environment
- **Advanced**: Monitoring, CI/CD, custom operators

### By Use Case
- **Web Applications**: Frontend + backend + database
- **APIs**: REST/GraphQL services with databases
- **Data Processing**: Batch jobs, streaming pipelines
- **Infrastructure**: Monitoring, logging, security

### By Deployment Strategy
- **Direct Deployment**: For development and testing
- **GitOps**: For production environments
- **Hybrid**: Mixed approaches for different environments

## Running the Examples

Each example includes:

1. **Complete source code** - Copy and run immediately
2. **Step-by-step instructions** - Detailed setup guide
3. **Explanation** - Why each pattern is useful
4. **Variations** - Alternative approaches and extensions

### Prerequisites

- Node.js 18+ or Bun
- kubectl configured for your cluster
- TypeKro installed: `bun add typekro`

### Quick Start

```bash
# Clone the example
git clone https://github.com/yehudacohen/typekro-examples
cd typekro-examples/simple-webapp

# Install dependencies
bun install

# Deploy to your cluster
bun run deploy
```

## Contributing Examples

Have a great TypeKro pattern to share? We'd love to include it!

1. Fork the [examples repository](https://github.com/yehudacohen/typekro-examples)
2. Add your example with documentation
3. Submit a pull request

**Good examples include:**
- Real-world use cases
- Clear documentation
- Runnable code
- Best practices demonstration

## Need Help?

- **Questions**: [GitHub Discussions](https://github.com/yehudacohen/typekro/discussions)
- **Issues**: [GitHub Issues](https://github.com/yehudacohen/typekro/issues)
- **Community**: [Discord Server](https://discord.gg/typekro)