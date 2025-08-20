# Examples

Explore real-world TypeKro applications and patterns. Each example includes complete, runnable code and explanations of key concepts.

## Core Patterns

Essential patterns that demonstrate TypeKro's key capabilities.

### [Basic WebApp Pattern](./basic-webapp.md)
Foundational pattern - web application with deployment and service.

**Key concepts:** Resource graphs, factory functions, cross-references, status mapping

### [Database + Application](./database-app.md) 
Full-stack application with PostgreSQL and web application.

**Key concepts:** Multi-resource orchestration, service discovery, environment configuration

### [Microservices Architecture](./microservices.md)
Complex multi-service platform with API gateway and service mesh.

**Key concepts:** Service coordination, ingress routing, health aggregation

### [Helm Integration Patterns](./helm-patterns.md)
Helm chart deployment and integration patterns.

**Key concepts:** Chart deployment, value templating, multi-chart applications

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

## Usage by Experience Level

### **Beginners**
1. [Basic WebApp Pattern](./basic-webapp.md) - Core concepts
2. [Database + Application](./database-app.md) - Resource relationships

### **Intermediate**
1. [Microservices Architecture](./microservices.md) - Multi-service deployments  
2. [Helm Integration](./helm-patterns.md) - Package management

### **Advanced**
Combine patterns and create custom factories for specific use cases.

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
# Copy the example code from the documentation
# Follow the setup instructions in each example
# Examples include complete working code
```

## Contributing Examples

Have a great TypeKro pattern to share? We'd love to include it!

1. Submit examples via GitHub issues or discussions
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
