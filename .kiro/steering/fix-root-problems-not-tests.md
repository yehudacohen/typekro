# Fix Root Problems, Not Tests

## Core Principle

When tests are failing, **NEVER** modify the tests to make them pass by disabling functionality. Always fix the underlying code issue. Tests exist to validate that the system works correctly - if tests are failing, it means the implementation is broken, not the tests.

## Specific Anti-Patterns to Avoid

### ❌ NEVER Disable Readiness Checks to Make Tests Pass
```typescript
// BAD - This hides the real problem
const factory = await graph.factory('direct', {
    waitForReady: false, // This is cheating!
});
```

### ✅ ALWAYS Fix the Readiness Evaluator Issues
```typescript
// GOOD - Fix the serialization to preserve readiness evaluators
const factory = await graph.factory('direct', {
    waitForReady: true, // This should work properly
});
```

## The Real Problem

When tests are timing out waiting for readiness, it's usually because:

1. **Readiness evaluators are being lost during serialization** - `JSON.parse(JSON.stringify())` strips out function properties
2. **Resources are not properly attached to readiness evaluators** - The evaluators need to be preserved through the entire deployment pipeline
3. **Alchemy integration is breaking the readiness evaluation chain** - The resource registration process needs to maintain function references

## The Right Fix

1. **Preserve readiness evaluators through serialization**
2. **Ensure readiness evaluators are properly attached to deployed resources**
3. **Fix the Alchemy integration to maintain function references**
4. **Test with `waitForReady: true` to validate the full system**

## Enforcement

- Code reviews should reject any changes that disable readiness checks to make tests pass
- Tests should always use `waitForReady: true` unless there's a specific reason not to
- If readiness is timing out, fix the readiness evaluator preservation, don't disable the check
- The goal is a fully functional system, not passing tests with broken functionality

Remember: **Tests are the specification of how the system should work. If tests fail, fix the system, not the specification.**