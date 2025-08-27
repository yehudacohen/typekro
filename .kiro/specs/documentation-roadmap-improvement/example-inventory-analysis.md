# TypeKro Example Inventory Analysis

## Current Example Files Analysis

### `/examples/` Directory (18 TypeScript files)

#### ✅ HIGH VALUE - Keep and Update
1. **hero-example.ts** - ⭐ Perfect for homepage/hero section
   - **API**: kubernetesComposition (✅ correct API)
   - **Imports**: Correct pattern
   - **Status**: Compiles and runs successfully
   - **Learning Value**: Minimal, focused demo
   - **Issues**: None
   - **Action**: Keep as-is, use for homepage

2. **imperative-composition.ts** - ⭐ Comprehensive patterns showcase
   - **API**: kubernetesComposition (✅ correct API)
   - **Imports**: Correct pattern 
   - **Status**: Needs testing but looks good
   - **Learning Value**: Shows 3 different composition patterns progressively
   - **Issues**: None apparent
   - **Action**: Keep, make this a primary example

3. **complete-webapp.ts** - ⭐ Status builder showcase
   - **API**: toResourceGraph (❌ needs update to kubernetesComposition)
   - **Imports**: Correct factory imports
   - **Status**: Uses toResourceGraph API that needs updating
   - **Learning Value**: Demonstrates CEL expressions, status builders, complex relationships
   - **Issues**: API inconsistency
   - **Action**: Convert to kubernetesComposition, keep as advanced example

#### 🟡 MEDIUM VALUE - Fix or Remove
4. **basic-webapp.ts** - 🔧 Needs fixes
   - **API**: kubernetesComposition (✅ correct API)
   - **Imports**: Correct
   - **Status**: Runtime error - needs explicit IDs for schema refs
   - **Learning Value**: Good middle complexity
   - **Issues**: KubernetesRef ID generation errors
   - **Action**: Fix ID issues, keep as intermediate example

5. **comprehensive-k8s-resources.ts** - 🔧 Large example
   - **API**: Unknown (needs inspection)
   - **Learning Value**: May be too comprehensive/overwhelming
   - **Action**: Inspect and possibly split or remove

6. **cel-expressions.ts** - 🔧 CEL showcase
   - **API**: Unknown (needs inspection) 
   - **Learning Value**: Important for CEL documentation
   - **Action**: Inspect, likely keep but update API

#### ❌ LOW VALUE - Consider Removing
7. **kro-less-deployment-simple.ts** - ❌ Outdated naming
   - **API**: Likely toResourceGraph
   - **Issues**: "kro-less" terminology is outdated
   - **Action**: Remove or consolidate

8. **kro-less-deployment-cohesive.ts** - ❌ Outdated naming
   - **API**: Likely toResourceGraph
   - **Issues**: "kro-less" terminology is outdated  
   - **Action**: Remove or consolidate

9. **direct-factory-usage.ts** - ❌ Implementation detail
   - **Learning Value**: Too low-level for main docs
   - **Action**: Remove from primary examples

10. **deterministic-resource-ids.ts** - ❌ Implementation detail
    - **Learning Value**: Internal concept
    - **Action**: Remove from primary examples

#### 🔍 INSPECTED - ADDITIONAL CATEGORIZATION
11. **cel-expressions.ts** - 🟡 MEDIUM VALUE - Uses old API
    - **API**: Uses low-level functions (❌ not kubernetesComposition)
    - **Learning Value**: Good for CEL documentation but not composition patterns
    - **Issues**: Uses old serializeResourceGraphToYaml function
    - **Action**: Extract CEL concepts, integrate into composition examples

12. **comprehensive-k8s-resources.ts** - ⭐ HIGH VALUE but needs updates
    - **API**: kubernetesComposition (✅ correct API)
    - **Learning Value**: Comprehensive showcase but may be overwhelming 
    - **Issues**: Very large, might intimidate beginners
    - **Action**: Keep but place in advanced section, maybe split into focused examples

13. **kro-less-deployment-simple.ts** - ❌ REMOVE - Uses toResourceGraph
    - **API**: toResourceGraph (❌ outdated API)
    - **Learning Value**: Good structure but uses wrong API
    - **Issues**: "kro-less" terminology outdated, toResourceGraph API
    - **Action**: Remove, concepts covered by other examples

14. **alchemy-dynamic-registration.ts** - ❌ REMOVE - Implementation detail
15. **alchemy-wrapper-pattern.ts** - ❌ REMOVE - Implementation detail
16. **direct-mode-alchemy-integration.ts** - ❌ REMOVE - Too low-level
17. **explicit-cel-demo.ts** - ❌ REMOVE - Low-level CEL usage
18. **interactive-kro-debugging.ts** - ❌ REMOVE - Debugging tools, not core examples
19. **kro-factory-pattern.ts** - ❌ REMOVE - Implementation detail
20. **kro-status-fields-and-alchemy-integration.ts** - ❌ REMOVE - Too low-level
21. **README.md** - 🔧 UPDATE - Contains outdated information

### `/docs/examples/` Directory (12 Markdown files)

#### ✅ HIGH VALUE - Keep and Update  
1. **index.md** - ⭐ Main examples landing page
   - **Status**: Good structure but needs content update
   - **Action**: Update to reflect new essential examples

2. **basic-webapp.md** - ⭐ Foundational pattern
   - **API**: Unknown (needs inspection)
   - **Learning Value**: Essential beginner pattern
   - **Action**: Inspect and update to kubernetesComposition

3. **composition-patterns.md** - ⭐ Advanced patterns
   - **Learning Value**: Important for experienced users
   - **Action**: Update with accurate API patterns

#### 🟡 MEDIUM VALUE - Update or Consolidate
4. **basic-patterns.md** - Basic concepts
5. **database-app.md** - Full-stack example  
6. **microservices.md** - Complex architecture
7. **helm-patterns.md** - Helm integration (important)
8. **multi-environment.md** - Environment patterns
9. **monitoring.md** - Monitoring setup

#### ❌ LOW VALUE - Consider Removing
10. **cicd.md** - Too specialized for core docs
11. **database.md** - Possibly redundant with database-app.md
12. **simple-webapp.md** - Likely redundant with basic-webapp.md

## API Consistency Issues Found

### Primary Issues
1. **Mixed API usage**: Some examples use `toResourceGraph`, others use `kubernetesComposition`
2. **Import inconsistency**: Various import patterns across examples
3. **ID generation**: Examples with schema references need explicit IDs
4. **Outdated terminology**: "kro-less" naming is outdated

### Compilation Status
- ✅ **hero-example.ts**: Compiles and runs successfully
- ❌ **basic-webapp.ts**: Runtime error (ID generation for KubernetesRef)
- ❓ **Others**: Need individual testing

## Recommended Essential Example Set (5-6 examples)

Based on analysis, recommend these essential examples:

### 1. Hero/Minimal Example (homepage)
- **File**: `hero-example.ts` (already good)
- **Purpose**: 10-second "wow" demo for homepage
- **Complexity**: Minimal
- **Features**: Basic deployment + service

### 2. Basic Web Application
- **File**: Fix `basic-webapp.ts` or create new
- **Purpose**: First real tutorial example  
- **Complexity**: Beginner-friendly
- **Features**: Web app + database + basic CEL

### 3. Composition Patterns
- **File**: `imperative-composition.ts` (already good structure)
- **Purpose**: Show different composition approaches
- **Complexity**: Intermediate
- **Features**: Multiple composition styles, resource relationships

### 4. Status Builders & CEL
- **File**: Update `complete-webapp.ts` 
- **Purpose**: Advanced status mapping and CEL expressions
- **Complexity**: Advanced
- **Features**: Complex CEL, status aggregation, cross-references

### 5. External References 
- **File**: Create new example using `externalRef()`
- **Purpose**: Cross-composition dependencies 
- **Complexity**: Advanced
- **Features**: Real `externalRef()` usage, composition dependencies

### 6. Helm Integration
- **File**: Create new example using `helmRelease()`
- **Purpose**: Package management integration
- **Complexity**: Intermediate
- **Features**: Helm chart deployment, value templating

## FINAL REMOVAL/CONSOLIDATION PLAN

### Examples to REMOVE (11 files)
1. **alchemy-dynamic-registration.ts** - Implementation detail, not user-facing
2. **alchemy-wrapper-pattern.ts** - Implementation detail, not user-facing  
3. **direct-mode-alchemy-integration.ts** - Too low-level for core examples
4. **explicit-cel-demo.ts** - Low-level CEL usage, concepts covered elsewhere
5. **interactive-kro-debugging.ts** - Debugging tool, not core functionality 
6. **kro-factory-pattern.ts** - Implementation detail, not user-facing
7. **kro-status-fields-and-alchemy-integration.ts** - Too low-level 
8. **kro-less-deployment-simple.ts** - Outdated API (toResourceGraph)
9. **kro-less-deployment-cohesive.ts** - Outdated API and terminology
10. **direct-factory-usage.ts** - Implementation detail, not user-facing
11. **deterministic-resource-ids.ts** - Implementation detail

### Examples to FIX/CONVERT (3 files)
1. **basic-webapp.ts** - Fix ID generation errors for schema references
2. **complete-webapp.ts** - Convert from toResourceGraph to kubernetesComposition  
3. **cel-expressions.ts** - Extract concepts, integrate into composition examples

### Examples to KEEP AS-IS (4 files)
1. **hero-example.ts** - Perfect for homepage/landing
2. **imperative-composition.ts** - Great composition patterns showcase
3. **comprehensive-k8s-resources.ts** - Comprehensive but keep for advanced users
4. **README.md** - Update content but keep structure

### Documentation Files to CONSOLIDATE
From `/docs/examples/`:
- **simple-webapp.md** + **basic-webapp.md** → Single **basic-webapp.md**  
- **database.md** + **database-app.md** → Single **database-app.md**
- **cicd.md** → Remove (too specialized for core docs)

### RESULT: 18 examples → 5-6 essential examples

## Next Steps for Task 0.1.3

1. ✅ Complete categorization and removal plan
2. 🔄 Execute removal of 11 identified files
3. 🔄 Fix/convert 3 examples to use correct API
4. 🔄 Update README.md with accurate information  
5. 🔄 Mark task as complete