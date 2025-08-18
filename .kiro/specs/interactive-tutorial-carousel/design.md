# Interactive Tutorial Carousel - Design Document

## Overview

The Interactive Tutorial Carousel will replace the current static examples section with a dynamic, step-by-step tutorial that guides users through the complete TypeKro workflow. The carousel will be implemented as a Vue.js component integrated into the VitePress documentation site, featuring smooth transitions, responsive design, and progressive disclosure of concepts.

## Architecture

### Component Structure

```
TutorialCarousel/
├── TutorialCarousel.vue          # Main carousel container
├── TutorialStep.vue              # Individual step component
├── CodeExample.vue               # Syntax-highlighted code display
├── NavigationControls.vue        # Carousel navigation (arrows, dots)
├── ProgressIndicator.vue         # Step progress visualization
└── CallToAction.vue              # Next steps and links
```

### Data Flow

1. **Carousel State Management**: Centralized state for current step, navigation, and tutorial progress
2. **Step Content**: Each step contains structured data (title, description, code examples, explanations)
3. **Responsive Adaptation**: Layout adapts based on viewport size and device capabilities
4. **Progressive Enhancement**: Core functionality works without JavaScript, enhanced with interactivity

## Components and Interfaces

### TutorialCarousel Component

```typescript
interface TutorialCarouselProps {
  autoPlay?: boolean;
  showProgress?: boolean;
  enableSwipe?: boolean;
}

interface TutorialStep {
  id: string;
  title: string;
  description: string;
  codeExample: CodeExample;
  explanation: string;
  highlights?: string[];
  nextSteps?: CallToAction[];
}

interface CarouselState {
  currentStep: number;
  totalSteps: number;
  isPlaying: boolean;
  direction: 'forward' | 'backward';
}
```

### Step Content Structure

#### Step 1: Define ArkType Schemas
```typescript
{
  id: 'arktype-schemas',
  title: 'Define Your Application Schema',
  description: 'Start with type-safe schema definitions using ArkType',
  codeExample: {
    language: 'typescript',
    code: `
import { type } from 'arktype';

// Define your application's specification schema
const WebAppSpecSchema = type({
  name: 'string',
  image: 'string',
  replicas: 'number%1',
  port: 'number%1'
});

// Define the status schema for runtime information
const WebAppStatusSchema = type({
  url: 'string',
  ready: 'boolean',
  deployedReplicas: 'number'
});
    `,
    highlights: ['Type safety', 'Runtime validation', 'IntelliSense support']
  },
  explanation: 'ArkType provides runtime type validation with TypeScript inference...'
}
```

#### Step 2: Build Resource Graph
```typescript
{
  id: 'resource-graph',
  title: 'Compose Your Infrastructure',
  description: 'Build Kubernetes resources using factory functions',
  codeExample: {
    language: 'typescript',
    code: `
import { toResourceGraph, simpleDeployment, simpleService } from 'typekro';

const webAppGraph = toResourceGraph(
  'webapp-stack',
  (schema) => ({
    // Create a deployment with cross-references
    deployment: simpleDeployment({
      name: schema.spec.name,
      image: schema.spec.image,
      replicas: schema.spec.replicas,
      ports: [{ containerPort: schema.spec.port }]
    }),
    
    // Create a service that references the deployment
    service: simpleService({
      name: \`\${schema.spec.name}-service\`,
      selector: { app: schema.spec.name },
      ports: [{ port: 80, targetPort: schema.spec.port }]
    })
  }),
  {
    apiVersion: 'example.com/v1alpha1',
    kind: 'WebApp',
    spec: WebAppSpecSchema,
    status: WebAppStatusSchema
  }
);
    `,
    highlights: ['Factory functions', 'Cross-resource references', 'Type-safe composition']
  }
}
```

#### Step 3: YAML Generation (GitOps)
```typescript
{
  id: 'yaml-generation',
  title: 'Generate YAML for GitOps',
  description: 'Export standard Kubernetes manifests for your CI/CD pipeline',
  codeExample: {
    language: 'typescript',
    code: `
// Create a YAML factory for GitOps workflows
const yamlFactory = await webAppGraph.factory('yaml');

// Generate YAML manifests
const yaml = await yamlFactory.create({
  name: 'my-webapp',
  image: 'nginx:latest',
  replicas: 3,
  port: 80
});

console.log(yaml);
// Output: Standard Kubernetes YAML manifests
// ---
// apiVersion: apps/v1
// kind: Deployment
// metadata:
//   name: my-webapp
// spec:
//   replicas: 3
//   selector:
//     matchLabels:
//       app: my-webapp
//   template:
//     spec:
//       containers:
//       - name: my-webapp
//         image: nginx:latest
//         ports:
//         - containerPort: 80
// ---
// apiVersion: v1
// kind: Service
// ...
    `,
    highlights: ['GitOps compatible', 'Standard Kubernetes YAML', 'CI/CD integration']
  }
}
```

#### Step 4: Direct Factory Deployment
```typescript
{
  id: 'direct-deployment',
  title: 'Deploy Directly to Kubernetes',
  description: 'Skip YAML generation and deploy resources immediately',
  codeExample: {
    language: 'typescript',
    code: `
// Create a direct deployment factory
const directFactory = await webAppGraph.factory('direct', { 
  namespace: 'production' 
});

// Deploy your application directly
const instance = await directFactory.create({
  name: 'my-webapp',
  image: 'nginx:latest',
  replicas: 3,
  port: 80
});

// TypeKro handles dependency resolution and deployment order
console.log('Deployed:', instance.status);
// { url: 'http://my-webapp-service.production.svc.cluster.local', ready: true }
    `,
    highlights: ['No kubectl required', 'Automatic dependency resolution', 'Immediate deployment']
  }
}
```

#### Step 5: KRO Controller Deployment
```typescript
{
  id: 'kro-deployment',
  title: 'Use KRO Controller for Advanced Patterns',
  description: 'Deploy ResourceGraphDefinitions for operator-style management',
  codeExample: {
    language: 'typescript',
    code: `
// Install KRO controller first:
// kubectl apply -f https://github.com/awslabs/kro/releases/latest/download/kro.yaml

// Create a KRO factory for operator-style deployment
const kroFactory = await webAppGraph.factory('kro', { 
  namespace: 'production' 
});

// Deploy as a custom resource
const instance = await kroFactory.create({
  name: 'my-webapp',
  image: 'nginx:latest',
  replicas: 3,
  port: 80
});

// KRO controller manages the complete lifecycle
console.log('ResourceGraphDefinition created:', instance.metadata.name);
    `,
    highlights: ['Operator pattern', 'Custom resources', 'Advanced lifecycle management']
  }
}
```

#### Step 6: Alchemy Integration
```typescript
{
  id: 'alchemy-integration',
  title: 'Integrate with Alchemy',
  description: 'Advanced resource management and deployment strategies',
  codeExample: {
    language: 'typescript',
    code: `
import alchemy from 'alchemy';

// Set up Alchemy scope for resource management
const alchemyScope = await alchemy('my-webapp-project', {
  stateStore: (scope) => new FileSystemStateStore(scope, { 
    rootDir: './alchemy-state' 
  })
});

// Create direct factory with Alchemy integration
const alchemyFactory = await webAppGraph.factory('direct', {
  namespace: 'production',
  alchemyScope: alchemyScope,
  kubeConfig: kc,
  waitForReady: true,
  timeout: 60000
});

// Deploy with Alchemy resource tracking
await alchemyScope.run(async () => {
  const instance = await alchemyFactory.deploy({
    name: 'my-webapp',
    image: 'nginx:latest',
    replicas: 3,
    port: 80
  });

  // Alchemy tracks individual Kubernetes resources
  const alchemyState = await alchemyScope.state.all();
  const kubernetesResources = Object.values(alchemyState)
    .filter((state: any) => state.kind.startsWith('kubernetes::'));
  
  console.log(\`Tracked resources: \${kubernetesResources.length}\`);
  // Each Deployment, Service, ConfigMap is tracked individually
});
    `,
    highlights: ['Resource state tracking', 'Individual resource management', 'Advanced lifecycle control']
  }
}
```

### Navigation and Interaction Design

#### Desktop Layout
```
┌─────────────────────────────────────────────────────────────┐
│  ← Step 2 of 6: Build Resource Graph                    →  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────┐  ┌─────────────────┐   │
│  │                                 │  │                 │   │
│  │        Code Example             │  │   Explanation   │   │
│  │                                 │  │                 │   │
│  │   [Wider Syntax                 │  │  Build Kubernetes│   │
│  │    Highlighted                  │  │  resources using │   │
│  │    TypeScript                   │  │  factory funcs.  │   │
│  │    Code Area]                   │  │  This approach   │   │
│  │                                 │  │  provides...     │   │
│  └─────────────────────────────────┘  └─────────────────┘   │
│                                                             │
│  ● ○ ○ ○ ○ ○                                              │
│                                                             │
│  [Previous] [Next] [Get Started] [Learn More]              │
└─────────────────────────────────────────────────────────────┘
```

#### Mobile Layout
```
┌─────────────────────────────────┐
│  Step 2 of 6: Build Resource   │
│  Graph                          │
├─────────────────────────────────┤
│                                 │
│  Build Kubernetes resources     │
│  using factory functions.       │
│  This approach provides...      │
│                                 │
│  ┌─────────────────────────────┐ │
│  │                             │ │
│  │   Code Example              │ │
│  │                             │ │
│  │   [Syntax Highlighted      │ │
│  │    TypeScript]              │ │
│  │                             │ │
│  └─────────────────────────────┘ │
│                                 │
│  ● ○ ○ ○ ○ ○                  │
│                                 │
│  [Previous] [Next]              │
│  [Get Started] [Learn More]     │
└─────────────────────────────────┘
```

## Data Models

### Tutorial Configuration
```typescript
interface TutorialConfig {
  steps: TutorialStep[];
  settings: {
    autoPlayInterval?: number;
    enableKeyboardNavigation: boolean;
    enableSwipeNavigation: boolean;
    showProgressBar: boolean;
    theme: 'light' | 'dark' | 'auto';
  };
  analytics?: {
    trackStepViews: boolean;
    trackCompletions: boolean;
    trackDropoffs: boolean;
  };
}
```

### Code Example Model
```typescript
interface CodeExample {
  language: string;
  code: string;
  highlights?: string[];
  annotations?: CodeAnnotation[];
  runnable?: boolean;
}

interface CodeAnnotation {
  line: number;
  message: string;
  type: 'info' | 'warning' | 'success';
}
```

## Error Handling

### Graceful Degradation
1. **JavaScript Disabled**: Show static content with all steps visible
2. **Network Issues**: Cache tutorial content for offline viewing
3. **Browser Compatibility**: Provide fallback for older browsers
4. **Touch Device Support**: Ensure swipe gestures work reliably

### Error States
```typescript
interface ErrorState {
  type: 'network' | 'syntax' | 'navigation' | 'unknown';
  message: string;
  recoverable: boolean;
  retryAction?: () => void;
}
```

## Testing Strategy

### Unit Tests
- Component rendering and props handling
- Navigation logic and state management
- Code syntax highlighting accuracy
- Responsive layout calculations

### Integration Tests
- Complete tutorial flow navigation
- Cross-device compatibility testing
- Performance testing with large code examples
- Accessibility compliance (WCAG 2.1 AA)

### User Experience Tests
- Tutorial completion rates
- Step-by-step engagement metrics
- Mobile vs desktop usage patterns
- Code example readability assessment

## Performance Considerations

### Code Splitting
```typescript
// Lazy load tutorial steps
const TutorialStep = defineAsyncComponent(() => import('./TutorialStep.vue'));

// Preload next step for smooth transitions
const preloadNextStep = (currentStep: number) => {
  if (currentStep < totalSteps - 1) {
    import(`./steps/Step${currentStep + 1}.vue`);
  }
};
```

### Optimization Strategies
1. **Lazy Loading**: Load tutorial steps on demand
2. **Code Highlighting**: Use lightweight syntax highlighter
3. **Image Optimization**: Compress and lazy load any diagrams
4. **Animation Performance**: Use CSS transforms for smooth transitions
5. **Bundle Size**: Tree-shake unused tutorial features

## Accessibility

### WCAG 2.1 AA Compliance
- Keyboard navigation support (arrow keys, tab, enter)
- Screen reader compatibility with proper ARIA labels
- High contrast mode support
- Focus management during navigation
- Alternative text for code examples

### Keyboard Shortcuts
- `←/→` Arrow keys: Navigate between steps
- `Space/Enter`: Activate buttons and controls
- `Escape`: Close any modal overlays
- `Tab`: Navigate through interactive elements

## Integration Points

### VitePress Integration
```typescript
// docs/.vitepress/theme/components/TutorialCarousel.vue
export default defineComponent({
  name: 'TutorialCarousel',
  setup() {
    // Integration with VitePress theme
    const { isDark } = useData();
    const theme = computed(() => isDark.value ? 'dark' : 'light');
    
    return { theme };
  }
});
```

### Analytics Integration
```typescript
// Track tutorial engagement
const trackTutorialEvent = (event: string, step?: number) => {
  if (typeof gtag !== 'undefined') {
    gtag('event', event, {
      event_category: 'tutorial',
      event_label: step ? `step_${step}` : undefined
    });
  }
};
```

## Deployment Strategy

### Development Phase
1. Create component structure and basic navigation
2. Implement first 2-3 tutorial steps with content
3. Add responsive design and mobile optimization
4. Integrate with existing VitePress theme

### Testing Phase
1. Cross-browser compatibility testing
2. Mobile device testing (iOS/Android)
3. Accessibility audit and fixes
4. Performance optimization and bundle analysis

### Production Deployment
1. Replace current "View Examples" button with tutorial launcher
2. Add analytics tracking for user engagement
3. Monitor performance and user feedback
4. Iterate based on usage patterns and feedback