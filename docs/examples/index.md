# Examples

Explore real-world TypeKro applications with complete, runnable code. Each example demonstrates the **imperative composition pattern** using `kubernetesComposition` and showcases TypeKro's unique capabilities.

## 🎯 **Essential Examples** (Start Here)

Master TypeKro progressively through our curated essential examples, each building on the previous concepts.

### 1. [Basic WebApp](./basic-webapp.md) 🎓 **(Start Here)**
Your first TypeKro application - deployment + service using imperative composition.

**Learn:** `kubernetesComposition` basics, factory functions, schema references, status derivation

### 2. [Database Integration](./database-app.md) 🗄️ 
Full-stack web application with PostgreSQL database and cross-resource references.

**Learn:** Multi-resource coordination, service discovery, environment configuration, resource dependencies

### 3. [Microservices](./microservices.md) 🔄
Multi-service application with API gateway, demonstrating service coordination patterns.

**Learn:** Service mesh integration, complex routing, distributed status aggregation

### 4. [Multi-Environment](./multi-environment.md) 🌍
Single codebase deployed across dev/staging/production with environment-specific configuration.

**Learn:** Environment parametrization, resource scaling, GitOps workflows, deployment strategies

### 5. [CI/CD Integration](./cicd.md) 🚀
Complete CI/CD pipeline with GitHub Actions, ArgoCD, and automated testing.

**Learn:** GitOps integration, automated deployments, testing strategies, production workflows

### 6. [Monitoring Stack](./monitoring.md) 📊
Comprehensive observability with Prometheus, Grafana, and custom metrics.

**Learn:** Infrastructure monitoring, custom metrics, alerting, operational patterns

## 🚀 **TypeKro's Unique Capabilities**

These examples showcase features that make TypeKro special compared to other infrastructure tools.

### **Magic Proxy System & Schema References**
See how TypeKro's magic proxy automatically converts schema references to CEL expressions at runtime:

```typescript
const app = kubernetesComposition({
  name: 'webapp', 
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({ name: 'string', replicas: 'number' })
}, (schema) => {
  const deployment = Deployment({
    name: schema.spec.name,        // ← Becomes CEL expression
    replicas: schema.spec.replicas // ← Type-safe at compile-time
  });
  
  return { deployment };
});
```

### **External References & Cross-Composition**
Learn how to reference resources from other compositions using `externalRef()`:

```typescript
// Reference database from separate composition
const dbRef = externalRef('database', 'my-database');
const app = kubernetesComposition(definition, (schema) => {
  const deployment = Deployment({
    env: {
      DATABASE_URL: Cel.template('postgres://%s:5432/app', dbRef.service.spec.clusterIP)
    }
  });
  return { deployment };
});
```

*Demonstrated in: [Database Integration](./database-app.md), [Microservices](./microservices.md)*

### **Runtime Status Intelligence**
TypeKro automatically derives meaningful status from your resources:

```typescript
// Status automatically computed from deployment health
return { 
  ready: deployment.status.readyReplicas > 0,  // ← Becomes CEL expression
  url: Cel.template('https://%s', ingress.status.loadBalancer.ingress[0].hostname)
};
```

## 📚 **Learning Path by Experience**

### **🟢 New to TypeKro?**
Follow this path to master TypeKro systematically:

1. **[Basic WebApp](./basic-webapp.md)** - Learn imperative composition fundamentals
2. **[Database Integration](./database-app.md)** - Add cross-resource dependencies  
3. **[Multi-Environment](./multi-environment.md)** - Scale across environments

### **🟡 Kubernetes Experience?**
Skip basics and focus on TypeKro's unique features:

1. **[Microservices](./microservices.md)** - Complex service coordination
2. **[CI/CD Integration](./cicd.md)** - Production GitOps workflows
3. **[Monitoring Stack](./monitoring.md)** - Operational excellence

### **🔵 Infrastructure as Code Background?**
Compare TypeKro with your current tools:

- **vs Pulumi**: See [Basic WebApp](./basic-webapp.md) for type-safety comparison
- **vs CDK8s**: See [Database Integration](./database-app.md) for runtime intelligence
- **vs Helm**: See [Multi-Environment](./multi-environment.md) for deterministic YAML
- **vs Kustomize**: See [CI/CD Integration](./cicd.md) for programmatic flexibility

## 🎯 **Choose Your Path**

### **I want to build...**
- **Web Applications**: Start with [Basic WebApp](./basic-webapp.md) → [Database Integration](./database-app.md)
- **API Services**: [Database Integration](./database-app.md) → [Microservices](./microservices.md)  
- **Production Infrastructure**: [Multi-Environment](./multi-environment.md) → [CI/CD Integration](./cicd.md)
- **Observability**: [Monitoring Stack](./monitoring.md)

### **I want to learn...**
- **TypeKro Basics**: [Basic WebApp](./basic-webapp.md)
- **Resource Dependencies**: [Database Integration](./database-app.md)
- **Complex Orchestration**: [Microservices](./microservices.md)
- **GitOps Workflows**: [CI/CD Integration](./cicd.md)
- **Production Patterns**: [Multi-Environment](./multi-environment.md) + [Monitoring](./monitoring.md)

## 🏃‍♂️ **Running the Examples**

Every example is **complete and runnable** with copy-paste code using the `kubernetesComposition` API.

### **What's Included**
✅ **Complete source code** - Copy and run immediately  
✅ **Step-by-step setup** - From installation to deployment  
✅ **Key concepts explained** - Why each pattern matters  
✅ **Production variations** - Real-world adaptations  

### **Prerequisites**
```bash
# Runtime
node >= 18 || bun >= 1.0

# Kubernetes cluster (any of):
minikube start              # Local development
kind create cluster         # Docker-based
# Or use existing cluster

# Install TypeKro
bun add typekro
# or
npm install typekro
```

### **Quick Start Any Example**
```bash
# 1. Copy the example code from any guide
# 2. Save as app.ts
# 3. Run directly
bun run app.ts

# Or deploy to cluster
kubectl apply -f <generated-yaml>
```

### **Deployment Options**
Each example works with both deployment strategies:

```typescript
// Direct deployment (immediate)
await app.factory('direct').deploy(spec);

// GitOps YAML generation  
const yaml = app.factory('kro').toYaml(spec);
writeFileSync('k8s/app.yaml', yaml);
```

## 📈 **From Examples to Production**

Our examples show realistic patterns you'll actually use:

- **Development**: Direct deployment for fast iteration
- **Staging**: GitOps YAML with environment-specific config
- **Production**: Full CI/CD with monitoring and observability

### **Next Steps After Examples**
1. **[API Reference](../api/)** - Complete function documentation
2. **[Deployment Strategies](../guide/deployment/)** - Choose the right approach
3. **[Custom Factories](../guide/custom-factories.md)** - Build reusable components

## 🤝 **Community & Support**

### **Contributing Examples**
Share your TypeKro patterns with the community:

1. Real-world use cases using `kubernetesComposition`
2. Clear documentation with working code
3. Submit via [GitHub Issues](https://github.com/yehudacohen/typekro/issues) or [Discussions](https://github.com/yehudacohen/typekro/discussions)

### **Getting Help**
- **Quick Questions**: [Discord Community](https://discord.gg/kKNSDDjW)
- **Detailed Discussions**: [GitHub Discussions](https://github.com/yehudacohen/typekro/discussions)
- **Bug Reports**: [GitHub Issues](https://github.com/yehudacohen/typekro/issues)

---

**Ready to start?** Begin with [Basic WebApp](./basic-webapp.md) to learn TypeKro's imperative composition fundamentals! 🚀
