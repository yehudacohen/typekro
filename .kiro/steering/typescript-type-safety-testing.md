# TypeScript Type Safety Testing Guidelines

## Core Principle

When building TypeScript libraries that emphasize type safety and developer experience, our tests must validate that the type system actually works as intended. Tests should demonstrate real-world usage patterns without circumventing the type system.

## Rules for Type-Safe Testing

### ❌ NEVER Use Type Assertions in Tests
```typescript
// BAD - This bypasses the type system we're trying to validate
const result = someFunction(value as any);
const ref = resource.status.field as SomeType;
```

### ✅ ALWAYS Test Real Type Safety
```typescript
// GOOD - This validates that types actually work
const result = someFunction(value); // Should compile without assertions
const ref = resource.status.field; // Should be properly typed
```

### ❌ NEVER Cast Away Type Errors
```typescript
// BAD - Hiding type issues that users will encounter
DATABASE_HOST: database.status.podIP as any
selector: { app: deploy.metadata?.labels?.app as any }
```

### ✅ ALWAYS Use Natural TypeScript Patterns
```typescript
// GOOD - This is how real users would write code
DATABASE_HOST: database.status.podIP
selector: { app: deploy.metadata?.labels?.app }
```

## Testing Type Safety Scenarios

### 1. Cross-Resource References
Test that references between resources work naturally:
```typescript
const database = deployment({ name: 'db', image: 'postgres' });
const webapp = deployment({
  name: 'web',
  image: 'nginx',
  env: {
    // This should compile and be type-safe
    DB_HOST: database.status.podIP
  }
});
```

### 2. IDE Experience Validation
Tests should validate what developers see in their IDE:
```typescript
// The type system should provide autocomplete and error checking
const deploy = deployment({ name: 'app', image: 'nginx' });

// These should all be properly typed without assertions
expect(deploy.metadata?.name).toBe('app');
expect(deploy.spec?.replicas).toBe(1);

// References should be typed correctly
const statusRef = deploy.status.replicas;
expect(isResourceReference(statusRef)).toBe(true);
```

### 3. Error Scenarios
Test that the type system prevents common mistakes:
```typescript
// These should cause TypeScript compilation errors:
// deployment({ name: 'test' }); // Missing required 'image'
// service({ name: 'svc' }); // Missing required 'ports'
```

## Test Structure Guidelines

### Use Real-World Patterns
```typescript
describe('Developer Experience', () => {
  it('should support natural cross-resource references', () => {
    const db = deployment({ name: 'database', image: 'postgres' });
    const api = deployment({
      name: 'api',
      image: 'node',
      env: {
        DATABASE_URL: db.status.podIP // Natural, no casting
      }
    });
    
    // Validate the reference was created correctly
    const dbRef = api.spec?.template?.spec?.containers?.[0]?.env?.find(
      e => e.name === 'DATABASE_URL'
    )?.value;
    
    expect(isResourceReference(dbRef)).toBe(true);
  });
});
```

### Test Compilation Success
```typescript
describe('Type Safety', () => {
  it('should compile without type assertions', () => {
    // This test passes if TypeScript compilation succeeds
    const stack = createCompleteStack(); // No 'as any' anywhere
    expect(stack).toBeDefined();
  });
});
```

## Why This Matters

1. **Real User Experience**: Tests should mirror how actual developers will use the library
2. **Type System Validation**: We need to prove our types actually work, not bypass them
3. **IDE Experience**: Autocomplete, error checking, and refactoring should work naturally
4. **Regression Prevention**: Type-safe tests catch when we accidentally break the developer experience

## Enforcement

- Code reviews should flag any `as any`, `as unknown`, or similar type assertions in tests
- Tests that require type casting indicate a problem with the library design, not the test
- If a test needs type casting, the library API should be improved instead

Remember: **If our tests need `as any`, our users will too - and that defeats the purpose of TypeKro.**