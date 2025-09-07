# Content Audit and Mapping

## Overview

This document provides a comprehensive inventory of all unique content across the 10 existing steering documents and maps each content section to its target consolidated document. This audit identifies duplicate content that needs to be merged and ensures no important information is lost during consolidation.

## Existing Documents Inventory

### 1. build-and-test-tooling.md
**Content Sections:**
- Package Manager Requirements (Bun vs npm/yarn)
- Command Usage Examples (package management, build, testing)
- Project Configuration (package.json scripts, workspace config)
- CI/CD Integration (GitHub Actions examples)
- Installation Instructions (multiple methods)
- Migration Guidelines (from npm/yarn to Bun)
- Exceptions and Enforcement Rules
- Resource Links

**Target Document:** `tooling-requirements.md`
**Unique Content:** All content is unique to tooling requirements

### 2. codebase-structure.md
**Content Sections:**
- Directory Structure Overview (src/core/, src/factories/, src/utils/, src/alchemy/)
- Core Architecture Details (composition, dependencies, deployment, references, serialization, types)
- Factory Organization Principles (single responsibility, consistent patterns, type safety)
- API Evolution (toResourceGraph vs legacy toKroResourceGraph)
- Factory Pattern Implementation (DirectResourceFactory vs KroResourceFactory)
- Architectural Decisions (circular dependency elimination, centralized types, organized factory structure)
- Development Guidelines (adding new factories, adding core functionality, import guidelines)
- Testing Structure
- Build and Development Commands
- Migration Notes

**Target Document:** `architecture-guide.md`
**Unique Content:** All content is unique to architecture and codebase structure

### 3. context-first-development.md
**Content Sections:**
- Core Principle (understand context before changing code)
- File Management Rules (use rm command, clean up temp files, ask for approval)
- Investigation Process (4-step process: read context, understand trade-offs, consider UX, look for systemic issues)
- Examples of Context-First Thinking (type casting in serialization, file organization)
- Red Flags for Context Investigation
- Questions to Ask Before Making Changes (7 key questions)
- When Context Investigation is Complete (6-step process)
- Enforcement Guidelines

**Target Document:** `development-standards.md`
**Unique Content:** All content is unique to development methodology

### 4. fix-root-problems-not-tests.md
**Content Sections:**
- Core Principle (fix implementation, not tests)
- Specific Anti-Patterns (disabling readiness checks)
- The Real Problem (readiness evaluators lost during serialization)
- The Right Fix (preserve evaluators, fix Alchemy integration)
- Enforcement Rules

**Target Document:** `development-standards.md`
**Duplicate Content:** ~80% overlap with fix-root-problems.md

### 5. fix-root-problems.md
**Content Sections:**
- Core Principle (fix implementation, not tests)
- Rules for Test-Driven Problem Solving
- Questions to Ask When Tests Fail (5 key questions)
- Examples of Root Problem Fixing (status field serialization, API signature changes)
- Red Flags That Indicate Masking Problems
- Enforcement Guidelines
- Exception Cases (when test changes are appropriate)

**Target Document:** `development-standards.md`
**Duplicate Content:** ~80% overlap with fix-root-problems-not-tests.md

### 6. integration-testing-setup.md
**Content Sections:**
- Overview (real Kubernetes cluster requirement)
- Cluster Setup (e2e-setup script, existing cluster requirements)
- Running Integration Tests (single file, all tests, debug mode)
- Troubleshooting (timeout issues, resource deployment issues)
- Test Timeouts (specific timeout values)
- Cleanup Instructions
- Best Practices (5 key practices)

**Target Document:** `testing-guidelines.md`
**Unique Content:** All content is unique to integration testing setup

### 7. production-quality-standards.md
**Content Sections:**
- Core Principle (production quality from day one)
- Production Implementation Requirements (no placeholders, complete solutions)
- Implementation Standards (error handling, validation, type safety, resource handling, logging)
- Development Process (methodical error handling, no shortcuts, code review standards)
- Quality Gates (before implementation, during implementation, before merge)
- Anti-Patterns to Avoid (incomplete implementations, mock code in production, swallowing errors)
- Enforcement (code review requirements, no exceptions, technical debt management)
- Success Metrics

**Target Document:** `development-standards.md`
**Unique Content:** All content is unique to production quality standards

### 8. resource-graph-transpilation-hydration.md
**Content Sections:**
- Overview (sophisticated transpilation and hydration process)
- Core Architecture (5-stage transformation pipeline)
- Stage 1: Magic Proxy System (static vs runtime type duality, schema proxy behavior, RefOrValue type system, processValue function)
- Stage 2: Composition Context (resource registration, imperative vs declarative patterns)
- Stage 3: JavaScript to CEL Analysis (imperative analyzer, nested object handling, resource reference conversion, status builder analyzer)
- Stage 4: Serialization (YAML generation, CEL expression serialization, validation and optimization)
- Stage 5: Runtime Hydration (Kro controller processing, CEL evaluation context)
- Development Guidelines (understanding the pipeline, common patterns and anti-patterns)
- Debugging the Pipeline (4 categories of issues)
- Key Takeaways (5 key insights)
- Migration and Compatibility (5 guidelines)

**Target Document:** `architecture-guide.md`
**Unique Content:** All content is unique to resource graph system architecture

### 9. status-builder-patterns.md
**Content Sections:**
- Supported Patterns (direct resource references, CEL expressions, CEL templates)
- Not Supported Patterns (JavaScript fallback patterns)
- Why JavaScript Fallbacks Don't Work (serialization to CEL expressions)
- Migration Guide (old pattern → new pattern examples)
- Test Writing Guidelines (4 key guidelines)
- Enforcement Rules

**Target Document:** `testing-guidelines.md`
**Unique Content:** All content is unique to status builder testing patterns

### 10. typescript-type-safety-testing.md
**Content Sections:**
- Core Principle (validate type system works as intended)
- Rules for Type-Safe Testing (never use type assertions, always test real type safety, never cast away type errors, always use natural TypeScript patterns)
- Testing Type Safety Scenarios (cross-resource references, IDE experience validation, error scenarios)
- Test Structure Guidelines (use real-world patterns, test compilation success)
- Why This Matters (4 key reasons)
- Enforcement Rules

**Target Document:** `testing-guidelines.md`
**Unique Content:** All content is unique to TypeScript type safety testing

## Content Mapping Matrix

| Original Document | Target Document | Content Sections | Duplicate Content |
|------------------|----------------|------------------|-------------------|
| `build-and-test-tooling.md` | `tooling-requirements.md` | All sections (Bun requirements, commands, configuration, CI/CD, installation, migration) | None |
| `codebase-structure.md` | `architecture-guide.md` | All sections (directory structure, core architecture, factory organization, API evolution, architectural decisions, development guidelines) | None |
| `context-first-development.md` | `development-standards.md` | All sections (core principle, file management, investigation process, examples, enforcement) | None |
| `fix-root-problems-not-tests.md` | `development-standards.md` | Core principle, anti-patterns, real problem, right fix, enforcement | ~80% overlap with fix-root-problems.md |
| `fix-root-problems.md` | `development-standards.md` | Core principle, rules, questions, examples, red flags, enforcement, exceptions | ~80% overlap with fix-root-problems-not-tests.md |
| `integration-testing-setup.md` | `testing-guidelines.md` | All sections (overview, cluster setup, running tests, troubleshooting, timeouts, cleanup, best practices) | None |
| `production-quality-standards.md` | `development-standards.md` | All sections (core principle, implementation requirements, standards, development process, quality gates, anti-patterns, enforcement, metrics) | None |
| `resource-graph-transpilation-hydration.md` | `architecture-guide.md` | All sections (overview, 5-stage architecture, development guidelines, debugging, key takeaways, migration) | None |
| `status-builder-patterns.md` | `testing-guidelines.md` | All sections (supported patterns, not supported patterns, why fallbacks don't work, migration guide, test guidelines, enforcement) | None |
| `typescript-type-safety-testing.md` | `testing-guidelines.md` | All sections (core principle, rules, testing scenarios, test structure guidelines, why it matters, enforcement) | None |

## Identified Duplicate Content

### Major Duplication: fix-root-problems.md vs fix-root-problems-not-tests.md

**Overlapping Content (~80% duplication):**
- Core Principle: Both emphasize fixing implementation rather than changing tests
- Anti-Patterns: Both warn against disabling functionality to make tests pass
- Enforcement: Both have similar enforcement guidelines
- Philosophy: Both share the same fundamental approach to test-driven problem solving

**Unique Content in fix-root-problems.md:**
- 5 specific questions to ask when tests fail
- Examples of root problem fixing (status field serialization, API signature changes)
- Red flags that indicate masking problems
- Exception cases when test changes are appropriate

**Unique Content in fix-root-problems-not-tests.md:**
- Specific focus on readiness evaluator issues
- Technical details about serialization problems (JSON.parse(JSON.stringify()) stripping functions)
- Specific guidance about Alchemy integration issues
- Concrete examples with waitForReady parameter

**Consolidation Strategy:** Merge both documents into a single comprehensive section in `development-standards.md` that combines the general principles from `fix-root-problems.md` with the specific technical examples from `fix-root-problems-not-tests.md`.

### Minor Content Overlaps

**Testing Philosophy Overlap:**
- `typescript-type-safety-testing.md`, `status-builder-patterns.md`, and `integration-testing-setup.md` all contain testing guidance but focus on different aspects (type safety, status builders, integration setup respectively)
- **Resolution:** Keep separate sections in `testing-guidelines.md` as they address different testing concerns

**Development Process Overlap:**
- `context-first-development.md` and `production-quality-standards.md` both discuss development methodology but from different angles (investigation process vs quality standards)
- **Resolution:** Combine into comprehensive development standards covering both aspects

**Architecture Information Overlap:**
- `codebase-structure.md` and `resource-graph-transpilation-hydration.md` both contain architecture information but at different levels (codebase organization vs system pipeline)
- **Resolution:** Combine into comprehensive architecture guide covering both structural and system architecture

## Cross-Reference Strategy

### Internal References to Create
1. **development-standards.md** → **testing-guidelines.md**: Reference testing approaches when discussing problem-solving methodology
2. **testing-guidelines.md** → **architecture-guide.md**: Reference architecture concepts when explaining integration testing and system behavior
3. **architecture-guide.md** → **tooling-requirements.md**: Reference tooling setup when discussing development environment and build processes
4. **tooling-requirements.md** → **testing-guidelines.md**: Reference testing setup when discussing integration testing cluster requirements

### Content Organization Strategy
1. **Avoid Duplication**: When concepts appear in multiple contexts, maintain primary definition in one document and reference from others
2. **Logical Flow**: Ensure documents can be read independently but also support sequential reading
3. **Strategic Referencing**: Use markdown links to connect related concepts across documents

## Validation Checklist

### Content Completeness
- [ ] All unique rules and guidelines from original documents are preserved
- [ ] All code examples and anti-patterns are maintained
- [ ] All enforcement mechanisms remain clear
- [ ] All specific technical details are preserved

### Duplication Elimination
- [ ] fix-root-problems.md and fix-root-problems-not-tests.md content is merged without loss
- [ ] No redundant information exists across consolidated documents
- [ ] Single source of truth established for each concept
- [ ] Cross-references used instead of content duplication

### Organization Validation
- [ ] Related concepts are grouped together logically
- [ ] Document titles clearly indicate scope and purpose
- [ ] Most frequently referenced information is easily accessible
- [ ] Document hierarchy supports efficient navigation

## Implementation Notes

### Merge Priority
1. **High Priority**: fix-root-problems.md + fix-root-problems-not-tests.md (significant duplication)
2. **Medium Priority**: Ensure all unique content is preserved during consolidation
3. **Low Priority**: Optimize cross-references and document flow

### Quality Assurance
- Create backup of all original documents before consolidation
- Document consolidation mapping for reference
- Validate that merged content maintains original meaning
- Test that cross-references work correctly
- Ensure no broken or circular references

This audit ensures that the consolidation process will preserve all important information while eliminating redundancy and improving the overall organization and usability of the steering documentation.