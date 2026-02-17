# Design Document: Documentation Overhaul

## Overview

This design document outlines the architecture and implementation approach for overhauling TypeKro's documentation. The goal is to create minimalist, high-impact documentation that captures TypeKro's power and expressiveness while being concise and developer-friendly.

The documentation will follow a "show, don't tell" philosophy - leading with compelling code examples that demonstrate TypeKro's unique value proposition, followed by concise explanations.

## Architecture

### Documentation Structure

The documentation will be organized into five main sections with API docs organized by ecosystem (kubernetes, cilium, cert-manager, etc.) and within each by type (core, simple, compositions):

```
docs/
├── index.md                    # Landing page with hero example
├── guide/
│   ├── getting-started.md      # 5-minute quick start
│   ├── philosophy.md           # Mental model and when to use TypeKro
│   ├── composition.md          # kubernetesComposition API
│   ├── magic-proxy.md          # How the proxy system works
│   ├── javascript-to-cel.md    # Automatic conversion patterns
│   ├── deployment-modes.md     # Direct vs Kro vs YAML
│   ├── external-references.md  # Cross-composition coordination
│   └── troubleshooting.md      # Common issues and debugging
├── api/
│   ├── index.md                # API overview and navigation
│   ├── composition.md          # kubernetesComposition reference
│   ├── cel.md                  # Explicit CEL API
│   ├── yaml-closures.md        # yamlFile, yamlDirectory
│   ├── types.md                # Core type definitions
│   ├── kubernetes/             # Kubernetes native resources
│   │   ├── index.md            # Kubernetes factories overview
│   │   ├── core/               # Full factory functions
│   │   │   ├── index.md
│   │   │   ├── workloads.md    # Deployment, StatefulSet, DaemonSet, Job, CronJob
│   │   │   ├── networking.md   # Service, Ingress, NetworkPolicy
│   │   │   ├── config.md       # ConfigMap, Secret
│   │   │   ├── storage.md      # PVC, PV, StorageClass
│   │   │   └── rbac.md         # Role, RoleBinding, ServiceAccount
│   │   ├── simple/             # Simplified factory functions
│   │   │   ├── index.md
│   │   │   └── reference.md    # All simple factories
│   │   └── compositions/       # Pre-built compositions
│   │       ├── index.md
│   │       └── webapp.md       # WebApp composition example
│   ├── cilium/                 # Cilium CRDs
│   │   ├── index.md            # Cilium factories overview
│   │   ├── core/
│   │   │   └── policies.md     # CiliumNetworkPolicy, CiliumClusterwideNetworkPolicy
│   │   ├── simple/
│   │   │   └── reference.md
│   │   └── compositions/
│   │       └── bootstrap.md    # Cilium bootstrap composition
│   ├── cert-manager/           # Cert-Manager CRDs
│   │   ├── index.md            # Cert-Manager factories overview
│   │   ├── core/
│   │   │   └── certificates.md # Certificate, Issuer, ClusterIssuer
│   │   ├── simple/
│   │   │   └── reference.md
│   │   └── compositions/
│   │       └── bootstrap.md    # Cert-Manager bootstrap composition
│   ├── flux/                   # Flux CRDs
│   │   ├── index.md            # Flux factories overview
│   │   ├── core/
│   │   │   ├── helm.md         # HelmRelease, HelmRepository
│   │   │   └── source.md       # GitRepository, OCIRepository
│   │   ├── simple/
│   │   │   └── reference.md
│   │   └── compositions/
│   │       └── bootstrap.md    # Flux bootstrap composition
│   └── kro/                    # Kro CRDs
│       ├── index.md            # Kro factories overview
│       ├── core/
│       │   └── rgd.md          # ResourceGraphDefinition
│       └── compositions/
│           └── runtime.md      # TypeKro runtime bootstrap
├── examples/
│   ├── basic-webapp.md         # Deployment + Service + Ingress
│   ├── database-app.md         # Cross-resource references
│   ├── helm-integration.md     # HelmRelease patterns
│   ├── multi-environment.md    # Environment configs
│   └── custom-crd.md           # Creating custom factories
├── advanced/
│   ├── arktype-schemas.md      # Schema definition guide
│   ├── custom-integrations.md  # Building new factories
│   ├── alchemy-integration.md  # Multi-cloud with Alchemy
│   └── migration.md            # Migration guides
└── README.md                   # Project README (< 500 lines)
```

### Content Principles

1. **Code-First**: Every page leads with a working code example
2. **Concise**: No section exceeds necessary length; examples under 50 lines
3. **Progressive**: Start simple, add complexity as needed
4. **Honest**: Clear about trade-offs and when NOT to use TypeKro
5. **Actionable**: Every page ends with clear next steps

## Components and Interfaces

### Hero Example Component

The hero example demonstrates TypeKro's core value - define a reusable composition once, deploy multiple instances with a simple loop:

```typescript
import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

// Define a reusable WebApp composition
const WebApp = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({ name: 'string', image: 'string', replicas: 'number' }),
  status: type({ ready: 'boolean', endpoint: 'string' })
}, (spec) => {
  const deploy = Deployment({ id: 'app', name: spec.name, image: spec.image, replicas: spec.replicas });
  const svc = Service({ id: 'svc', name: `${spec.name}-svc`, selector: { app: spec.name }, ports: [{ port: 80 }] });

  return {
    ready: deploy.status.readyReplicas > 0,        // ✨ JavaScript → CEL
    endpoint: `http://${svc.status.clusterIP}`     // ✨ Template → CEL
  };
});

// Deploy multiple instances with a simple loop
const apps = [
  { name: 'frontend', image: 'nginx', replicas: 3 },
  { name: 'api', image: 'node:20', replicas: 2 }
];

const factory = WebApp.factory('direct', { namespace: 'production' });
for (const app of apps) await factory.deploy(app);
```

This example demonstrates:
- **Reusable compositions**: Define once, deploy many times
- **Type-safe schemas**: ArkType validates spec at compile-time and runtime
- **Simple factories**: `Deployment` and `Service` with minimal boilerplate
- **Cross-resource references**: `svc.status.clusterIP` references live cluster state
- **JavaScript-to-CEL conversion**: Status expressions become runtime CEL
- **Native TypeScript loops**: No special DSL - just `for...of` to deploy multiple apps

### Comparison Table Component

A concise comparison table for the README:

| Feature | TypeKro | Pulumi | CDK8s | Helm |
|---------|---------|--------|-------|------|
| Type Safety | ✅ Full | ✅ Multi-lang | ✅ TS | ❌ |
| GitOps Ready | ✅ | ❌ State | ✅ | ✅ |
| Runtime Refs | ✅ CEL | ❌ | ❌ | ❌ |
| Learning Curve | 🟢 Just TS | 🔴 | 🟡 | 🔴 |
| Stateless | ✅ | ❌ | ✅ | ✅ |

### API Documentation Pattern

Each ecosystem (kubernetes, cilium, etc.) follows a consistent three-tier structure:

#### Core Factories
Full-featured factory functions with complete type definitions:
```typescript
// api/kubernetes/core/workloads.md
import { Deployment } from 'typekro/factories/kubernetes';

const deploy = Deployment({
  metadata: { name: 'my-app', namespace: 'default' },
  spec: {
    replicas: 3,
    selector: { matchLabels: { app: 'my-app' } },
    template: { /* full pod template */ }
  }
});
```

#### Simple Factories
Simplified APIs with sensible defaults:
```typescript
// api/kubernetes/simple/reference.md
import { Deployment } from 'typekro/simple';

const deploy = Deployment({
  id: 'app',
  name: 'my-app',
  image: 'nginx:latest',
  replicas: 3
});
```

#### Compositions
Pre-built compositions for common patterns:
```typescript
// api/kubernetes/compositions/webapp.md
import { webAppComposition } from 'typekro/compositions';

const app = webAppComposition({
  name: 'my-webapp',
  image: 'my-app:v1',
  replicas: 3,
  ingress: { host: 'app.example.com' }
});
```

### Documentation Page Template

Each documentation page follows a consistent structure:

```markdown
# Page Title

[One-sentence description]

## Quick Example

\`\`\`typescript
// Working code example (< 20 lines)
\`\`\`

## How It Works

[Concise explanation - 2-3 paragraphs max]

## Patterns

### Pattern 1: [Name]
[Code + brief explanation]

### Pattern 2: [Name]
[Code + brief explanation]

## Common Pitfalls

- [Pitfall 1]: [Solution]
- [Pitfall 2]: [Solution]

## Next Steps

- [Link to related topic]
- [Link to API reference]
```

## Data Models

### Documentation Metadata

Each documentation file includes frontmatter for navigation and search:

```yaml
---
title: Page Title
description: One-sentence description for SEO
category: guide | api | examples | advanced
order: 1
tags: [composition, factories, cel]
---
```

### Example Registry

Examples are tracked in a central registry for consistency:

```typescript
interface Example {
  name: string;
  file: string;
  concepts: string[];  // What this example teaches
  lineCount: number;   // Must be < 50
  requirements: string[]; // Which requirements this validates
}
```

### Navigation Structure

```typescript
interface NavItem {
  title: string;
  path: string;
  children?: NavItem[];
}

const navigation: NavItem[] = [
  {
    title: 'Getting Started',
    path: '/guide/',
    children: [
      { title: 'Quick Start', path: '/guide/getting-started' },
      { title: 'Philosophy', path: '/guide/philosophy' }
    ]
  },
  {
    title: 'API Reference',
    path: '/api/',
    children: [
      { title: 'Composition', path: '/api/composition' },
      { title: 'CEL', path: '/api/cel' },
      {
        title: 'Kubernetes',
        path: '/api/kubernetes/',
        children: [
          { title: 'Core', path: '/api/kubernetes/core/' },
          { title: 'Simple', path: '/api/kubernetes/simple/' },
          { title: 'Compositions', path: '/api/kubernetes/compositions/' }
        ]
      },
      { title: 'Cilium', path: '/api/cilium/' },
      { title: 'Cert-Manager', path: '/api/cert-manager/' },
      { title: 'Flux', path: '/api/flux/' },
      { title: 'Kro', path: '/api/kro/' }
    ]
  }
];
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system - essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

For documentation, correctness properties focus on measurable constraints that can be automatically validated.

### Property 1: Line Count Constraints

*For any* documentation artifact with a specified line limit (README, hero example, individual examples), the actual line count SHALL not exceed the specified maximum.

- README: ≤ 500 lines
- Hero example: ≤ 30 lines  
- Individual examples: ≤ 50 lines each

**Validates: Requirements 1.1, 1.5, 12.5**

### Property 2: Word Count Constraints

*For any* documentation section with a specified word limit (philosophy section), the actual word count SHALL not exceed the specified maximum.

- Philosophy section: ≤ 200 words

**Validates: Requirements 2.1**

### Property 3: Factory Documentation Completeness

*For any* factory function exported from TypeKro's public API, there SHALL exist corresponding documentation in the appropriate API reference section.

**Validates: Requirements 8.1**

### Property 4: Navigation Completeness

*For any* documentation page, there SHALL exist at least one "Next Steps" link pointing to a related topic or API reference.

**Validates: Requirements 13.3**

### Property 5: Example Compilability

*For any* TypeScript code example in the documentation, the code SHALL compile without errors when type-checked against the TypeKro type definitions.

**Validates: Requirements 1.2, 3.2, 3.4, 3.5, 8.5**

## Error Handling

### Documentation Build Errors

The documentation build process should provide clear error messages for:

1. **Missing frontmatter**: "Page {path} is missing required frontmatter fields: {fields}"
2. **Broken links**: "Link to {target} in {source} does not resolve to a valid page"
3. **Line count violations**: "Example in {path} exceeds {limit} line limit ({actual} lines)"
4. **Missing next steps**: "Page {path} does not have a 'Next Steps' section"

### Content Validation Errors

During CI/CD, validate:

1. **Code example syntax**: All TypeScript examples must parse without syntax errors
2. **Import validity**: All imports in examples must reference valid TypeKro exports
3. **Link integrity**: All internal links must resolve to existing pages
4. **Image references**: All image paths must point to existing files

## Testing Strategy

### Unit Tests

Unit tests verify specific documentation constraints:

1. **Line count tests**: Verify README, hero example, and all examples meet line limits
2. **Word count tests**: Verify philosophy section meets word limit
3. **Structure tests**: Verify all required sections exist in each page type
4. **Frontmatter tests**: Verify all pages have required metadata

### Property-Based Tests

Property tests verify universal documentation properties:

1. **Factory completeness**: Generate list of all exported factories, verify each has documentation
2. **Navigation completeness**: For all pages, verify next steps links exist
3. **Example compilability**: For all code examples, verify TypeScript compilation succeeds

### Integration Tests

Integration tests verify the documentation site builds and functions correctly:

1. **Build test**: Documentation site builds without errors
2. **Link test**: All internal and external links resolve
3. **Search test**: Search index includes all pages
4. **Navigation test**: Sidebar navigation matches expected structure

### Test Configuration

```typescript
// Documentation test configuration
const docTestConfig = {
  lineLimits: {
    readme: 500,
    heroExample: 30,
    examples: 50
  },
  wordLimits: {
    philosophy: 200
  },
  requiredSections: {
    guide: ['Quick Example', 'How It Works', 'Next Steps'],
    api: ['Parameters', 'Returns', 'Examples'],
    examples: ['Code', 'Explanation', 'Next Steps']
  },
  requiredFrontmatter: ['title', 'description', 'category']
};
```

### Validation Scripts

```bash
# Validate all documentation constraints
bun run docs:validate

# Check line counts
bun run docs:check-lines

# Verify all examples compile
bun run docs:check-examples

# Check for broken links
bun run docs:check-links

# Full documentation build with validation
bun run docs:build
```
