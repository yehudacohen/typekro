# Context-First Development Guidelines

## Core Principle

Before making any changes to existing code, always understand the broader context and design decisions that led to the current implementation. What appears to be a "bug" or "wrong" implementation may actually be a deliberate design choice with important reasons.

## Rules for Context-First Development

### ❌ NEVER Assume Something is Wrong Without Investigation
```typescript
// BAD - Immediately "fixing" what looks wrong
// Seeing: value: value as any
// Thinking: "This is bad, let me remove the cast"
// Reality: The cast might be necessary for serialization or compatibility
```

### ✅ ALWAYS Investigate Before Changing
```typescript
// GOOD - Understanding the context first
// 1. Why was this cast added?
// 2. What problem does it solve?
// 3. What breaks if I remove it?
// 4. Is there a better solution that maintains the original intent?
```

## Investigation Process

### 1. Read the Broader Context
- Check the spec/design documents for the feature
- Look at related tests to understand expected behavior
- Review git history to see why the code was written this way
- Check for comments explaining the reasoning

### 2. Understand the Trade-offs
- What problem was the original code solving?
- What constraints led to this implementation?
- Are there compatibility requirements?
- What would break if this changed?

### 3. Consider the User Experience
- How do real users interact with this code?
- What would the impact be on existing users?
- Does the "fix" actually improve the developer experience?
- Are there migration concerns?

### 4. Look for Systemic Issues
- Is this part of a larger pattern?
- Are there related issues that should be addressed together?
- Would fixing this create inconsistencies elsewhere?
- Is this the right level to make the change?

## Examples of Context-First Thinking

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

## Red Flags That Indicate Need for Context Investigation

- Code that uses `as any` or type assertions
- Patterns that seem inconsistent with the rest of the codebase
- Complex workarounds or unusual implementations
- Code that has been modified multiple times recently
- Functionality that works but "looks wrong"

## Questions to Ask Before Making Changes

1. **Why does this code exist?** - What problem was it solving?
2. **What would break if I changed this?** - Impact analysis
3. **Is this the right place to make the change?** - Architectural considerations
4. **What would the original author say?** - Understanding intent
5. **How does this fit into the larger system?** - Systemic thinking
6. **What are the trade-offs?** - Nothing is free
7. **Is there a spec or design document?** - Documented requirements
8. **What do the tests expect?** - Behavioral contracts

## When Context Investigation is Complete

Only after understanding the full context should you:

1. **Confirm the problem** - Is there actually an issue?
2. **Identify the root cause** - What's the real problem?
3. **Design a proper solution** - Address the root cause, not symptoms
4. **Consider alternatives** - Are there better approaches?
5. **Plan the implementation** - How to change without breaking things
6. **Update related documentation** - Keep everything consistent

## Enforcement

- Before making any change, document your understanding of why the current code exists
- If you can't explain why something was implemented a certain way, investigate more
- Code reviews should ask "Why was this changed?" not just "Does this work?"
- Changes should reference the context investigation in commit messages
- If investigation reveals the current code is correct, document that too

Remember: **Good code often looks simple, but the path to that simplicity involved understanding complex trade-offs. Respect that complexity before changing it.**