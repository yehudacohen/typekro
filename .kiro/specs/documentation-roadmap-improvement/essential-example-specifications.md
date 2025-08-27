# Essential Example Specifications

## Overview

Based on the inventory analysis, we've consolidated from 18 examples to 5 essential examples that showcase TypeKro's key capabilities in a progressive learning path. Each example demonstrates specific concepts while building on previous knowledge.

## Essential Example Set (5 Examples)

### 1. Hero Example (Homepage/Landing)
**File**: `hero-example.ts` ✅ (Already perfect)

**Learning Objective**: First impression - minimal TypeKro demo for homepage
**Target Audience**: All visitors, 10-second attention span
**Complexity Level**: Minimal (5 lines of meaningful code)

**Features Demonstrated**:
- `kubernetesComposition` basic usage
- Simple Deployment + Service
- Basic CEL expression
- Minimal schema definition

**Current Status**: ✅ Complete and working
**Action Required**: Keep as-is, use for homepage

**Code Structure**:
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

---

### 2. Basic Web Application
**File**: Fix existing `basic-webapp.ts` 

**Learning Objective**: First real tutorial - complete web application
**Target Audience**: Beginners following the getting started guide
**Complexity Level**: Beginner-friendly but comprehensive

**Features Demonstrated**:
- Complete web application stack (web + database)
- Multiple resource types (Deployment, Service, Ingress, Job)
- Schema references with proper ID handling
- Environment configuration
- Status aggregation with CEL expressions
- Cross-resource dependencies

**Issues to Fix**:
- KubernetesRef ID generation errors (needs explicit IDs)
- Some overly complex patterns that could be simplified

**Estimated Work**: 2 hours to fix ID issues and simplify

**Required Changes**:
1. Add explicit `id` fields for all resources using schema references
2. Simplify the composition logic
3. Add clear comments explaining each step
4. Test compilation and runtime success

---

### 3. Composition Patterns Showcase
**File**: Keep existing `imperative-composition.ts` ✅

**Learning Objective**: Show different composition approaches and patterns
**Target Audience**: Intermediate users exploring composition options
**Complexity Level**: Intermediate

**Features Demonstrated**:
- Multiple composition patterns in one file
- Progressive complexity (simple → full-stack → config-driven)
- Resource relationships and dependencies
- Different CEL expression patterns
- Configuration-driven applications

**Current Status**: ✅ Excellent structure, appears to work well
**Action Required**: Test compilation, minor cleanup if needed

---

### 4. Advanced Status Builders & CEL
**File**: Convert existing `complete-webapp.ts` from toResourceGraph → kubernetesComposition

**Learning Objective**: Master advanced status mapping and CEL expressions
**Target Audience**: Advanced users building complex applications  
**Complexity Level**: Advanced

**Features Demonstrated**:
- Complex status aggregation across multiple resources
- Advanced CEL expressions (`Cel.expr`, `Cel.template`, conditionals)
- Cross-resource status references
- NetworkPolicy and security configurations
- TLS/Ingress advanced configuration

**Issues to Fix**:
- Convert from `toResourceGraph` API to `kubernetesComposition`
- Update imports and API calls
- Ensure proper Enhanced type usage

**Estimated Work**: 3 hours for API conversion and testing

---

### 5. External References (NEW)
**File**: Create new `external-references.ts`

**Learning Objective**: Cross-composition dependencies with external references
**Target Audience**: Advanced users building modular architectures
**Complexity Level**: Advanced

**Features Demonstrated**:
- Real `externalRef()` function usage (not hallucinated)
- Cross-composition dependencies
- Modular architecture patterns
- Resource sharing between compositions
- Type-safe external references

**Key TypeKro Differentiator**: This showcases unique TypeKro capability

**Estimated Work**: 6 hours to research actual `externalRef()` implementation and create working example

**Research Required**: 
- Locate actual `externalRef()` function in codebase
- Understand proper usage patterns
- Create realistic cross-composition scenario

---

### 6. Package Management Integration (NEW)  
**File**: Create new `helm-integration.ts`

**Learning Objective**: Leverage existing Helm charts with TypeKro
**Target Audience**: Intermediate users with existing Helm charts
**Complexity Level**: Intermediate

**Features Demonstrated**:
- `helmRelease()` function usage
- Helm chart deployment and integration
- Value templating with schema references
- Mixed Helm + native Kubernetes resources
- Chart dependencies and status monitoring

**Estimated Work**: 4 hours to create working Helm integration example

**Research Required**:
- Locate `helmRelease()` function implementation
- Understand value templating patterns
- Create realistic Helm + TypeKro scenario

---

## Learning Progression Path

### Beginner Journey
1. **Hero Example** → Quick impression of TypeKro
2. **Basic Web Application** → Complete tutorial walkthrough  
3. Stop here for basic usage

### Intermediate Journey  
3. **Composition Patterns** → Learn different approaches
4. **Package Management** → Integrate with existing Helm charts
5. Stop here for most use cases

### Advanced Journey
5. **Advanced Status & CEL** → Master complex status mapping
6. **External References** → Build modular architectures

## Success Criteria for Each Example

### All Examples Must:
- ✅ Compile successfully with current TypeKro implementation
- ✅ Use `kubernetesComposition` API (not `toResourceGraph`)
- ✅ Use correct import patterns (`from 'typekro'` and `from 'typekro/simple'`)
- ✅ Include clear comments explaining key concepts
- ✅ Demonstrate real TypeKro capabilities (no hallucinated APIs)
- ✅ Run without errors (may need cluster for deployment but should compile)

### Individual Success Criteria:

**Hero Example**: 
- Loads and compiles in <1 second
- Generates valid YAML
- Clear and impressive for homepage

**Basic Web Application**:
- Complete working tutorial 
- All resources compile and link correctly
- Clear progression from simple to complex concepts

**Composition Patterns**:
- Shows 3+ distinct composition approaches
- Demonstrates resource relationships
- Clear benefits of each pattern

**Advanced Status & CEL**:
- Complex status aggregation across 5+ resources
- Advanced CEL expressions with proper typing
- Real-world networking and security setup

**External References**:
- Demonstrates actual cross-composition dependencies
- Uses real `externalRef()` function
- Shows modular architecture benefits

**Package Management**:
- Real Helm chart integration
- Value templating with schema references
- Mixed resource types (Helm + native K8s)

## Implementation Timeline

**Current Progress**: 3/6 examples ready (Hero ✅, Patterns ✅, Comprehensive needs conversion)

**Phase 0 Remaining Work**: 
- Fix Basic Web Application (2 hours)
- Convert Advanced Status example (3 hours)  
- Create External References example (6 hours)
- Create Package Management example (4 hours)
- **Total**: 15 hours remaining in Phase 0

This aligns with our Phase 0 budget of 30 hours total, with ~15 hours already spent on inventory and consolidation.