# Implementation Plan

- [x] 1. Create simple factory directory structure
  - Create `src/factories/simple/` directory with subdirectories mirroring kubernetes structure
  - Create index files for each subdirectory
  - _Requirements: 1.1, 2.1_

- [x] 1.1 Create workloads directory structure
  - Create `src/factories/simple/workloads/` directory
  - Create `src/factories/simple/workloads/index.ts` file
  - _Requirements: 1.1, 2.1_

- [x] 1.2 Create networking directory structure
  - Create `src/factories/simple/networking/` directory
  - Create `src/factories/simple/networking/index.ts` file
  - _Requirements: 1.1, 2.1_

- [x] 1.3 Create config directory structure
  - Create `src/factories/simple/config/` directory
  - Create `src/factories/simple/config/index.ts` file
  - _Requirements: 1.1, 2.1_

- [x] 1.4 Create storage directory structure
  - Create `src/factories/simple/storage/` directory
  - Create `src/factories/simple/storage/index.ts` file
  - _Requirements: 1.1, 2.1_

- [x] 1.5 Create autoscaling directory structure
  - Create `src/factories/simple/autoscaling/` directory
  - Create `src/factories/simple/autoscaling/index.ts` file
  - _Requirements: 1.1, 2.1_

- [x] 2. Move and rename type definitions
  - Create `src/factories/simple/types.ts` with clean config interface names
  - Move Simple*Config types from composition module and rename to clean names (excluding composition-specific types like WebServiceConfig)
  - Keep WebServiceConfig and WebServiceComponent in composition module
  - _Requirements: 1.1, 2.1, 6.1_

- [x] 3. Implement workload simple factories
  - Create `src/factories/simple/workloads/deployment.ts` with Deployment function
  - Create `src/factories/simple/workloads/stateful-set.ts` with StatefulSet function
  - Create `src/factories/simple/workloads/job.ts` with Job function
  - Create `src/factories/simple/workloads/cron-job.ts` with CronJob function
  - Update `src/factories/simple/workloads/index.ts` to export all workload functions
  - _Requirements: 1.1, 2.3, 2.4, 2.5, 2.6_

- [x] 4. Implement networking simple factories
  - Create `src/factories/simple/networking/service.ts` with Service function
  - Create `src/factories/simple/networking/ingress.ts` with Ingress function
  - Create `src/factories/simple/networking/network-policy.ts` with NetworkPolicy function
  - Update `src/factories/simple/networking/index.ts` to export all networking functions
  - _Requirements: 1.1, 2.7, 2.11, 2.12_

- [x] 5. Implement config simple factories
  - Create `src/factories/simple/config/config-map.ts` with ConfigMap function
  - Create `src/factories/simple/config/secret.ts` with Secret function
  - Update `src/factories/simple/config/index.ts` to export all config functions
  - _Requirements: 1.1, 2.2, 2.8_

- [x] 6. Implement storage simple factories
  - Create `src/factories/simple/storage/persistent-volume-claim.ts` with Pvc function
  - Update `src/factories/simple/storage/index.ts` to export storage functions
  - _Requirements: 1.1, 2.9_

- [x] 7. Implement autoscaling simple factories
  - Create `src/factories/simple/autoscaling/horizontal-pod-autoscaler.ts` with Hpa function
  - Update `src/factories/simple/autoscaling/index.ts` to export autoscaling functions
  - _Requirements: 1.1, 2.10_

- [x] 8. Create main simple namespace exports
  - Create `src/factories/simple/index.ts` that exports all individual functions and creates simple namespace object
  - Export all functions individually for direct imports from 'typekro/simple'
  - Create simple namespace object that contains all functions
  - _Requirements: 1.1, 1.2, 3.1, 3.2, 3.3_

- [x] 9. Update main package exports
  - Update `src/factories/index.ts` to export simple namespace
  - Update `src/index.ts` to export simple namespace
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 10. Update package.json exports configuration
  - Add './simple' export path pointing to simple factory index
  - Ensure proper TypeScript type definitions are exported
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 11. Update composition functions to use simple namespace
  - Update `createWebService` function in composition module to use simple.Deployment and simple.Service
  - Keep WebServiceConfig and WebServiceComponent types in composition module
  - Update any other composition functions that use simple* functions
  - _Requirements: 6.1, 6.2_

- [x] 12. Remove old simple* functions and types
  - Remove all simple* function implementations from `src/core/composition/composition.ts`
  - Remove all Simple*Config types from `src/core/composition/types.ts` (except composition-specific types)
  - Keep WebServiceConfig, WebServiceComponent, and createWebService in composition module
  - Update `src/core/composition/index.ts` to remove simple* exports but keep composition exports
  - Update `src/core.ts` to remove simple* exports but keep composition exports
  - Update `src/index.ts` to remove simple* exports but keep composition exports
  - _Requirements: 6.1, 6.2, 6.3_

- [x] 13. Update existing unit tests to use simple namespace
  - Update existing tests that use simple* functions to use simple namespace instead
  - Ensure all tests pass with new simple namespace functions
  - Add tests for import patterns within existing test files
  - _Requirements: 1.1, 1.2, 1.3, 3.4, 3.5_

- [x] 14. Update test suite to use new simple namespace
  - Update `test/core.test.ts` to use simple namespace
  - Update `test/error-handling.test.ts` to use simple namespace
  - Update `test/factory/hpa.test.ts` to use simple namespace
  - Update `test/factory/kro-factory-pattern.test.ts` to use simple namespace
  - Update all other test files that use simple* functions
  - _Requirements: 4.3_

- [x] 15. Update integration tests to use new simple namespace
  - Update `test/integration/e2e-basic-kro.test.ts` to use simple namespace
  - Update `test/integration/e2e-direct-factory-tls.test.ts` to use simple namespace
  - Update `test/integration/e2e-factory-status-hydration.test.ts` to use simple namespace
  - Update all other integration test files that use simple* functions
  - _Requirements: 4.3_

- [x] 16. Update all examples to use new simple namespace
  - Update `examples/basic-webapp.ts` to use simple.Deployment and simple.Service
  - Update `examples/deterministic-resource-ids.ts` to use simple namespace
  - Update `examples/kro-less-deployment-simple.ts` to use simple namespace
  - Update all other example files that use simple* functions
  - _Requirements: 4.1_

- [ ] 17. Update documentation to use new simple namespace
  - Update `docs/examples/simple-webapp.md` to show simple namespace usage
  - Update `docs/examples/composition-patterns.md` to use simple namespace
  - Update `docs/examples/basic-webapp.md` to use simple namespace
  - Update `docs/api/factories.md` to document simple namespace
  - Update all other documentation files that reference simple* functions
  - _Requirements: 4.2_

- [ ] 18. Update README.md and root documentation
  - Update `README.md` to show simple namespace syntax in code examples
  - Update any other root-level documentation files
  - _Requirements: 4.4_

- [ ] 19. Update spec and design documents
  - Update `.kiro/specs/*/design.md` files that reference simple* functions
  - Update `.kiro/specs/*/requirements.md` files that reference simple* functions
  - Update steering documents that reference simple* functions
  - _Requirements: 4.2_

- [ ] 20. Run full test suite validation
  - Execute complete test suite to ensure no regressions
  - Verify all import patterns work correctly
  - Verify TypeScript compilation succeeds
  - Verify bundle size hasn't increased significantly
  - _Requirements: 6.4, 6.5_

- [ ] 21. Validate all import patterns in isolation
  - Test `import { simple } from 'typekro'` works correctly
  - Test `import { Deployment } from 'typekro/simple'` works correctly
  - Test `import * as simple from 'typekro/simple'` works correctly
  - Verify TypeScript types are correctly inferred for all patterns
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 22. Fix broken import statements from automation
  - Fix all imports like `import { simple.Deployment }` to proper syntax
  - Fix mixed imports like `import { toResourceGraph, simple.Deployment, simple.Service }`
  - Ensure all import statements are syntactically correct
  - Verify TypeScript compilation after import fixes
  - _Requirements: 3.1, 3.2, 3.3_

- [ ] 23. Standardize simple factory usage patterns
  - Ensure consistent use of `simple.Deployment()` syntax throughout codebase
  - Update any remaining inconsistent usage patterns
  - Verify all simple factory calls use the namespace correctly
  - _Requirements: 1.1, 1.2, 3.1_

- [ ] 24. Consider toResourceGraph to kubernetesComposition migrations
  - Identify examples that would benefit from kubernetesComposition pattern
  - Update appropriate examples to use kubernetesComposition where it improves readability
  - Maintain backward compatibility and don't force migrations
  - _Requirements: 4.1, 4.2_

- [ ] 25. Final documentation review and cleanup
  - Review all updated documentation for consistency
  - Ensure all code examples are executable and correct
  - Verify API documentation reflects new simple namespace
  - Clean up any remaining references to old simple* functions
  - _Requirements: 4.1, 4.2, 4.4, 4.5_