# YAML File Resources Spec Review

## Overall Assessment

The YAML file resources spec is **well-structured and comprehensive**, but has several **cohesion and clarity issues** that should be addressed before implementation continues.

## 🟢 **Strengths**

1. **Clear Requirements**: Requirements 1-12 are well-defined with acceptance criteria
2. **Solid Architecture**: Closure-based pattern is well-thought-out and future-extensible
3. **Comprehensive Examples**: Good code examples throughout the design document
4. **Implementation Reality**: Tasks align well with actual implementation status

## 🔴 **Critical Cohesion Issues**

### 1. **Inconsistent Terminology Throughout Spec**

**Issue**: The spec uses different terms for the same concepts across documents:
- "YAML file resources" vs "YAML resources" vs "YAML closures"
- "Deployment closures" vs "YAML deployment closures" vs "closures"
- "Factory functions" vs "factory-style functions" vs "YAML factories"

**Impact**: Confusing for developers implementing the spec
**Recommendation**: Standardize on one term per concept and create a glossary

### 2. **Design Document vs Requirements Misalignment**

**Requirements say**: "YAML files as TypeKro resources" (Req 1)
**Design Document says**: "YAML functions are NOT Enhanced<> resources"

**Issue**: This fundamental contradiction is confusing
**Recommendation**: Clarify that YAML functions create deployment closures, not TypeKro resources

### 3. **Mode Support Confusion**

**Requirements 11**: "Work in both Direct and Kro factory modes"
**Design Document**: Multiple conflicting statements about what works where

**Specific Confusion**:
- Design shows dynamic references work in Direct mode only
- Requirements imply full feature parity between modes
- Examples show different capabilities in different sections

**Recommendation**: Create a clear compatibility matrix

## 🟡 **Clarity Issues Needing Attention**

### 4. **Closure Execution Timing Ambiguity**

**Issue**: Multiple contradictory statements about when closures execute:
- "Level -1 (before all resources)" 
- "In parallel with Enhanced<> resources"
- "Pre-deployment execution"
- "During deployment phase"

**Recommendation**: Create a clear execution timeline diagram

### 5. **Bootstrap Workflow Complexity**

**Issue**: Requirements 7 describes a complex bootstrap workflow but the design doesn't clearly explain:
- Which components depend on which other components
- What happens if bootstrap fails partway through
- How to recover from failed bootstrap states

**Recommendation**: Add a bootstrap state machine diagram

### 6. **Error Handling Patterns Unclear**

**Issue**: Requirements mention error handling but design doesn't clearly explain:
- How YAML closure failures affect overall deployment
- Whether failed closures can be retried independently
- How rollback works when some closures succeed and others fail

### 7. **Reference Resolution Documentation Gap**

**Issue**: The spec mentions TypeKro references work in YAML closures but doesn't explain:
- How references are resolved in closure context
- What happens if referenced resources aren't ready yet
- How circular dependencies are handled

## 🔵 **Missing Architectural Clarity**

### 8. **Relationship to Enhanced<> Resources Unclear**

**Issue**: The spec doesn't clearly explain how YAML closures relate to the core TypeKro resource model:
- Do they participate in status hydration?
- How do they appear in dependency graphs?
- Can Enhanced<> resources reference closure outputs?

### 9. **Alchemy Integration Handwavy**

**Issue**: Multiple references to "alchemy integration" but no clear explanation of:
- What alchemy scope actually does for YAML resources
- When to use alchemy vs direct Kubernetes API
- How alchemy affects closure behavior

### 10. **Future Extensibility Scope Creep**

**Issue**: Design mentions "future closure types" (Terraform, Pulumi) but this creates scope confusion:
- Are we designing YAML resources or a general closure system?
- What constraints apply to all closure types vs YAML-specific ones?

## 📋 **Specific Technical Inconsistencies**

### 11. **Code Examples Don't Match Implementation**

**Design Document Example**:
```typescript
const yamlContent = await pathResolver.resolveContent(config.path);
```

**Actual Implementation**: 
```typescript
const resolvedContent = await pathResolver.resolveContent(config.path, config.name);
```

**Issue**: Method signatures don't match
**Action**: Update design examples to match actual implementation

### 12. **Type Definitions Incomplete**

**Design Document**: Shows `YamlDeploymentClosure` type
**Actual Implementation**: Uses `DeploymentClosure<AppliedResource[]>`

**Issue**: Type naming inconsistency
**Action**: Align type names between spec and implementation

### 13. **Git URL Format Inconsistency**

**Different sections show**:
- `git:github.com/org/repo/path/file.yaml@ref`
- `git:github.com/owner/repo/path@ref`
- `git:github.com/fluxcd/flux2/manifests/crds@main`

**Issue**: Inconsistent examples may confuse users
**Action**: Standardize Git URL examples

## 🎯 **Recommended Spec Improvements**

### Phase 1: Terminology Standardization (30 minutes)
1. Create a **Glossary section** defining key terms
2. **Search and replace** inconsistent terminology throughout
3. **Standardize code examples** to match implementation

### Phase 2: Architectural Clarification (45 minutes) 
1. **Add execution timeline diagram** showing closure vs resource deployment
2. **Create mode compatibility matrix** (Direct vs Kro capabilities)
3. **Clarify relationship** to Enhanced<> resources and status hydration

### Phase 3: Technical Alignment (15 minutes)
1. **Update code examples** to match actual implementation
2. **Fix type naming** inconsistencies  
3. **Standardize Git URL format** examples

### Phase 4: Bootstrap Workflow Clarity (30 minutes)
1. **Add bootstrap state diagram** showing dependencies
2. **Document failure scenarios** and recovery procedures
3. **Clarify error handling** for partial failures

## ✅ **What NOT to Change**

The following aspects of the spec are **excellent and should remain unchanged**:

1. **Core closure-based architecture** - well-designed and future-proof
2. **Requirements structure** - comprehensive and clear acceptance criteria
3. **Implementation task breakdown** - detailed and realistic
4. **Path resolution design** - comprehensive local/Git/HTTP support
5. **Level-based execution concept** - solves CRD establishment problem elegantly

## 🚀 **Priority Order for Fixes**

1. **HIGH**: Terminology standardization (confusing for implementers)
2. **HIGH**: Code example alignment (prevents copy-paste errors)
3. **MEDIUM**: Mode compatibility clarification (affects user experience)
4. **MEDIUM**: Execution timeline diagram (helps debugging)
5. **LOW**: Bootstrap workflow details (can be documented later)

The spec has a **solid foundation** but needs **consistency polish** before proceeding with remaining implementation tasks.