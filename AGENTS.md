# ⚠️ CRITICAL: NEVER CREATE BACKUP FILES (.backup, .old, -backup.ts, etc.) - USE GIT FOR VERSION CONTROL!
# ⚠️ CRITICAL: NO DESTRUCTIVE GIT COMMANDS WITHOUT EXPLICIT USER PERMISSION!
#
# AGENT GUIDELINES - READ BEFORE MAKING ANY CHANGES

## QUICK REFERENCE (20-Line Summary)

### Build/Test Commands
- **Build**: `bun run build` (full build with lint/typecheck)
- **Test single file**: `bun test test/path/to/file.test.ts --timeout 10000`
- **Test unit only**: `bun run test` (excludes integration tests)
- **Test integration**: `bun run test:integration`
- **Lint**: `bun run lint` (check) / `bun run lint:fix` (auto-fix)
- **Typecheck**: `bun run typecheck` (all) / `bun run typecheck:lib` (src only)
- **Format**: `bun run format:fix`

### Code Style
- **Tool**: Use `bun` (never npm/yarn). Biome for linting/formatting.
- **Imports**: External libraries first, internal modules second, types last. Use `type` imports for types.
- **Format**: 2 spaces, single quotes, 100 char lines, trailing commas ES5, semicolons always
- **Types**: Strict TypeScript. No `as any` except in specific core files. No `!` assertions except tests.
- **Naming**: camelCase variables/functions, PascalCase types/interfaces, UPPER_SNAKE constants
- **Errors**: Custom error classes extending `TypeKroError`. Use structured error messages.
- **Patterns**: Use `createResource` pattern for factories. Follow `src/core/`, `src/factories/` structure.

### Resource Graph Creation (toResourceGraph)
- **Use proper CEL expressions**: `Cel.expr<Type>(resourceRef, operator)` or `Cel.expr<Type>('static_expression')`
- **Status expressions**: `Cel.expr<boolean>(resources.myResource?.status.field, ' == "Ready"')`
- **Multi-condition**: `Cel.expr<string>('condition ? "value1" : "value2"')`  
- **Templates**: `Cel.template('Hello %s', schema.spec.name)` for string interpolation
- **Resource references**: Use `resources.resourceKey?.status.field` in CEL expressions
- **Type safety**: Always specify CEL type: `Cel.expr<boolean>()`, `Cel.expr<string>()`, etc.

## CRITICAL RULES - NEVER VIOLATE THESE

### 1. NO BACKUP FILES OR WORKSPACE POLLUTION
- **NEVER** create `.backup`, `.backup2`, `.old`, etc. files anywhere in the workspace
- **NEVER** create temporary files in the workspace root (debug-*.js, test-*.ts, temp-*.md)
- **NEVER** create duplicate files with slight name variations (-enhanced.ts, -improved.ts, -timeout-fix.ts)
- Use git for version control, not manual backups
- Use `/tmp` or ask where to put temporary files
- Clean up after yourself in the same session

### 2. NO DESTRUCTIVE CHANGES WITHOUT PERMISSION
- **NEVER** run `git checkout --`, `git reset`, or `git revert` without explicit user approval
- **NEVER** delete files without asking first
- **NEVER** revert changes blindly without understanding what they contain
- **ALWAYS** check what changes contain before modifying them
- **ALWAYS** ask "What will this command do?" before running destructive git commands

### 3. CONTEXT-FIRST DEVELOPMENT (From steering/context-first-development.md)
- **NEVER** assume something is wrong without investigation
- **ALWAYS** understand why existing code was written that way
- **ALWAYS** read broader context: specs, tests, git history, comments
- **ALWAYS** consider trade-offs and constraints that led to current implementation
- Ask: "Why does this code exist?" before changing it
- Ask: "What would break if I changed this?" before modifying
- Ask: "Is this the right place to make the change?"

### 4. FIX ROOT PROBLEMS, NOT SYMPTOMS (From steering/fix-root-problems.md)
- **NEVER** change test expectations to match broken code
- **NEVER** disable functionality to make tests pass (e.g., `waitForReady: false`)
- **ALWAYS** fix implementation to meet test requirements  
- **NEVER** mask problems with `as any` or commenting out tests
- **ALWAYS** ask "What is the test trying to validate?" when tests fail
- **ALWAYS** identify root cause in implementation, not tests
- Only change tests when requirements legitimately changed

### 5. FOLLOW CODEBASE STRUCTURE (From steering/codebase-structure.md)
- **FOLLOW** established directory structure in `src/core/`, `src/factories/`, etc.
- **USE** consistent import patterns: external libraries first, internal modules second, types last
- **AVOID** circular dependencies - check with `bunx madge --circular --extensions ts src/`
- **USE** `createResource` pattern for new factory functions
- **PLACE** new factories in appropriate category directories
- **EXPORT** properly through index files

### 6. USE CORRECT TOOLING (From steering/build-and-test-tooling.md)
- **ALWAYS** use `bun` instead of `npm`, `yarn`, or `pnpm`
- **USE** `bun install`, `bun add`, `bun run test`, etc.
- **NEVER** create package-lock.json or yarn.lock files
- **USE** `bun test` for running tests
- **FOLLOW** project's established package.json scripts

### 7. UNDERSTAND KEY ARCHITECTURAL PRINCIPLES

#### Magic Proxy System (From steering/magic-proxy-system.md)
- **NEVER** modify composition function signatures without understanding proxy implications
- **UNDERSTAND** that schema references are automatically `KubernetesRef` objects at runtime
- **TRUST** the existing `RefOrValue<T>` system - it handles all cases correctly
- **VALIDATION** belongs in serialization, not in composition functions

#### Status Builder Patterns (From steering/status-builder-patterns.md)
- **ONLY** use supported patterns: direct resource references, CEL expressions, CEL templates
- **NEVER** use JavaScript fallback patterns like `||` operators in status builders
- **USE** `Cel.expr()` for complex logic, `Cel.template()` for string construction
- **REFERENCE** complete-webapp.ts as the canonical example

#### TypeScript Type Safety (From steering/typescript-type-safety-testing.md)
- **NEVER** use `as any` or type assertions in tests or production code
- **ALWAYS** test real type safety - code should compile without casting
- **VALIDATE** that the type system provides proper IDE experience
- **TESTS** should mirror how real developers will use the library

### 8. ASK BEFORE MAJOR CHANGES
- **ALWAYS** ask before modifying existing core files
- **ALWAYS** ask before creating new files in src/
- **ALWAYS** ask before changing build/config files
- **ALWAYS** show the user what you plan to change and get approval
- **ALWAYS** explain the reasoning behind the change

## ALLOWED ACTIONS WITHOUT ASKING
- Reading files and understanding code structure
- Running tests with appropriate timeouts (`bun test`)
- Creating files in `/tmp` or clearly designated temp directories
- Making small, targeted fixes to obvious bugs (with clear explanation)
- Following established patterns for new factory functions
- Organizing imports with existing scripts
- Adding timeout configurations to prevent hanging operations
- Improving error reporting without changing core logic

## WORKFLOW FOR CHANGES
1. **Investigate Context**: Read related code, tests, specs, git history
2. **Understand Current Implementation**: Why was it written this way?
3. **Identify Root Problem**: Is this the real issue or a symptom?
4. **Design Proper Solution**: Address root cause, not symptoms
5. **Get User Approval**: Explain what you want to change and why
6. **Make Minimal Changes**: Follow established patterns and structure
7. **Test Changes**: Ensure tests pass and behavior is correct
8. **Clean Up**: Remove any temporary files immediately

## RED FLAGS - STOP AND ASK FOR HELP
- Tests are failing and you want to change test expectations
- You want to disable features to make tests pass (`waitForReady: false`, skipping tests)
- You want to add `as any` type assertions
- You're creating backup files or duplicate implementations
- You're running destructive git commands
- You want to ignore existing codebase patterns
- Code uses complex workarounds you don't understand
- You're about to skip or comment out failing tests
- You're considering modifying composition function signatures
- You want to use JavaScript patterns in status builders (||, template literals)

## IF YOU MAKE A MISTAKE
1. **Stop immediately** - don't compound the mistake
2. **Assess what you broke** - check git status and understand impact  
3. **Explain honestly** what happened and what you did wrong
4. **Ask for guidance** on how to fix it properly
5. **Learn from it** - update your approach to prevent similar mistakes

## ENFORCEMENT CHECKLIST
Before making any change, ask yourself:
- [ ] Do I understand why the current code exists?
- [ ] Am I fixing the root problem or masking symptoms?
- [ ] Am I following the established codebase structure?
- [ ] Am I using the correct tooling (bun, not npm)?
- [ ] Have I asked permission for this change?
- [ ] Will this change break existing functionality?
- [ ] Am I creating any backup files or workspace pollution?
- [ ] Am I respecting the magic proxy system architecture?
- [ ] Am I using only supported status builder patterns?
- [ ] Will my tests compile without type assertions?
- [ ] Am I enabling all functionality in tests (`waitForReady: true`)?

## CREATING RESOURCE GRAPHS WITH toResourceGraph()

### Basic Structure
```typescript
const myGraph = toResourceGraph(
  {
    name: 'my-resource-graph',
    apiVersion: 'example.com/v1alpha1', 
    kind: 'MyResource',
    spec: type({ /* arktype schema */ }),
    status: type({ /* arktype schema */ })
  },
  // Resource builder function
  (schema) => ({
    resourceKey: someFactory({ /* config */ }),
    anotherResource: anotherFactory({ /* config */ })
  }),
  // Status builder function  
  (schema, resources) => ({
    phase: Cel.expr<string>('some_expression'),
    readyReplicas: resources.resourceKey?.status.readyReplicas
  })
);
```

### CEL Expression Patterns (CRITICAL)
- **ALWAYS** specify type: `Cel.expr<boolean>()`, `Cel.expr<string>()`, `Cel.expr<number>()`
- **Enhanced resource references**: `resources.resourceKey.status.field` (NO `?.` - Enhanced types are NonOptional)
- **Comparisons**: `Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0')`
- **Equality**: `Cel.expr<boolean>(resources.helmrelease.status.phase, ' == "Ready"')`
- **Conditionals**: `Cel.expr<string>(resources.resource.status.field, ' == "value" ? "result1" : "result2"')`
- **Static values**: `Cel.expr<string>\`'static_value'\`` (backticks + quotes for static strings)
- **Templates**: `Cel.template('Hello %s', schema.spec.name)`

### Status Builder Rules
- **Resource keys**: Use exact keys from resource builder return object
- **Mixed types**: Some resources return `DeploymentClosure`, others return `Enhanced<Spec,Status>`
- **yamlFile resources**: Don't have standard status - use static values or other resources for status
- **HelmRelease resources**: Have proper `status.phase` field - use CEL expressions
- **Enhanced resources**: Reference like `resources.myDeployment.status.readyReplicas` (NO `?.` - NonOptional types)

### Common Patterns
```typescript
// Phase based on HelmRelease status (proper Enhanced syntax)
phase: Cel.expr<'Pending' | 'Installing' | 'Ready' | 'Failed'>(
  resources.kroHelmRelease.status.phase, ' == "Ready" ? "Ready" : "Installing"'
)

// Boolean readiness (Enhanced types - no ?.)
ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0')

// Static string values
phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,

// Static fallbacks for yamlFile resources
fluxReady: true, // yamlFile doesn't have status, assume ready

// Comparison with schema values
webAppReady: Cel.expr<boolean>(resources.webapp.status.readyReplicas, ' == ', resources.webapp.spec.replicas)
```

### What NOT to Do
- ❌ `resources.resource?.status.field` (Enhanced types are NonOptional - no `?.`)
- ❌ `Cel.expr(resources.resource.status.field == "value")` (comparison should be in CEL operator parameter)
- ❌ Missing type parameters: `Cel.expr()` (always specify `<boolean>`, `<string>`, etc.)
- ❌ Using JavaScript operators: `resources.a.ready || false` (use CEL expressions)
- ❌ Accessing non-existent status on yamlFile resources (they return DeploymentClosure, not Enhanced)

## PROJECT-SPECIFIC CONTEXT

### TypeKro is a Complex Type System Library
- **This is production infrastructure code** - changes affect real deployments
- **Type safety is paramount** - the entire value proposition depends on it
- **Performance matters** - this runs in CI/CD pipelines and production deployments
- **The magic proxy system is subtle** - seemingly simple changes can break everything
- **CEL integration is complex** - status builders have specific serialization requirements

### Common Issues You'll Encounter
- **Hanging operations**: Usually need timeouts, not feature disabling
- **Type errors**: Usually need API improvements, not `as any` casts
- **Test failures**: Usually need implementation fixes, not test changes
- **Serialization issues**: Usually need better preservation of function references
- **Circular dependencies**: Usually need restructuring, not workarounds

### When in Doubt
- **Read the specs** in `.kiro/specs/` for context
- **Check the steering docs** in `.kiro/steering/` for architectural principles
- **Look at working examples** like `complete-webapp.ts`
- **Ask the user** - they understand the domain deeply

Remember: **The user's codebase is their professional work. Treat it with the same respect you would want for your own code. When in doubt, ask first.**
