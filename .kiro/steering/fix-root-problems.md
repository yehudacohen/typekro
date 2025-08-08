# Fix Root Problems, Don't Mask Them

## Core Principle

When encountering failing tests, always fix the underlying problem rather than changing test expectations to match broken behavior. Tests exist to validate that the system works correctly - if tests are failing, it usually means the implementation is wrong, not the tests.

## Rules for Test-Driven Problem Solving

### ❌ NEVER Change Test Expectations to Match Broken Code
```typescript
// BAD - Masking the real problem
// Test expects: 'readyReplicas: ${webapp-deployment.status.availableReplicas}'
// Code produces: 'readyReplicas: ${""}'
// Wrong solution: Change test to expect '${""}'
```

### ✅ ALWAYS Fix the Implementation to Meet Test Requirements
```typescript
// GOOD - Fix the serialization to produce correct CEL expressions
// Test expects: 'readyReplicas: ${webapp-deployment.status.availableReplicas}'
// Fix: Update serialization logic to convert resource references to proper CEL
```

## When Tests Fail, Ask These Questions

1. **What is the test trying to validate?** - Understand the intended behavior
2. **Why is the test failing?** - Identify the root cause in the implementation
3. **What would users expect?** - Consider the developer experience
4. **Is this a regression?** - Did this work before and break due to changes?
5. **What's the proper fix?** - Address the implementation, not the test

## Examples of Root Problem Fixing

### Status Field Serialization Issue
```typescript
// Problem: Resource references serialize as empty strings instead of CEL expressions
// Wrong approach: Change tests to expect empty strings
// Right approach: Fix serialization to convert references to proper CEL expressions

// The test expects this YAML output:
// readyReplicas: ${webapp-deployment.status.availableReplicas}

// But gets this:
// readyReplicas: ${""}

// Solution: Fix the serialization logic in src/core/serialization/
```

### API Signature Changes
```typescript
// Problem: Tests fail after API changes
// Wrong approach: Remove or skip failing tests
// Right approach: Update implementation to maintain backward compatibility
// Or: Update tests AND implementation together with proper migration path
```

## Red Flags That Indicate Masking Problems

- Changing test expectations without understanding why they were written
- Adding `as any` type assertions to make TypeScript errors go away
- Commenting out or skipping failing tests
- Reducing test coverage to avoid failures
- Making tests less strict to accommodate broken behavior

## Enforcement

- Code reviews should question any changes to test expectations
- If a test expectation changes, there must be a clear explanation of why the old behavior was wrong
- Implementation changes should be preferred over test changes
- When both test and implementation need updates, do them together with clear reasoning

## Exception: When Test Changes Are Appropriate

Test expectations should only change when:

1. **Requirements changed** - The intended behavior has legitimately changed
2. **Test was incorrect** - The original test had wrong expectations
3. **API evolution** - Planned breaking changes with proper migration
4. **Better testing approach** - Improving test quality while maintaining behavior validation

In all cases, document why the test change is appropriate and ensure the new behavior is actually correct.

Remember: **Tests are the specification of how the system should work. If tests fail, fix the system, not the specification.**