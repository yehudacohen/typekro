# TypeKro Examples

✅ **All examples are working and tested!** These examples demonstrate the stable TypeKro kubernetesComposition API and compile successfully with the current codebase.

## Essential Examples (6 Examples)

Our curated set of essential examples that showcase TypeKro's key capabilities in a progressive learning path:

### 1. Hero Example (`hero-example.ts`) ⭐
**Perfect for homepage/landing** - Minimal TypeKro demo for first impressions

```typescript
const webapp = kubernetesComposition(
  { /* minimal schema */ },
  (spec) => {
    const deployment = simple.Deployment({ /* minimal config */ });
    const service = simple.Service({ /* minimal config */ });
    return { ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0') };
  }
);
```

**✅ Status**: Working perfectly
**🎯 Use**: Homepage demo, quick TypeKro introduction

### 2. Basic Web Application (`basic-webapp.ts`)
**Complete beginner tutorial** - Full web application stack

**Features**:
- Complete web application (frontend + database + migration)
- Multiple resource types (Deployment, Service, Ingress, Job)
- Schema references with proper ID handling
- Environment configuration
- Status aggregation with CEL expressions

**✅ Status**: Fixed and working
**🎯 Use**: Getting started tutorial, first real project

### 3. Composition Patterns (`imperative-composition.ts`)
**Show different approaches** - Multiple composition patterns in one file

**Features**:
- 3 different composition patterns (simple → full-stack → config-driven)
- Progressive complexity demonstration
- Resource relationships and dependencies
- Various CEL expression patterns

**✅ Status**: Working perfectly
**🎯 Use**: Learning different composition approaches

### 4. Advanced Status & CEL (`complete-webapp.ts`)
**Master complex status mapping** - Advanced CEL expressions and status builders

**Features**:
- Complex status aggregation across multiple resources
- Advanced CEL expressions (`Cel.expr`, `Cel.template`, conditionals)
- Cross-resource status references
- NetworkPolicy and security configurations
- TLS/Ingress advanced configuration

**✅ Status**: Converted from toResourceGraph and working
**🎯 Use**: Advanced users building complex applications

### 5. External References (`external-references.ts`) 🔗
**Cross-composition dependencies** - TypeKro's unique modular architecture capability

**Features**:
- **EXPLICIT** `externalRef()` for resources created outside TypeKro (Helm/kubectl)
- **IMPLICIT** magic proxy references within same composition
- Type-safe external references with full IDE support
- Demonstrates both patterns side-by-side
- Shows automatic CEL expression generation

**✅ Status**: Working and demonstrates both reference patterns
**🎯 Use**: Master TypeKro's reference system, understand magic proxy behavior

### 6. Helm Integration (`helm-integration.ts`) ⚙️
**Leverage existing Helm charts** - Package management integration

**Features**:
- `helmRelease()` function usage
- Helm chart deployment and integration  
- Value templating with schema references
- Mixed Helm + native Kubernetes resources
- Multiple chart orchestration

**✅ Status**: Working perfectly
**🎯 Use**: Teams with existing Helm charts

## Comprehensive Resource Coverage

### Advanced Example: (`comprehensive-k8s-resources.ts`)
**31+ Kubernetes resource types** - Complete coverage demonstration

Shows TypeKro's extensive coverage of Kubernetes resources across all categories:
- Core Resources (Namespace, Pod, PV, PVC)
- Apps Resources (Deployment, StatefulSet, DaemonSet, Job, CronJob)
- RBAC Resources (Role, RoleBinding, ClusterRole, ServiceAccount)
- Storage Resources (StorageClass, CSIDriver)
- Networking Resources (Service, Ingress, NetworkPolicy)
- Policy Resources (PDB, ResourceQuota, LimitRange)
- And many more...

**✅ Status**: Working perfectly
**🎯 Use**: Demonstrate TypeKro's comprehensive K8s support

## Key Architectural Features Demonstrated

### 🏗️ **kubernetesComposition API** (Primary)
- All examples use the stable `kubernetesComposition` pattern
- Single composition function that returns status
- Auto-captured resources with magic proxy system

### 🔗 **Magic Proxy System**
- Schema references: `spec.name`, `spec.replicas`
- Resource references: `deployment.status.readyReplicas`
- Type-safe property access throughout

### 🎯 **CEL Expressions**
- `Cel.expr<boolean>()` for complex logic
- `Cel.template()` for string interpolation
- `Cel.conditional()` for branching logic

### 🌐 **External References**
- `externalRef()` for cross-composition dependencies
- Type-safe references to other CRD instances
- Modular architecture support

### 📦 **Helm Integration**
- `helmRelease()` for chart deployment
- Schema values in Helm chart values
- HelmRelease status integration

## Progressive Learning Path

### **Beginner Journey** (Start Here)
1. **Hero Example** → Quick TypeKro impression
2. **Basic Web Application** → Complete tutorial walkthrough
3. **Stop here for basic usage** ✋

### **Intermediate Journey** (Most Users)
3. **Composition Patterns** → Learn different approaches  
4. **Helm Integration** → Integrate existing charts
5. **Stop here for most use cases** ✋

### **Advanced Journey** (Power Users)
5. **Advanced Status & CEL** → Master complex status mapping
6. **External References** → Build modular architectures
7. **Comprehensive Resources** → Explore full K8s coverage

## Running Examples

All examples are guaranteed to compile and run:

```bash
# Test any example
bun ./examples/hero-example.ts
bun ./examples/basic-webapp.ts
bun ./examples/external-references.ts

# They all generate valid ResourceGraphDefinition YAML
```

## Production Import Patterns

The examples use relative imports (`../src/index.js`) because they run within the TypeKro repository. In your projects, use these import patterns:

```typescript
// Main TypeKro imports
import { kubernetesComposition, Cel, externalRef } from 'typekro';

// Simple factory imports
import { Deployment, Service, ConfigMap, Secret } from 'typekro/simple';

// Helm integration
import { helmRelease } from 'typekro/helm';

// Full example with correct production imports:
import { type } from 'arktype';
import { kubernetesComposition, Cel } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

const webapp = kubernetesComposition(
  { /* schema definition */ },
  (spec) => {
    const deployment = Deployment({ name: spec.name, image: spec.image });
    const service = Service({ name: 'service', selector: { app: spec.name } });
    return { ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0') };
  }
);
```

## API Consistency

✅ **All examples use the same patterns:**
- `kubernetesComposition` (not toResourceGraph)
- `import { Cel, kubernetesComposition } from 'typekro'`
- `import { Deployment, Service } from 'typekro/simple'`
- Explicit `id` fields for resources with schema references
- Enhanced proxy types throughout

## Next Steps

1. **Follow the learning path** based on your experience level
2. **Copy and modify** examples for your use cases
3. **Join the community** for questions and discussions
4. **Check the docs** for comprehensive guides

These examples represent the **essential TypeKro experience** - everything you need to be productive with TypeKro's unique approach to Kubernetes resource management.