# Development Standards

## Core Philosophy

TypeKro is a production project that emphasizes context-first development, complete implementations, and root problem solving. All code must meet production quality standards while respecting existing design decisions and their underlying rationale.

### Context-First Development

Before making any changes to existing code, always understand the broader context and design decisions that led to the current implementation. What appears to be a "bug" or "wrong" implementation may actually be a deliberate design choice with important reasons.

### Production Quality from Day One

All code must meet production quality standards with complete, robust implementations. There are no shortcuts, test implementations, or "TODO: come back to this later" approaches.

### Fix Root Problems, Not Symptoms

When encountering failing tests or issues, always fix the underlying problem rather than masking symptoms. Tests exist to validate that the system works correctly - if tests are failing, it usually means the implementation is wrong, not the tests.

## Investigation Process

### Context Investigation Requirements

Before making any changes to existing code:

#### 1. Read the Broader Context
- Check the spec/design documents for the feature
- Look at related tests to understand expected behavior
- Review git history to see why the code was written this way
- Check for comments explaining the reasoning

#### 2. Understand the Trade-offs
- What problem was the original code solving?
- What constraints led to this implementation?
- Are there compatibility requirements?
- What would break if this changed?

#### 3. Consider the User Experience
- How do real users interact with this code?
- What would the impact be on existing users?
- Does the "fix" actually improve the developer experience?
- Are there migration concerns?

#### 4. Look for Systemic Issues
- Is this part of a larger pattern?
- Are there related issues that should be addressed together?
- Would fixing this create inconsistencies elsewhere?
- Is this the right level to make the change?

### Questions to Ask Before Making Changes

1. **Why does this code exist?** - What problem was it solving?
2. **What would break if I changed this?** - Impact analysis
3. **Is this the right place to make the change?** - Architectural considerations (see [Architecture Guide](architecture-guide.md))
4. **What would the original author say?** - Understanding intent
5. **How does this fit into the larger system?** - Systemic thinking (see [Architecture Guide](architecture-guide.md))
6. **What are the trade-offs?** - Nothing is free
7. **Is there a spec or design document?** - Documented requirements
8. **What do the tests expect?** - Behavioral contracts (see [Testing Guidelines](testing-guidelines.md))

## Problem-Solving Methodology

### Test-Driven Problem Solving

When encountering failing tests, follow the comprehensive [Testing Guidelines](testing-guidelines.md) for proper test execution and validation approaches:

#### ❌ NEVER Change Test Expectations to Match Broken Code
```typescript
// BAD - Masking the real problem
// Test expects: 'readyReplicas: ${webappDeployment.status.readyReplicas}'
// Code produces: 'readyReplicas: ${""}'
// Wrong solution: Change test to expect '${""}'
```

#### ✅ ALWAYS Fix the Implementation to Meet Test Requirements
```typescript
// GOOD - Fix the serialization to produce correct CEL expressions
// Test expects: 'readyReplicas: ${webappDeployment.status.readyReplicas}'
// Fix: Ensure resource has proper id and is referenced correctly in status builder
```

### When Tests Fail, Ask These Questions

1. **What is the test trying to validate?** - Understand the intended behavior
2. **Why is the test failing?** - Identify the root cause in the implementation
3. **What would users expect?** - Consider the developer experience
4. **Is this a regression?** - Did this work before and break due to changes?
5. **What's the proper fix?** - Address the implementation, not the test

### Specific Anti-Patterns to Avoid

#### ❌ NEVER Disable Functionality to Make Tests Pass
```typescript
// BAD - This hides the real problem
const factory = graph.factory('direct', {
    waitForReady: false, // This is cheating!
});
```

#### ✅ ALWAYS Fix the Underlying Issues
```typescript
// GOOD - Fix the serialization to preserve readiness evaluators
const factory = graph.factory('direct', {
    waitForReady: true, // This should work properly
});
```

### Root Cause Analysis Process

When encountering complex problems:

1. **Understand the Root Cause**: Don't work around errors, fix them
2. **Research Proper Solutions**: Find the correct way to implement features
3. **Implement Complete Solutions**: No partial implementations
4. **Test Thoroughly**: Validate all code paths and edge cases (see [Testing Guidelines](testing-guidelines.md))
5. **Document Decisions**: Explain why specific approaches were chosen

## File Management Standards

### File Operations
- **ALWAYS use `rm` command in shell for file deletion** - Never use file tools to delete files. Use `executeBash` with `rm` command so the user can approve deletions.
- **NEVER use `sed` for bulk text replacements** - `sed` commands often introduce syntax errors and break code structure. Always use `strReplace` tool for precise, controlled replacements.
- **Go slowly and methodically** - Make one change at a time and verify it works before proceeding to the next change.
- Clean up temporary debug files after use
- Ask for approval before deleting files that might contain important information
- Follow the build and development practices outlined in [Tooling Requirements](tooling-requirements.md)

### Text Replacement Guidelines
- **Use `strReplace` tool exclusively** - This ensures exact matching and prevents syntax errors
- **Make small, targeted changes** - Replace one pattern at a time rather than attempting bulk operations
- **Verify each change** - Run typecheck or tests after each replacement to ensure nothing broke
- **Never use shell text processing tools** - Avoid `sed`, `awk`, `grep -r` with replacements, etc. for code modifications

## Red Flags Requiring Investigation

### Code Patterns That Need Context Investigation
- Code that uses `as any` or type assertions
- Patterns that seem inconsistent with the rest of the codebase
- Complex workarounds or unusual implementations
- Code that has been modified multiple times recently
- Functionality that works but "looks wrong"

### Test-Related Red Flags That Indicate Masking Problems
- Changing test expectations without understanding why they were written
- Adding `as any` type assertions to make TypeScript errors go away
- Commenting out or skipping failing tests
- Reducing test coverage to avoid failures
- Making tests less strict to accommodate broken behavior

## Examples of Proper Context-First Thinking

### Type Casting in Serialization
```typescript
// What looks wrong:
env: config.env ? Object.entries(config.env).map(([name, value]) => ({ 
    name, 
    value: value as any 
})) : [];

// Context investigation reveals:
// 1. Environment variables must be strings at runtime
// 2. But we want to support KubernetesRef<string> and CelExpression at compile time
// 3. The serialization layer handles the conversion
// 4. The cast is a bridge between compile-time and runtime types
// 5. Removing it would break the type system or serialization

// Better solution: Improve the type system, not remove the cast
```

### File Organization
```typescript
// What looks wrong:
// Creating test files at package root: packages/typekro/test-something.ts

// Context investigation reveals:
// 1. Project has established conventions in .kiro/steering/project-conventions.md
// 2. Tests belong in test/ directory with proper structure
// 3. Temporary files should be in temp/ or cleaned up
// 4. Breaking conventions makes the codebase harder to maintain

// Better solution: Follow established patterns, understand why they exist
```

## When Context Investigation is Complete

Only after understanding the full context should you:

1. **Confirm the problem** - Is there actually an issue?
2. **Identify the root cause** - What's the real problem?
3. **Design a proper solution** - Address the root cause, not symptoms
4. **Consider alternatives** - Are there better approaches?
5. **Plan the implementation** - How to change without breaking things
6. **Update related documentation** - Keep everything consistent

## Exception: When Test Changes Are Appropriate

Test expectations should only change when:

1. **Requirements changed** - The intended behavior has legitimately changed
2. **Test was incorrect** - The original test had wrong expectations
3. **API evolution** - Planned breaking changes with proper migration
4. **Better testing approach** - Improving test quality while maintaining behavior validation

In all cases, document why the test change is appropriate and ensure the new behavior is actually correct.

## Enforcement

### Context Investigation
- Before making any change, document your understanding of why the current code exists
- If you can't explain why something was implemented a certain way, investigate more
- Code reviews should ask "Why was this changed?" not just "Does this work?"
- Changes should reference the context investigation in commit messages
- If investigation reveals the current code is correct, document that too

### Test-Driven Problem Solving
- Code reviews should question any changes to test expectations
- If a test expectation changes, there must be a clear explanation of why the old behavior was wrong
- Implementation changes should be preferred over test changes
- When both test and implementation need updates, do them together with clear reasoning
- Code reviews should reject any changes that disable functionality to make tests pass
- Tests should maintain full functionality validation unless there's a specific documented reason

Remember: **Good code often looks simple, but the path to that simplicity involved understanding complex trade-offs. Respect that complexity before changing it. Tests are the specification of how the system should work - if tests fail, fix the system, not the specification.**
## Cod
e Quality and Implementation Standards

### Production Implementation Requirements

#### ❌ NEVER Use Placeholder Implementations
```typescript
// BAD - Placeholder that might be forgotten
function complexFeature() {
  // TODO: Implement this properly later
  return { status: 'mock' };
}

// BAD - Test/mock implementation in production code
function readinessEvaluator(resource: any) {
  return { ready: true }; // Mock for now
}
```

#### ✅ ALWAYS Implement Complete Solutions
```typescript
// GOOD - Complete implementation with proper error handling
function complexFeature(config: ComplexConfig): ComplexResult {
  validateConfig(config);
  
  try {
    const result = processComplexLogic(config);
    return {
      status: 'success',
      data: result,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    throw new ComplexFeatureError(`Failed to process: ${error.message}`, config);
  }
}

// GOOD - Complete readiness evaluator with real logic
function readinessEvaluator(resource: KubernetesResource): ReadinessResult {
  const conditions = resource.status?.conditions || [];
  const readyCondition = conditions.find(c => c.type === 'Ready');
  
  if (!readyCondition) {
    return {
      ready: false,
      message: 'No Ready condition found',
      details: { availableConditions: conditions.map(c => c.type) }
    };
  }
  
  const isReady = readyCondition.status === 'True';
  return {
    ready: isReady,
    message: isReady ? 'Resource is ready' : readyCondition.message || 'Resource not ready',
    lastTransition: readyCondition.lastTransitionTime
  };
}
```

### Implementation Standards

#### Complete Error Handling
- Every function must handle all possible error cases
- Provide meaningful error messages with context
- Include recovery suggestions where appropriate
- Use proper error types and hierarchies

#### Comprehensive Validation
- Validate all inputs at function boundaries
- Provide clear validation error messages
- Handle edge cases and boundary conditions
- Test validation with invalid inputs

#### Full Type Safety
- No `any` types in production code without explicit justification
- Complete interface definitions for all data structures
- Proper generic constraints and type guards
- Full TypeScript strict mode compliance

#### Robust Resource Handling
- Proper resource cleanup and disposal
- Handle resource unavailability gracefully
- Implement proper retry logic where needed
- Monitor resource usage and limits

#### Production Logging
- Structured logging with appropriate levels
- Include correlation IDs for tracing
- Log all significant operations and errors
- Provide debugging information without exposing secrets

### Development Process Standards

#### No Shortcuts or Workarounds
- Don't use mocks or stubs in production code paths
- Don't skip error handling "for now"
- Don't leave TODO comments in merged code
- Don't implement partial features with plans to "finish later"

#### Code Review Standards
- All code must be complete and production-ready
- No placeholders or incomplete implementations
- Proper error handling and validation
- Complete test coverage for new functionality
- Documentation for public APIs

### Quality Gates

#### Before Implementation
- Understand the complete requirements
- Research the proper implementation approach
- Plan for all error cases and edge conditions
- Design complete interfaces and data models

#### During Implementation
- Implement complete functionality, not partial solutions
- Handle all error cases as they arise
- Write tests as you implement features
- Document complex logic and decisions

#### Before Merge
- All functionality is complete and tested
- No TODO comments or placeholder code
- All error cases are handled
- Documentation is complete and accurate
- Performance is acceptable for production use

### Anti-Patterns to Avoid

#### Incomplete Implementations
```typescript
// BAD - Incomplete with plans to "finish later"
function deployResource(resource: Resource) {
  // Basic deployment works, TODO: add error handling
  kubectl.apply(resource);
}
```

#### Mock/Test Code in Production
```typescript
// BAD - Mock implementation that might be forgotten
function getResourceStatus(resource: Resource) {
  if (process.env.NODE_ENV === 'test') {
    return { ready: true }; // This could leak to production
  }
  // Real implementation
}
```

#### Swallowing Errors
```typescript
// BAD - Hiding errors instead of handling them
function riskyOperation() {
  try {
    complexOperation();
  } catch (error) {
    // Ignore errors for now, TODO: handle properly
  }
}
```

### Quality Enforcement

#### Code Reviews Must Verify
- Complete implementation of all features
- Proper error handling throughout
- No placeholder or TODO code
- Full test coverage
- Production-ready performance

#### No Exceptions
- "It's just a prototype" - No, it's production code
- "We'll fix it later" - Fix it now
- "It works for the happy path" - Handle all paths
- "The tests pass" - Tests must be comprehensive

#### Technical Debt
- No intentional technical debt without explicit approval
- All shortcuts must be documented and tracked
- Regular reviews to ensure no incomplete code exists
- Immediate fixes for any discovered incomplete implementations

### Success Metrics

- Zero TODO comments in merged code
- Zero known incomplete implementations
- All error paths tested and handled
- Complete documentation for all public APIs
- Production-ready performance characteristics##
 Advanced Problem-Solving Methodology

### Root Cause Analysis Framework

When encountering complex problems, follow this systematic approach:

#### 1. Problem Identification and Scoping
- **Define the problem clearly**: What exactly is not working as expected?
- **Identify the scope**: Is this a single component issue or systemic?
- **Gather evidence**: Collect logs, error messages, and reproduction steps
- **Document the symptoms**: What are the observable effects?

#### 2. Context and History Analysis
- **Review recent changes**: What has changed that might have caused this?
- **Check related systems**: Are there dependencies that might be affected?
- **Examine the timeline**: When did this problem first appear?
- **Look for patterns**: Is this happening consistently or intermittently?

#### 3. Hypothesis Formation
- **Generate multiple hypotheses**: Don't fixate on the first idea
- **Prioritize by likelihood**: Start with the most probable causes
- **Consider edge cases**: Sometimes the problem is in an unexpected area
- **Think systemically**: Could this be a symptom of a larger issue?

#### 4. Systematic Investigation
- **Test hypotheses methodically**: Validate or eliminate each possibility
- **Use debugging tools**: Leverage logging, profiling, and monitoring
- **Isolate variables**: Change one thing at a time to identify the cause
- **Document findings**: Keep track of what you've tested and learned

#### 5. Solution Design and Implementation
- **Address the root cause**: Don't just fix symptoms
- **Consider side effects**: How might your fix affect other parts of the system?
- **Plan for testing**: How will you verify the fix works?
- **Think about prevention**: How can you prevent this problem in the future?

### Specific Problem-Solving Scenarios

#### Serialization and Type Issues
When encountering serialization problems:

```typescript
// Problem: Resource references serialize as empty strings instead of CEL expressions
// Investigation process:
// 1. Check what the test expects vs what's produced
// 2. Trace the serialization path through the code
// 3. Identify where the reference information is lost
// 4. Understand the intended behavior from design docs
// 5. Fix the serialization logic, not the test expectations

// The test expects this YAML output:
// readyReplicas: ${webappDeployment.status.readyReplicas}

// But gets this:
// readyReplicas: ${""}

// Root cause analysis reveals:
// - Resource missing required 'id' field for cross-references
// - References need proper resource ID to generate correct CEL expressions
// - Solution: Ensure all resources have proper id field and are referenced correctly
```

#### Readiness Evaluation Problems
When tests timeout waiting for readiness:

```typescript
// Problem: Tests timing out on readiness checks
// Investigation process:
// 1. Verify readiness evaluators are attached to resources
// 2. Check if evaluators survive serialization/deserialization
// 3. Trace the deployment pipeline to find where evaluators are lost
// 4. Understand the Alchemy integration impact
// 5. Fix the preservation of function references

// Common root causes:
// 1. JSON.parse(JSON.stringify()) strips out function properties
// 2. Resources not properly attached to readiness evaluators
// 3. Alchemy integration breaking the readiness evaluation chain

// Solution: Preserve readiness evaluators through the entire pipeline
```

#### API Signature and Compatibility Issues
When API changes break existing functionality:

```typescript
// Problem: Tests fail after API changes
// Investigation process:
// 1. Understand what the API change was intended to accomplish
// 2. Identify all the places that depend on the old API
// 3. Determine if the change is necessary or if there's a better approach
// 4. Plan a migration strategy that maintains backward compatibility
// 5. Update implementation and tests together with proper migration path

// Wrong approach: Remove or skip failing tests
// Right approach: Update implementation to maintain backward compatibility
// Or: Update tests AND implementation together with proper migration path
```

### Advanced Investigation Techniques

#### Code Archaeology
When investigating legacy or complex code:

1. **Git blame and history**: Understand when and why code was written
2. **Commit message analysis**: Look for context in commit descriptions
3. **Related issue tracking**: Check if there are tickets explaining the rationale
4. **Code comments and documentation**: Look for explanations of design decisions
5. **Test analysis**: Understand what behavior the tests are validating

#### System Thinking
When problems span multiple components:

1. **Dependency mapping**: Understand how components interact
2. **Data flow analysis**: Trace how information moves through the system
3. **State management**: Understand how state changes affect behavior
4. **Timing and concurrency**: Consider race conditions and async behavior
5. **Resource constraints**: Check for memory, CPU, or network limitations

#### Performance and Scalability Issues
When encountering performance problems:

1. **Profiling and measurement**: Use tools to identify bottlenecks
2. **Load testing**: Understand behavior under different conditions
3. **Resource monitoring**: Track memory, CPU, and I/O usage
4. **Algorithm analysis**: Consider the computational complexity
5. **Caching and optimization**: Identify opportunities for improvement

### Problem Prevention Strategies

#### Design for Debuggability
- **Comprehensive logging**: Log important state changes and decisions
- **Error context**: Include relevant information in error messages
- **Monitoring and metrics**: Track system health and performance
- **Testing coverage**: Ensure all code paths are tested
- **Documentation**: Explain complex logic and design decisions

#### Defensive Programming
- **Input validation**: Validate all inputs at system boundaries
- **Error handling**: Handle all possible error conditions gracefully
- **Resource management**: Properly manage memory, files, and connections
- **Graceful degradation**: Design systems to fail safely
- **Circuit breakers**: Prevent cascading failures

#### Continuous Improvement
- **Post-mortem analysis**: Learn from problems when they occur
- **Pattern recognition**: Identify common types of issues
- **Tool improvement**: Invest in better debugging and monitoring tools
- **Knowledge sharing**: Document lessons learned for the team
- **Process refinement**: Improve development and deployment processes

### When to Escalate or Seek Help

#### Escalation Criteria
- **Time investment**: If investigation exceeds reasonable time bounds
- **System impact**: If the problem affects critical functionality
- **Knowledge gaps**: If you lack domain expertise for the problem area
- **Risk assessment**: If potential solutions carry significant risk
- **Resource constraints**: If you need additional tools or access

#### Effective Help-Seeking
- **Problem summary**: Clearly describe what you're trying to solve
- **Investigation summary**: Share what you've already tried
- **Specific questions**: Ask targeted questions rather than general requests
- **Context sharing**: Provide relevant background information
- **Reproduction steps**: Make it easy for others to understand the problem

Remember: **Effective problem-solving combines systematic investigation, root cause analysis, and systemic thinking. Always fix the underlying problem, not just the symptoms.**