# JavaScript to CEL Expression Conversion Design
**Version**: 1.0
**Last Updated**: 2025-01-22

## 1. Overview

This document outlines the design for automatic JavaScript to CEL expression conversion throughout TypeKro. The core insight is that TypeKro's magic proxy system (SchemaProxy and ResourcesProxy) returns KubernetesRef objects at runtime when developers access fields. The system detects when JavaScript expressions contain these KubernetesRef objects and automatically converts the entire expression to appropriate CEL expressions.

The goal is to enable developers to write natural JavaScript expressions anywhere CEL expressions are currently required, with automatic conversion happening transparently based on KubernetesRef detection.

This is a foundational enhancement that will improve developer experience across all TypeKro APIs by hiding the complexity of the magic proxy system.

## 2. Core Concepts

### 2.1. Universal KubernetesRef Detection and Analysis

The system provides a universal analyzer that detects KubernetesRef objects in JavaScript expressions and converts them appropriately:

```typescript
// Status builders (toResourceGraph) - resources proxy returns KubernetesRef objects
(schema, resources) => ({
  ready: resources.deployment.status.readyReplicas > 0,  // Contains KubernetesRef - auto-converted to CEL
  url: `http://${resources.service.status.loadBalancer.ingress[0].ip}` // Contains KubernetesRef - auto-converted
})

// Resource builders - schema proxy returns KubernetesRef objects
simpleDeployment({
  name: schema.spec.name, // KubernetesRef - auto-converted
  env: {
    NODE_ENV: 'production', // Static string - no conversion needed
    DATABASE_URL: `postgres://user:pass@${database.status.podIP}:5432/mydb`  // Contains KubernetesRef - auto-converted
  }
})

// Conditional resource inclusion - schema proxy returns KubernetesRef objects
includeWhen: service.spec.type === 'LoadBalancer'  // Contains KubernetesRef - auto-converted

// Resource readiness checks - resources proxy returns KubernetesRef objects
readyWhen: deployment.status.conditions.find(c => c.type === 'Available').status === 'True' // Contains KubernetesRef - auto-converted
```

### 2.2. Context-Aware KubernetesRef Conversion

The analyzer understands different contexts and converts KubernetesRef objects to appropriate CEL expressions:

```typescript
// In status builder context - resources proxy provides KubernetesRef objects:
ready: deployment.status.readyReplicas > 0
// Runtime: KubernetesRef { resourceId: 'deployment', fieldPath: 'status.readyReplicas' } > 0
// Generates: ${resources.deployment.status.readyReplicas > 0}

// In resource builder context - mixed KubernetesRef and static values:
DATABASE_URL: `postgres://${database.status.podIP}:5432/db`
// Runtime: Template literal containing KubernetesRef { resourceId: 'database', fieldPath: 'status.podIP' }
// Generates: ${'postgres://' + resources.database.status.podIP + ':5432/db'}

// In conditional context - schema proxy provides KubernetesRef objects:
includeWhen: schema.spec.ingress.enabled
// Runtime: KubernetesRef { resourceId: '__schema__', fieldPath: 'spec.ingress.enabled' }
// Generates: ${schema.spec.ingress.enabled}
```

### 2.3. Kro Optionality Integration with KubernetesRef Objects

Full support for Kro's conditional CEL expressions using the `?` operator when KubernetesRef objects are used with optional chaining:

```typescript
// JavaScript optional chaining with KubernetesRef objects:
service.status?.loadBalancer?.ingress?.[0]?.ip
// Runtime: KubernetesRef chain with optional chaining operators

// Converts to Kro conditional CEL:
${resources.service.status.loadBalancer?.ingress?[0]?.ip}
```

### 2.4. Magic Proxy System Integration

The system works with TypeKro's magic proxy system where resource and schema references are `KubernetesRef` objects at runtime:

```typescript
// At compile time: TypeScript sees these as the actual types
// At runtime: These are KubernetesRef objects that need conversion

// Schema references (from SchemaProxy)
schema.spec.name // Runtime: KubernetesRef { resourceId: '__schema__', fieldPath: 'spec.name' }
schema.spec.replicas // Runtime: KubernetesRef { resourceId: '__schema__', fieldPath: 'spec.replicas' }

// Resource references (from ResourcesProxy) 
resources.database.status.podIP // Runtime: KubernetesRef { resourceId: 'database', fieldPath: 'status.podIP' }
resources.webapp.status.readyReplicas // Runtime: KubernetesRef { resourceId: 'webapp', fieldPath: 'status.readyReplicas' }
```

### 2.5. Factory Pattern Integration

The system adapts expression handling based on the deployment strategy:

```typescript
// Direct Factory Pattern - KubernetesRef objects are resolved to actual values before evaluation
const directFactory = await graph.factory('direct', { namespace: 'prod' });
// JavaScript expressions are evaluated with resolved dependencies
// Example: resources.database.status.podIP resolves to actual IP, then template literal is evaluated

// Kro Factory Pattern - KubernetesRef objects are converted to CEL expressions
const kroFactory = await graph.factory('kro', { namespace: 'prod' });
// JavaScript expressions are converted to CEL expressions for Kro controller
// Example: resources.database.status.podIP becomes ${resources.database.status.podIP} in CEL
```

### 2.6. MagicAssignable Type Integration

JavaScript expressions work seamlessly with MagicAssignable types by detecting KubernetesRef usage:

```typescript
interface ResourceConfig {
  name: MagicAssignable<string>;
  replicas: MagicAssignable<number>;
  env: MagicAssignableShape<Record<string, string>>;
}

// The analyzer detects when expressions contain KubernetesRef objects:
const config: ResourceConfig = {
  name: schema.spec.name, // Contains KubernetesRef - needs conversion
  replicas: schema.spec.replicas > 10 ? 10 : schema.spec.replicas, // Contains KubernetesRef - needs conversion
  env: {
    NODE_ENV: 'production', // Static string - no conversion needed
    DATABASE_URL: `postgres://${database.status.podIP}:5432/db`, // Contains KubernetesRef - needs conversion
    READY: database.status?.ready ? 'true' : 'false' // Contains KubernetesRef - needs conversion
  }
};
```

### 2.7. Field Hydration Strategy Integration

Expression conversion integrates with TypeKro's field hydration system by preserving dependency tracking:

```typescript
// Status builders with field hydration
(schema, resources) => ({
  // The analyzer detects KubernetesRef objects in expressions and tracks dependencies
  ready: resources.deployment.status?.readyReplicas > 0 && 
         resources.service.status?.ready,
  // Dependencies: ['deployment', 'service'] - hydration waits for these resources
  
  // Optional chaining with KubernetesRef objects
  url: resources.ingress.status?.loadBalancer?.ingress?.[0]?.ip || 'pending',
  // Dependencies: ['ingress'] - hydration waits for ingress resource
  
  // Complex expressions maintain dependency tracking
  health: resources.deployment.status?.conditions?.find(c => c.type === 'Available')?.status === 'True'
  // Dependencies: ['deployment'] - hydration waits for deployment resource
});
```

### 2.8. Enhanced Type Optionality Handling

The system handles the mismatch between Enhanced type compile-time non-optionality and runtime optionality:

```typescript
// Enhanced types show fields as non-optional at compile time:
interface DeploymentStatus {
  readyReplicas: number; // TypeScript sees this as always available
}

// But at runtime, KubernetesRef objects might resolve to undefined during field hydration:
resources.deployment.status.readyReplicas
// Runtime: KubernetesRef that might resolve to undefined

// The analyzer automatically adds null-safety to generated CEL expressions:
ready: resources.deployment.status.readyReplicas > 0
// Generates: ${has(resources.deployment.status.readyReplicas) && resources.deployment.status.readyReplicas > 0}

// Optional chaining works correctly even with "non-optional" Enhanced types:
ready: resources.deployment.status?.readyReplicas > 0
// Generates: ${resources.deployment.status.readyReplicas? > 0} (using Kro's ? operator)
```

## 3. Architecture Components

### 3.1. Core Expression Analyzer

```typescript
export class JavaScriptToCelAnalyzer {
  analyzeExpression(
    expression: string | Function,
    context: AnalysisContext
  ): CelConversionResult;
  
  convertASTNode(
    node: ESTree.Node,
    context: AnalysisContext
  ): CelExpression;
  
  // NEW: Analyze expressions that contain KubernetesRef objects
  analyzeExpressionWithRefs(
    expression: any, // Could be a JavaScript expression or contain KubernetesRef objects
    context: AnalysisContext
  ): CelConversionResult;
  
  // NEW: Detect if a value contains KubernetesRef objects
  containsKubernetesRefs(value: any): boolean;
}

interface AnalysisContext {
  type: 'status' | 'resource' | 'condition' | 'readiness';
  availableReferences: Record<string, Enhanced<any, any>>; // Enhanced resources from magic proxy
  schemaProxy: SchemaProxy<any, any>; // Schema proxy for schema references
  factoryType: 'direct' | 'kro'; // Factory pattern being used
  sourceMap: SourceMapBuilder;
}

interface CelConversionResult {
  celExpression: CelExpression;
  dependencies: KubernetesRef<any>[]; // Track KubernetesRef dependencies
  sourceMap: SourceMapEntry[];
  errors: ConversionError[];
  requiresConversion: boolean; // Whether the expression actually needs conversion
}
```

### 3.2. Expression Type Support

**Basic Expressions**:
- Binary operators: `>`, `<`, `>=`, `<=`, `==`, `!=`, `&&`, `||`
- Member access: `object.property`, `object['property']`
- Array access: `array[0]`, `array[index]`
- Literals: strings, numbers, booleans, null, undefined

**Advanced Expressions**:
- Optional chaining: `obj?.prop?.field`
- Logical fallbacks: `value || defaultValue`
- Nullish coalescing: `value ?? defaultValue`
- Conditional expressions: `condition ? true : false`
- Template literals: `` `Hello ${name}` ``

**Complex Expressions**:
- Method calls: `array.find()`, `array.filter()`, `string.includes()`
- Nested expressions with proper precedence
- Array and object destructuring (limited support)

### 3.3. Integration Points

**Status Builders**:
```typescript
// Enhanced toResourceGraph
export function toResourceGraph<TSpec, TStatus>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  resourceBuilder: (schema: SchemaProxy<TSpec>) => Record<string, Enhanced<any, any>>,
  statusBuilder: (schema: SchemaProxy<TSpec>, resources: Record<string, Enhanced<any, any>>) => TStatus
): TypedResourceGraph<TSpec, TStatus> {
  // ... existing logic ...
  
  // NEW: Analyze statusBuilder function for JavaScript expressions
  const analyzedStatus = analyzeStatusBuilder(statusBuilder, resources);
  
  // ... rest of implementation ...
}
```

**Resource Builders**:
```typescript
// Enhanced factory functions
export function simpleDeployment(config: DeploymentConfig): Enhanced<DeploymentSpec, DeploymentStatus> {
  // ... existing logic ...
  
  // NEW: Analyze config values for JavaScript expressions that depend on references
  const processedConfig = analyzeResourceConfig(config);
  
  // ... rest of implementation ...
}
```

### 3.4. Factory Pattern Integration

**Direct Factory Strategy**:
```typescript
export class DirectFactoryExpressionHandler {
  evaluateExpression(
    expression: JavaScriptExpression,
    resolvedDependencies: Record<string, any>
  ): any {
    // For direct factory, evaluate JavaScript expressions with resolved dependencies
    const context = this.createEvaluationContext(resolvedDependencies);
    return this.evaluateInContext(expression, context);
  }
  
  private createEvaluationContext(dependencies: Record<string, any>): EvaluationContext {
    return {
      resources: dependencies,
      schema: this.schemaProxy,
      // Direct evaluation context with actual values
    };
  }
}
```

**Kro Factory Strategy**:
```typescript
export class KroFactoryExpressionHandler {
  convertExpression(
    expression: JavaScriptExpression,
    context: AnalysisContext
  ): CelExpression {
    // For Kro factory, convert JavaScript expressions to CEL
    const analyzer = new JavaScriptToCelAnalyzer();
    const result = analyzer.analyzeExpression(expression, context);
    return result.celExpression;
  }
  
  generateResourceGraphDefinition(
    expressions: Record<string, JavaScriptExpression>
  ): ResourceGraphDefinition {
    // Convert all expressions to CEL for Kro controller
    const celExpressions = {};
    for (const [key, expr] of Object.entries(expressions)) {
      celExpressions[key] = this.convertExpression(expr, this.createKroContext());
    }
    return this.buildRGD(celExpressions);
  }
}
```

### 3.5. MagicAssignable Type Integration

**Type-Aware Expression Analysis**:
```typescript
export class MagicAssignableAnalyzer {
  analyzeMagicAssignable<T>(
    value: MagicAssignable<T>,
    context: AnalysisContext
  ): ProcessedMagicAssignable<T> {
    
    // Check if the value contains KubernetesRef objects (from magic proxy)
    if (this.containsKubernetesRefs(value)) {
      const analyzer = new JavaScriptToCelAnalyzer();
      const result = analyzer.analyzeExpressionWithRefs(value, context);
      
      return {
        originalValue: value,
        processedValue: result.celExpression,
        dependencies: result.dependencies,
        errors: result.errors,
        requiresConversion: result.requiresConversion
      };
    }
    
    // Return as-is for static values (no KubernetesRef objects)
    return {
      originalValue: value,
      processedValue: value,
      dependencies: [],
      errors: [],
      requiresConversion: false
    };
  }
  
  analyzeMagicAssignableShape<T extends Record<string, any>>(
    shape: MagicAssignableShape<T>,
    context: AnalysisContext
  ): ProcessedMagicAssignableShape<T> {
    
    const processedShape: any = {};
    const allDependencies: KubernetesRef<any>[] = [];
    const allErrors: ConversionError[] = [];
    let requiresConversion = false;
    
    for (const [key, value] of Object.entries(shape)) {
      const processed = this.analyzeMagicAssignable(value, context);
      processedShape[key] = processed.processedValue;
      allDependencies.push(...processed.dependencies);
      allErrors.push(...processed.errors);
      requiresConversion = requiresConversion || processed.requiresConversion;
    }
    
    return {
      originalShape: shape,
      processedShape,
      dependencies: allDependencies,
      errors: allErrors,
      requiresConversion
    };
  }
  
  private containsKubernetesRefs(value: any): boolean {
    // Recursively check if value contains KubernetesRef objects
    if (this.isKubernetesRef(value)) {
      return true;
    }
    
    if (Array.isArray(value)) {
      return value.some(item => this.containsKubernetesRefs(item));
    }
    
    if (value && typeof value === 'object') {
      return Object.values(value).some(val => this.containsKubernetesRefs(val));
    }
    
    return false;
  }
  
  private isKubernetesRef(value: any): value is KubernetesRef<any> {
    return value && typeof value === 'object' && value[KUBERNETES_REF_BRAND] === true;
  }
}

interface ProcessedMagicAssignable<T> {
  originalValue: MagicAssignable<T>;
  processedValue: T | CelExpression;
  dependencies: KubernetesRef<any>[];
  errors: ConversionError[];
  requiresConversion: boolean;
}

interface ProcessedMagicAssignableShape<T> {
  originalShape: MagicAssignableShape<T>;
  processedShape: T;
  dependencies: KubernetesRef<any>[];
  errors: ConversionError[];
  requiresConversion: boolean;
}
```

### 3.6. Field Hydration Integration

**Hydration-Aware Expression Processing**:
```typescript
export class FieldHydrationExpressionProcessor {
  processStatusExpressions(
    statusBuilder: StatusBuilderFunction,
    resources: Record<string, Enhanced<any, any>>,
    hydrationStrategy: FieldHydrationStrategy
  ): ProcessedStatusBuilder {
    
    const analyzer = new JavaScriptToCelAnalyzer();
    const expressionDependencies = new Map<string, ResourceReference[]>();
    
    // Analyze status builder for JavaScript expressions
    const statusMappings = analyzer.analyzeFunction(statusBuilder, resources);
    
    // Track dependencies for hydration ordering
    for (const [fieldName, expression] of Object.entries(statusMappings.statusMappings)) {
      const deps = this.extractDependencies(expression);
      expressionDependencies.set(fieldName, deps);
    }
    
    // Integrate with hydration strategy
    const hydrationOrder = hydrationStrategy.calculateHydrationOrder(expressionDependencies);
    
    return {
      statusMappings: statusMappings.statusMappings,
      hydrationOrder,
      dependencies: expressionDependencies
    };
  }
  
  private extractDependencies(expression: CelExpression): ResourceReference[] {
    // Extract resource dependencies from CEL expression
    const dependencies: ResourceReference[] = [];
    
    // Parse CEL expression to find resource references
    const celString = expression.toString();
    const resourceMatches = celString.match(/resources\.(\w+)\./g);
    
    if (resourceMatches) {
      for (const match of resourceMatches) {
        const resourceId = match.replace('resources.', '').replace('.', '');
        dependencies.push({ resourceId, type: 'resource' });
      }
    }
    
    return dependencies;
  }
}

interface ProcessedStatusBuilder {
  statusMappings: Record<string, CelExpression>;
  hydrationOrder: string[];
  dependencies: Map<string, ResourceReference[]>;
}

interface FieldHydrationStrategy {
  calculateHydrationOrder(dependencies: Map<string, ResourceReference[]>): string[];
}
```

## 4. Implementation Strategy

### 4.1. Phase 1: Core Expression Analysis Engine

**File: `src/core/expressions/analyzer.ts`**

```typescript
import * as esprima from 'esprima';
import * as estraverse from 'estraverse';

export class JavaScriptToCelAnalyzer {
  private cache = new ExpressionCache();
  
  analyzeExpression(expression: string, context: AnalysisContext): CelConversionResult {
    // Check cache first
    const cached = this.cache.get(expression, context);
    if (cached) return cached;
    
    try {
      // Parse JavaScript expression to AST
      const ast = esprima.parseScript(`(${expression})`);
      
      // Extract the expression node
      const exprNode = (ast.body[0] as any).expression;
      
      // Convert to CEL
      const celExpression = this.convertASTNode(exprNode, context);
      
      const result = {
        celExpression,
        dependencies: context.dependencies || [],
        sourceMap: context.sourceMap?.entries || [],
        errors: []
      };
      
      // Cache the result
      this.cache.set(expression, context, result);
      return result;
    } catch (error) {
      const errorResult = {
        celExpression: null,
        dependencies: [],
        sourceMap: [],
        errors: [new ConversionError(error.message, expression)]
      };
      
      this.cache.set(expression, context, errorResult);
      return errorResult;
    }
  }
  
  analyzeFunction(fn: Function, resourceMap: Record<string, Enhanced<any, any>>): AnalysisResult {
    // Parse function to AST
    const ast = esprima.parseScript(fn.toString());
    
    // Extract return statement
    const returnStatement = this.findReturnStatement(ast);
    if (!returnStatement) {
      throw new Error('Function must have a return statement for analysis');
    }
    
    // Analyze each property in the returned object
    const statusMappings: Record<string, any> = {};
    const sourceMap: SourceMapEntry[] = [];
    
    if (returnStatement.argument?.type === 'ObjectExpression') {
      for (const property of returnStatement.argument.properties) {
        if (property.type === 'Property' && property.key.type === 'Identifier') {
          const fieldName = property.key.name;
          
          try {
            const context: AnalysisContext = {
              type: 'status',
              availableReferences: resourceMap,
              schemaFields: {},
              sourceMap: new SourceMapBuilder()
            };
            
            const celExpression = this.convertASTNode(property.value, context);
            statusMappings[fieldName] = celExpression;
            
            // Add source mapping
            sourceMap.push({
              originalExpression: this.getSourceText(property.value),
              celExpression: celExpression.toString(),
              line: property.loc?.start.line || 0,
              column: property.loc?.start.column || 0,
              length: this.getSourceText(property.value).length,
              context: 'status'
            });
          } catch (error) {
            throw new ConversionError(
              `Failed to convert expression for field '${fieldName}': ${error.message}`,
              this.getSourceText(property.value)
            );
          }
        }
      }
    }
    
    return { 
      statusMappings, 
      resourceReferences: Object.values(resourceMap), 
      errors: [],
      sourceMap 
    };
  }
  
  private convertASTNode(node: ESTree.Node, context: AnalysisContext): CelExpression {
    switch (node.type) {
      case 'BinaryExpression':
        return this.convertBinaryExpression(node, context);
      case 'MemberExpression':
        return this.convertMemberExpression(node, context);
      case 'ConditionalExpression':
        return this.convertConditionalExpression(node, context);
      case 'LogicalExpression':
        return this.convertLogicalExpression(node, context);
      case 'ChainExpression':
        return this.convertOptionalChaining(node, context);
      case 'TemplateLiteral':
        return this.convertTemplateLiteral(node, context);
      case 'Literal':
        return this.convertLiteral(node, context);
      case 'CallExpression':
        return this.convertCallExpression(node, context);
      case 'ArrayExpression':
        return this.convertArrayExpression(node, context);
      default:
        throw new Error(`Unsupported expression type: ${node.type}`);
    }
  }
  
  private convertBinaryExpression(node: any, context: AnalysisContext): CelExpression {
    const left = this.convertASTNode(node.left, context);
    const right = this.convertASTNode(node.right, context);
    
    // Generate appropriate CEL expression based on context
    const operator = this.mapOperatorToCel(node.operator);
    return Cel.expr(`${left} ${operator} ${right}`);
  }
  
  private convertMemberExpression(node: any, context: AnalysisContext): CelExpression {
    // Convert resource.status.field to proper resource reference
    const path = this.extractMemberPath(node);
    
    // Check if this is a resource reference
    if (context.availableReferences) {
      for (const [resourceKey, resource] of Object.entries(context.availableReferences)) {
        if (path.startsWith(`${resourceKey}.`)) {
          const fieldPath = path.substring(resourceKey.length + 1);
          return this.getResourceFieldReference(resource, fieldPath, context);
        }
      }
    }
    
    // Handle schema references
    if (path.startsWith('schema.') || path.startsWith('spec.')) {
      return this.getSchemaFieldReference(path, context);
    }
    
    throw new Error(`Unable to resolve member expression: ${path}`);
  }
  
  private convertConditionalExpression(node: any, context: AnalysisContext): CelExpression {
    const test = this.convertASTNode(node.test, context);
    const consequent = this.convertASTNode(node.consequent, context);
    const alternate = this.convertASTNode(node.alternate, context);
    
    return Cel.expr(`${test} ? ${consequent} : ${alternate}`);
  }
  
  private convertTemplateLiteral(node: any, context: AnalysisContext): CelExpression {
    let template = '';
    const expressions: CelExpression[] = [];
    
    for (let i = 0; i < node.quasis.length; i++) {
      template += node.quasis[i].value.cooked;
      
      if (i < node.expressions.length) {
        const expr = this.convertASTNode(node.expressions[i], context);
        template += '%s';
        expressions.push(expr);
      }
    }
    
    if (expressions.length === 0) {
      return Cel.literal(template);
    }
    
    return Cel.template(template, ...expressions);
  }
  
  private convertLiteral(node: any, context: AnalysisContext): CelExpression {
    return Cel.literal(node.value);
  }
  
  private convertCallExpression(node: any, context: AnalysisContext): CelExpression {
    // Handle common JavaScript methods that can be converted to CEL
    if (node.callee.type === 'MemberExpression') {
      const object = this.convertASTNode(node.callee.object, context);
      const methodName = node.callee.property.name;
      
      switch (methodName) {
        case 'find':
          return this.convertArrayFind(object, node.arguments, context);
        case 'filter':
          return this.convertArrayFilter(object, node.arguments, context);
        case 'includes':
          return this.convertStringIncludes(object, node.arguments, context);
        default:
          throw new Error(`Unsupported method call: ${methodName}`);
      }
    }
    
    throw new Error(`Unsupported call expression`);
  }
  
  private findReturnStatement(ast: any): any {
    let returnStatement = null;
    
    estraverse.traverse(ast, {
      enter: (node) => {
        if (node.type === 'ReturnStatement') {
          returnStatement = node;
          return estraverse.VisitorOption.Break;
        }
      }
    });
    
    return returnStatement;
  }
  
  private extractMemberPath(node: any): string {
    if (node.type === 'Identifier') {
      return node.name;
    }
    
    if (node.type === 'MemberExpression') {
      const object = this.extractMemberPath(node.object);
      const property = node.computed ? 
        `[${this.getSourceText(node.property)}]` : 
        `.${node.property.name}`;
      return object + property;
    }
    
    throw new Error(`Cannot extract path from node type: ${node.type}`);
  }
  
  private getSourceText(node: any): string {
    // This would need to be implemented based on the original source
    // For now, return a placeholder
    return `<expression>`;
  }
  
  private mapOperatorToCel(operator: string): string {
    const mapping: Record<string, string> = {
      '===': '==',
      '!==': '!=',
      '&&': '&&',
      '||': '||'
    };
    
    return mapping[operator] || operator;
  }
  
  private getResourceFieldReference(
    resource: Enhanced<any, any>, 
    fieldPath: string, 
    context: AnalysisContext
  ): CelExpression {
    // Generate CEL expression for resource field reference
    const resourceId = resource.__resourceId || 'unknown';
    return Cel.expr(`resources.${resourceId}.${fieldPath}`);
  }
  
  private getSchemaFieldReference(path: string, context: AnalysisContext): CelExpression {
    // Generate CEL expression for schema field reference
    return Cel.expr(`schema.${path}`);
  }
}

interface AnalysisResult {
  statusMappings: Record<string, CelExpression>;
  resourceReferences: ResourceReference[];
  errors: ConversionError[];
  sourceMap: SourceMapEntry[];
}

interface SourceMapEntry {
  originalExpression: string;
  celExpression: string;
  line: number;
  column: number;
  length: number;
  context: string;
}

class ConversionError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
    public readonly line?: number,
    public readonly column?: number
  ) {
    super(message);
    this.name = 'ConversionError';
  }
}
```

### 4.2. Phase 2: Context Integration

**Status Builder Integration**:
```typescript
// File: src/core/expressions/status-builder-analyzer.ts
export function analyzeStatusBuilder<TSpec, TStatus>(
  statusBuilder: (schema: SchemaProxy<TSpec>, resources: Record<string, Enhanced<any, any>>) => TStatus,
  resources: Record<string, Enhanced<any, any>>
): Record<string, CelExpression> {
  
  const analyzer = new JavaScriptToCelAnalyzer();
  
  // Analyze the status builder function
  const result = analyzer.analyzeFunction(statusBuilder, resources);
  
  return result.statusMappings;
}

export function analyzeReturnObject(
  functionBody: string, 
  context: AnalysisContext, 
  analyzer: JavaScriptToCelAnalyzer
): Record<string, CelExpression> {
  
  // Parse the function and extract return statement
  const ast = esprima.parseScript(functionBody);
  const returnStatement = findReturnStatement(ast);
  
  if (!returnStatement || returnStatement.argument?.type !== 'ObjectExpression') {
    throw new Error('Status builder must return an object literal');
  }
  
  const statusMappings: Record<string, CelExpression> = {};
  
  for (const property of returnStatement.argument.properties) {
    if (property.type === 'Property' && property.key.type === 'Identifier') {
      const fieldName = property.key.name;
      const celExpression = analyzer.convertASTNode(property.value, context);
      statusMappings[fieldName] = celExpression;
    }
  }
  
  return statusMappings;
}

function extractSchemaFields(): Record<string, TypeInfo> {
  // Extract available schema fields from the current context
  // This would be implemented based on the schema definition
  return {};
}

function findReturnStatement(ast: any): any {
  let returnStatement = null;
  
  estraverse.traverse(ast, {
    enter: (node) => {
      if (node.type === 'ReturnStatement') {
        returnStatement = node;
        return estraverse.VisitorOption.Break;
      }
    }
  });
  
  return returnStatement;
}
```

**Resource Builder Integration**:
```typescript
// File: src/core/expressions/resource-analyzer.ts
export function analyzeResourceConfig<T>(
  config: T,
  availableReferences: Record<string, Enhanced<any, any>>
): T {
  
  const analyzer = new JavaScriptToCelAnalyzer();
  const context: AnalysisContext = {
    type: 'resource',
    availableReferences,
    schemaFields: {},
    sourceMap: new SourceMapBuilder()
  };
  
  return deepAnalyzeObject(config, context, analyzer);
}

export function deepAnalyzeObject<T>(
  obj: T, 
  context: AnalysisContext, 
  analyzer: JavaScriptToCelAnalyzer
): T {
  
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => deepAnalyzeObject(item, context, analyzer)) as unknown as T;
  }
  
  const result: any = {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && containsResourceReference(value, context.availableReferences)) {
      // This string contains a resource reference - convert to CEL
      try {
        const celExpression = analyzer.analyzeExpression(value, context);
        result[key] = celExpression.celExpression;
      } catch (error) {
        // If conversion fails, keep original value
        result[key] = value;
      }
    } else if (typeof value === 'object') {
      result[key] = deepAnalyzeObject(value, context, analyzer);
    } else {
      result[key] = value;
    }
  }
  
  return result as T;
}

function containsResourceReference(
  str: string, 
  availableReferences: Record<string, Enhanced<any, any>>
): boolean {
  
  // Check if the string contains template literals with resource references
  const templateLiteralRegex = /\$\{([^}]+)\}/g;
  let match;
  
  while ((match = templateLiteralRegex.exec(str)) !== null) {
    const expression = match[1];
    
    // Check if expression references any available resources
    for (const resourceKey of Object.keys(availableReferences)) {
      if (expression.includes(`${resourceKey}.`)) {
        return true;
      }
    }
  }
  
  return false;
}
```

**Enhanced toResourceGraph Integration**:
```typescript
// File: src/core/serialization/enhanced-serialization.ts
export function enhanceToResourceGraph<TSpec, TStatus>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  resourceBuilder: (schema: SchemaProxy<TSpec>) => Record<string, Enhanced<any, any>>,
  statusBuilder: (schema: SchemaProxy<TSpec>, resources: Record<string, Enhanced<any, any>>) => TStatus
): TypedResourceGraph<TSpec, TStatus> {
  
  // Create enhanced status builder that automatically converts JavaScript expressions
  const enhancedStatusBuilder = (schema: SchemaProxy<TSpec>, resources: Record<string, Enhanced<any, any>>) => {
    
    // Check if JavaScript-to-CEL conversion is available
    if (isJavaScriptToCelAvailable()) {
      // Use automatic conversion
      const statusMappings = analyzeStatusBuilder(statusBuilder, resources);
      return convertStatusMappingsToCelExpressions(statusMappings);
    } else {
      // Fall back to original behavior
      return statusBuilder(schema, resources);
    }
  };
  
  // Use the original toResourceGraph with enhanced status builder
  return originalToResourceGraph(definition, resourceBuilder, enhancedStatusBuilder);
}

function isJavaScriptToCelAvailable(): boolean {
  try {
    // Check if the JavaScript-to-CEL analyzer is available
    return typeof JavaScriptToCelAnalyzer !== 'undefined';
  } catch {
    return false;
  }
}

function convertStatusMappingsToCelExpressions(
  statusMappings: Record<string, CelExpression>
): any {
  
  const result: any = {};
  
  for (const [key, celExpression] of Object.entries(statusMappings)) {
    result[key] = celExpression;
  }
  
  return result;
}
```

### 4.3. Phase 3: Advanced Expression Support

**Optional Chaining Conversion**:
```typescript
private convertOptionalChaining(node: ChainExpression, context: AnalysisContext): CelExpression {
  // Convert obj?.prop?.field to Kro conditional CEL
  const expression = node.expression;
  
  if (expression.type === 'MemberExpression' && expression.optional) {
    // Generate: has(obj.prop) ? obj.prop.field : null
    return this.generateKroConditionalCel(expression, context);
  }
  
  return this.convertASTNode(expression, context);
}
```

**Logical Fallback Conversion**:
```typescript
private convertLogicalExpression(node: LogicalExpression, context: AnalysisContext): CelExpression {
  const left = this.convertASTNode(node.left, context);
  const right = this.convertASTNode(node.right, context);
  
  switch (node.operator) {
    case '||':
      // Convert: value || default to CEL conditional
      return Cel.expr(`has(${left}) && ${left} != null ? ${left} : ${right}`);
    case '??':
      // Convert: value ?? default to CEL null check
      return Cel.expr(`${left} != null ? ${left} : ${right}`);
    case '&&':
      return Cel.expr(`${left} && ${right}`);
    default:
      throw new Error(`Unsupported logical operator: ${node.operator}`);
  }
}

private convertOptionalChaining(node: ChainExpression, context: AnalysisContext): CelExpression {
  // Convert obj?.prop?.field to Kro conditional CEL
  const expression = node.expression;
  
  if (expression.type === 'MemberExpression' && expression.optional) {
    // Generate Kro conditional CEL using ? operator
    return this.generateKroConditionalCel(expression, context);
  }
  
  return this.convertASTNode(expression, context);
}

private generateKroConditionalCel(node: any, context: AnalysisContext): CelExpression {
  // Convert optional chaining to Kro's ? operator
  const path = this.extractMemberPath(node);
  
  // Replace JavaScript ?. with Kro ? operator
  const kroPath = path.replace(/\?\./g, '?.');
  
  if (context.availableReferences) {
    for (const [resourceKey, resource] of Object.entries(context.availableReferences)) {
      if (path.startsWith(`${resourceKey}.`)) {
        const fieldPath = kroPath.substring(resourceKey.length + 1);
        const resourceId = resource.__resourceId || resourceKey;
        return Cel.expr(`resources.${resourceId}.${fieldPath}`);
      }
    }
  }
  
  return Cel.expr(`schema.${kroPath}`);
}

private convertArrayFind(object: CelExpression, args: any[], context: AnalysisContext): CelExpression {
  if (args.length !== 1 || args[0].type !== 'ArrowFunctionExpression') {
    throw new Error('Array.find() requires a single arrow function argument');
  }
  
  const callback = args[0];
  const param = callback.params[0].name;
  const test = this.convertASTNode(callback.body, context);
  
  // Convert to CEL filter expression
  return Cel.expr(`${object}.filter(${param}, ${test})[0]`);
}

private convertArrayFilter(object: CelExpression, args: any[], context: AnalysisContext): CelExpression {
  if (args.length !== 1 || args[0].type !== 'ArrowFunctionExpression') {
    throw new Error('Array.filter() requires a single arrow function argument');
  }
  
  const callback = args[0];
  const param = callback.params[0].name;
  const test = this.convertASTNode(callback.body, context);
  
  return Cel.expr(`${object}.filter(${param}, ${test})`);
}

private convertStringIncludes(object: CelExpression, args: any[], context: AnalysisContext): CelExpression {
  if (args.length !== 1) {
    throw new Error('String.includes() requires exactly one argument');
  }
  
  const searchValue = this.convertASTNode(args[0], context);
  return Cel.expr(`${object}.contains(${searchValue})`);
}

private convertArrayExpression(node: any, context: AnalysisContext): CelExpression {
  const elements = node.elements.map((element: any) => 
    element ? this.convertASTNode(element, context) : null
  );
  
  return Cel.expr(`[${elements.filter(e => e !== null).join(', ')}]`);
}
```

## 5. Error Handling and Debugging

### 5.1. Source Mapping

```typescript
interface SourceMapEntry {
  originalExpression: string;
  celExpression: string;
  line: number;
  column: number;
  length: number;
  context: string;
}

class SourceMapBuilder {
  private entries: SourceMapEntry[] = [];
  
  addMapping(
    originalExpr: string,
    celExpr: string,
    location: SourceLocation,
    context: string
  ): void {
    this.entries.push({
      originalExpression: originalExpr,
      celExpression: celExpr,
      line: location.line,
      column: location.column,
      length: originalExpr.length,
      context
    });
  }
  
  generateSourceMap(): SourceMap {
    return new SourceMap(this.entries);
  }
  
  get entries(): SourceMapEntry[] {
    return [...this.entries];
  }
}

class SourceMap {
  constructor(private entries: SourceMapEntry[]) {}
  
  findMapping(celExpression: string): SourceMapEntry | null {
    return this.entries.find(entry => 
      entry.celExpression === celExpression ||
      entry.celExpression.includes(celExpression)
    ) || null;
  }
  
  findMappingByLine(line: number, column: number): SourceMapEntry | null {
    return this.entries.find(entry => 
      entry.line === line && 
      column >= entry.column && 
      column < entry.column + entry.length
    ) || null;
  }
  
  getAllMappings(): SourceMapEntry[] {
    return [...this.entries];
  }
}

interface SourceLocation {
  line: number;
  column: number;
}
```

### 5.2. Runtime Error Mapping

```typescript
export class CelRuntimeErrorMapper {
  mapErrorToSource(
    celError: CelEvaluationError,
    sourceMap: SourceMap
  ): JavaScriptError {
    // Map CEL runtime errors back to original JavaScript source
    const mapping = sourceMap.findMapping(celError.expression);
    
    if (mapping) {
      return new JavaScriptError(
        `JavaScript expression error: ${celError.message}`,
        mapping.originalExpression,
        mapping.line,
        mapping.column,
        celError
      );
    }
    
    // Fallback if no mapping found
    return new JavaScriptError(
      `CEL expression error: ${celError.message}`,
      celError.expression,
      0,
      0,
      celError
    );
  }
  
  enhanceStackTrace(
    error: Error,
    sourceMap: SourceMap
  ): EnhancedError {
    
    const enhancedStack: StackTraceEntry[] = [];
    
    // Parse the original stack trace and enhance with source mapping
    const stackLines = error.stack?.split('\n') || [];
    
    for (const line of stackLines) {
      const celMatch = line.match(/CEL expression: (.+)/);
      if (celMatch) {
        const celExpression = celMatch[1];
        const mapping = sourceMap.findMapping(celExpression);
        
        if (mapping) {
          enhancedStack.push({
            originalLine: line,
            enhancedLine: `    at JavaScript expression "${mapping.originalExpression}" (line ${mapping.line}:${mapping.column})`,
            sourceMapping: mapping
          });
        } else {
          enhancedStack.push({
            originalLine: line,
            enhancedLine: line,
            sourceMapping: null
          });
        }
      } else {
        enhancedStack.push({
          originalLine: line,
          enhancedLine: line,
          sourceMapping: null
        });
      }
    }
    
    return new EnhancedError(error.message, enhancedStack, error);
  }
}

class JavaScriptError extends Error {
  constructor(
    message: string,
    public readonly originalExpression: string,
    public readonly line: number,
    public readonly column: number,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'JavaScriptError';
  }
  
  toString(): string {
    return `${this.name}: ${this.message}\n    at "${this.originalExpression}" (line ${this.line}:${this.column})`;
  }
}

class EnhancedError extends Error {
  constructor(
    message: string,
    public readonly enhancedStack: StackTraceEntry[],
    public readonly originalError: Error
  ) {
    super(message);
    this.name = 'EnhancedError';
    
    // Override stack trace with enhanced version
    this.stack = this.generateEnhancedStack();
  }
  
  private generateEnhancedStack(): string {
    const stackLines = [
      `${this.name}: ${this.message}`,
      ...this.enhancedStack.map(entry => entry.enhancedLine)
    ];
    
    return stackLines.join('\n');
  }
}

interface StackTraceEntry {
  originalLine: string;
  enhancedLine: string;
  sourceMapping: SourceMapEntry | null;
}

interface CelEvaluationError extends Error {
  expression: string;
}
```

### 5.3. Expression Validation and Debugging

```typescript
export class ExpressionValidator {
  validateExpression(
    expression: string,
    context: AnalysisContext
  ): ValidationResult {
    
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    
    try {
      // Parse the expression
      const ast = esprima.parseScript(`(${expression})`);
      
      // Validate AST nodes
      this.validateASTNode(ast, context, errors, warnings);
      
      return {
        isValid: errors.length === 0,
        errors,
        warnings,
        suggestions: this.generateSuggestions(errors, expression)
      };
      
    } catch (parseError) {
      errors.push(new ValidationError(
        'PARSE_ERROR',
        `Failed to parse JavaScript expression: ${parseError.message}`,
        expression,
        0,
        0
      ));
      
      return {
        isValid: false,
        errors,
        warnings: [],
        suggestions: ['Check JavaScript syntax']
      };
    }
  }
  
  private validateASTNode(
    node: any,
    context: AnalysisContext,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    
    estraverse.traverse(node, {
      enter: (node) => {
        switch (node.type) {
          case 'CallExpression':
            this.validateCallExpression(node, context, errors, warnings);
            break;
          case 'MemberExpression':
            this.validateMemberExpression(node, context, errors, warnings);
            break;
          case 'BinaryExpression':
            this.validateBinaryExpression(node, context, errors, warnings);
            break;
        }
      }
    });
  }
  
  private validateCallExpression(
    node: any,
    context: AnalysisContext,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    
    const supportedMethods = ['find', 'filter', 'includes', 'map'];
    
    if (node.callee.type === 'MemberExpression') {
      const methodName = node.callee.property.name;
      
      if (!supportedMethods.includes(methodName)) {
        errors.push(new ValidationError(
          'UNSUPPORTED_METHOD',
          `Method '${methodName}' is not supported in CEL conversion`,
          this.getNodeSource(node),
          node.loc?.start.line || 0,
          node.loc?.start.column || 0
        ));
      }
    }
  }
  
  private validateMemberExpression(
    node: any,
    context: AnalysisContext,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    
    const path = this.extractMemberPath(node);
    
    // Check if the referenced resource exists
    if (context.availableReferences) {
      const resourceKey = path.split('.')[0];
      
      if (!context.availableReferences[resourceKey] && !path.startsWith('schema.')) {
        errors.push(new ValidationError(
          'UNKNOWN_REFERENCE',
          `Unknown resource reference: '${resourceKey}'`,
          path,
          node.loc?.start.line || 0,
          node.loc?.start.column || 0
        ));
      }
    }
  }
  
  private validateBinaryExpression(
    node: any,
    context: AnalysisContext,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    
    const unsupportedOperators = ['instanceof', 'in'];
    
    if (unsupportedOperators.includes(node.operator)) {
      errors.push(new ValidationError(
        'UNSUPPORTED_OPERATOR',
        `Operator '${node.operator}' is not supported in CEL conversion`,
        this.getNodeSource(node),
        node.loc?.start.line || 0,
        node.loc?.start.column || 0
      ));
    }
  }
  
  private generateSuggestions(errors: ValidationError[], expression: string): string[] {
    const suggestions: string[] = [];
    
    for (const error of errors) {
      switch (error.code) {
        case 'UNSUPPORTED_METHOD':
          suggestions.push('Consider using supported methods: find, filter, includes, map');
          break;
        case 'UNKNOWN_REFERENCE':
          suggestions.push('Check that the resource is defined in the same composition');
          break;
        case 'UNSUPPORTED_OPERATOR':
          suggestions.push('Use CEL-compatible operators: ==, !=, <, >, <=, >=, &&, ||');
          break;
      }
    }
    
    return suggestions;
  }
  
  private extractMemberPath(node: any): string {
    // Implementation from the analyzer
    if (node.type === 'Identifier') {
      return node.name;
    }
    
    if (node.type === 'MemberExpression') {
      const object = this.extractMemberPath(node.object);
      const property = node.computed ? 
        `[${this.getNodeSource(node.property)}]` : 
        `.${node.property.name}`;
      return object + property;
    }
    
    return '<unknown>';
  }
  
  private getNodeSource(node: any): string {
    // This would extract the original source text for the node
    return '<expression>';
  }
}

interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  suggestions: string[];
}

class ValidationError {
  constructor(
    public readonly code: string,
    public readonly message: string,
    public readonly expression: string,
    public readonly line: number,
    public readonly column: number
  ) {}
}

class ValidationWarning {
  constructor(
    public readonly code: string,
    public readonly message: string,
    public readonly expression: string,
    public readonly line: number,
    public readonly column: number
  ) {}
}
```

## 6. Performance Considerations

### 6.1. Expression Caching

```typescript
class ExpressionCache {
  private cache = new Map<string, CelConversionResult>();
  
  get(expression: string, context: AnalysisContext): CelConversionResult | null {
    const key = this.generateCacheKey(expression, context);
    return this.cache.get(key) || null;
  }
  
  set(expression: string, context: AnalysisContext, result: CelConversionResult): void {
    const key = this.generateCacheKey(expression, context);
    this.cache.set(key, result);
  }
}
```

### 6.2. Lazy Analysis

```typescript
// Only analyze expressions when they're actually needed
export function createLazyAnalyzedExpression(
  expression: string,
  context: AnalysisContext
): LazyAnalyzedExpression {
  
  return {
    get celExpression() {
      if (!this._analyzed) {
        this._result = analyzer.analyzeExpression(expression, context);
        this._analyzed = true;
      }
      return this._result.celExpression;
    }
  };
}
```

## 7. Integration Examples

### 7.1. Enhanced Status Builders

```typescript
// Before: Manual CEL expressions
const webapp = toResourceGraph(
  definition,
  (schema) => ({ /* resources */ }),
  (schema, resources) => ({
    ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
    url: Cel.template('http://%s', resources.service.status.loadBalancer.ingress[0].ip),
    replicas: resources.deployment.status.readyReplicas
  })
);

// After: Natural JavaScript (automatically converted)
const webapp = toResourceGraph(
  definition,
  (schema) => ({ /* resources */ }),
  (schema, resources) => ({
    ready: resources.deployment.status.readyReplicas > 0,
    url: `http://${resources.service.status.loadBalancer.ingress[0].ip}`,
    replicas: resources.deployment.status.readyReplicas
  })
);
```

### 7.2. Enhanced Resource Builders

```typescript
// Before: Manual reference handling
const app = simpleDeployment({
  name: 'api',
  env: {
    DATABASE_URL: Cel.template('postgres://user:pass@%s:5432/mydb', database.status.podIP)
  }
});

// After: Natural JavaScript (when DATABASE_URL depends on database reference)
const app = simpleDeployment({
  name: 'api',
  env: {
    DATABASE_URL: `postgres://user:pass@${database.status.podIP}:5432/mydb`
  }
});
```

## 8. Future Enhancements

### 8.1. IDE Integration

- Real-time CEL expression preview in IDE
- Syntax highlighting for JavaScript expressions that will be converted
- Error squiggles for unsupported expression patterns

### 8.2. Advanced Method Support

- Support for more JavaScript array methods (`map`, `filter`, `reduce`)
- String manipulation methods (`split`, `join`, `replace`)
- Math operations and functions

### 8.3. Performance Optimizations

- Compile-time expression analysis for static expressions
- Expression optimization and simplification
- Parallel analysis for large expression sets

## 9. Testing Strategy

### 9.1. Expression Conversion Tests

```typescript
describe('JavaScript to CEL Conversion', () => {
  test('converts binary expressions', () => {
    const result = analyzer.analyzeExpression('a > b', context);
    expect(result.celExpression).toBe('${a > b}');
  });
  
  test('converts optional chaining', () => {
    const result = analyzer.analyzeExpression('obj?.prop?.field', context);
    expect(result.celExpression).toBe('${obj.prop?.field}');
  });
  
  test('converts logical fallbacks', () => {
    const result = analyzer.analyzeExpression('value || "default"', context);
    expect(result.celExpression).toBe('${has(value) && value != null ? value : "default"}');
  });
});
```

### 9.2. Integration Tests

```typescript
describe('Status Builder Integration', () => {
  test('automatically converts JavaScript expressions', () => {
    const graph = toResourceGraph(definition, resourceBuilder, (schema, resources) => ({
      ready: resources.deployment.status.readyReplicas > 0
    }));
    
    const yaml = graph.toYaml();
    expect(yaml).toContain('ready: ${resources.deployment.status.readyReplicas > 0}');
  });
});
```

## 10. Performance Optimizations

### 10.1. Compilation Caching

```typescript
class CompilationCache {
  private functionCache = new Map<string, CompositionAnalysisResult<any>>();
  private expressionCache = new Map<string, CelConversionResult>();
  
  getCachedFunction<TStatus>(
    functionKey: string
  ): CompositionAnalysisResult<TStatus> | null {
    return this.functionCache.get(functionKey) || null;
  }
  
  setCachedFunction<TStatus>(
    functionKey: string,
    result: CompositionAnalysisResult<TStatus>
  ): void {
    this.functionCache.set(functionKey, result);
  }
  
  getCachedExpression(expressionKey: string): CelConversionResult | null {
    return this.expressionCache.get(expressionKey) || null;
  }
  
  setCachedExpression(expressionKey: string, result: CelConversionResult): void {
    this.expressionCache.set(expressionKey, result);
  }
  
  generateFunctionKey(fn: Function, resources: Record<string, Enhanced<any, any>>): string {
    const functionSource = fn.toString();
    const resourceKeys = Object.keys(resources).sort().join(',');
    return `${this.hashString(functionSource)}-${this.hashString(resourceKeys)}`;
  }
  
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }
}
```

This design provides a comprehensive foundation for automatic JavaScript-to-CEL conversion throughout TypeKro, with enhanced debugging capabilities and performance optimizations.