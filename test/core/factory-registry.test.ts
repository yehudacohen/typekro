/**
 * Tests for FactoryRegistry
 *
 * The registry is bare — it has no built-in entries. Factories self-register
 * at import time by calling `registerFactory()` in their module scope.
 *
 * These tests verify:
 * 1. The registry API works correctly (register, lookup, clear)
 * 2. Importing factory modules populates the registry
 * 3. Semantic aliases work as expected
 */

import { describe, expect, it } from 'bun:test';
import {
  clearFactoryRegistry,
  getFactoryRegistration,
  getKindInfo,
  getRegisteredFactoryCount,
  getSemanticCandidateKinds,
  isKnownFactory,
  registerFactory,
} from '../../src/core/resources/factory-registry.js';

// Import factory modules to trigger self-registration.
// Each factory file calls registerFactory() at module scope.
import '../../src/factories/kubernetes/workloads/deployment.js';
import '../../src/factories/kubernetes/workloads/stateful-set.js';
import '../../src/factories/kubernetes/networking/service.js';
import '../../src/factories/kubernetes/networking/ingress.js';
import '../../src/factories/kubernetes/config/config-map.js';
import '../../src/factories/kubernetes/config/secret.js';
import '../../src/core/references/external-refs.js';

describe('FactoryRegistry', () => {
  describe('registry API (pure, no imports needed)', () => {
    it('registerFactory makes a factory known', () => {
      registerFactory({
        factoryName: 'TestWidget',
        kind: 'TestWidget',
        apiVersion: 'test.io/v1',
      });

      expect(isKnownFactory('TestWidget')).toBe(true);
      expect(getKindInfo('TestWidget')).toEqual({
        apiVersion: 'test.io/v1',
        kind: 'TestWidget',
      });
    });

    it('returns false for unknown names', () => {
      expect(isKnownFactory('CompletelyUnknown')).toBe(false);
      expect(isKnownFactory('')).toBe(false);
    });

    it('getKindInfo returns undefined for unknown factory', () => {
      expect(getKindInfo('NonExistent')).toBeUndefined();
    });

    it('registers with semantic aliases', () => {
      registerFactory({
        factoryName: 'PostgresCluster',
        kind: 'PostgresCluster',
        apiVersion: 'postgres-operator.crunchydata.com/v1beta1',
        semanticAliases: ['postgres', 'pg'],
      });

      expect(isKnownFactory('PostgresCluster')).toBe(true);
      expect(getSemanticCandidateKinds('postgres')).toContain('postgrescluster');
      expect(getSemanticCandidateKinds('pg')).toContain('postgrescluster');
    });

    it('re-registering overwrites silently', () => {
      registerFactory({
        factoryName: 'OverwriteTest',
        kind: 'V1Kind',
        apiVersion: 'v1',
      });
      registerFactory({
        factoryName: 'OverwriteTest',
        kind: 'V2Kind',
        apiVersion: 'v2',
      });

      expect(getKindInfo('OverwriteTest')).toEqual({ apiVersion: 'v2', kind: 'V2Kind' });
    });

    it('getSemanticCandidateKinds returns undefined for unknown alias', () => {
      expect(getSemanticCandidateKinds('nonexistent-alias-xyz')).toBeUndefined();
    });

    it('semantic alias lookup is case-insensitive', () => {
      registerFactory({
        factoryName: 'CaseTest',
        kind: 'CaseTest',
        apiVersion: 'v1',
        semanticAliases: ['MyAlias'],
      });

      expect(getSemanticCandidateKinds('myalias')).toBeDefined();
      expect(getSemanticCandidateKinds('MYALIAS')).toBeDefined();
      expect(getSemanticCandidateKinds('MyAlias')).toBeDefined();
    });

    it('getFactoryRegistration returns full registration', () => {
      registerFactory({
        factoryName: 'FullTest',
        kind: 'FullTest',
        apiVersion: 'v1',
        semanticAliases: ['ft'],
      });

      const reg = getFactoryRegistration('FullTest');
      expect(reg).toBeDefined();
      expect(reg!.factoryName).toBe('FullTest');
      expect(reg!.kind).toBe('FullTest');
      expect(reg!.apiVersion).toBe('v1');
      expect([...(reg!.semanticAliases ?? [])]).toContain('ft');
    });

    it('getFactoryRegistration returns undefined for unknown', () => {
      expect(getFactoryRegistration('Unknown')).toBeUndefined();
    });

    it('clearFactoryRegistry empties everything', () => {
      const countBefore = getRegisteredFactoryCount();
      expect(countBefore).toBeGreaterThan(0);

      clearFactoryRegistry();
      expect(getRegisteredFactoryCount()).toBe(0);
      expect(isKnownFactory('Deployment')).toBe(false);

      // Re-register the ones we need for the rest of the tests
      registerFactory({
        factoryName: 'Deployment',
        kind: 'Deployment',
        apiVersion: 'apps/v1',
        semanticAliases: ['deploy', 'database', 'db', 'cache', 'redis'],
      });
      registerFactory({
        factoryName: 'StatefulSet',
        kind: 'StatefulSet',
        apiVersion: 'apps/v1',
        semanticAliases: ['database', 'db', 'cache', 'redis'],
      });
      registerFactory({
        factoryName: 'Service',
        kind: 'Service',
        apiVersion: 'v1',
        semanticAliases: ['service', 'svc'],
      });
      registerFactory({
        factoryName: 'Ingress',
        kind: 'Ingress',
        apiVersion: 'networking.k8s.io/v1',
        semanticAliases: ['ingress'],
      });
      registerFactory({
        factoryName: 'ConfigMap',
        kind: 'ConfigMap',
        apiVersion: 'v1',
        semanticAliases: ['configmap'],
      });
      registerFactory({
        factoryName: 'Secret',
        kind: 'Secret',
        apiVersion: 'v1',
        semanticAliases: ['secret'],
      });
      registerFactory({
        factoryName: 'externalRef',
        kind: 'ExternalRef',
        apiVersion: 'typekro/v1',
      });
    });
  });

  describe('self-registration via factory imports', () => {
    it('factories with semantic aliases are registered', () => {
      // These were registered by the factory module imports at the top
      expect(isKnownFactory('Deployment')).toBe(true);
      expect(isKnownFactory('StatefulSet')).toBe(true);
      expect(isKnownFactory('Service')).toBe(true);
      expect(isKnownFactory('Ingress')).toBe(true);
      expect(isKnownFactory('ConfigMap')).toBe(true);
      expect(isKnownFactory('Secret')).toBe(true);
      expect(isKnownFactory('externalRef')).toBe(true);
    });

    it('semantic aliases match the old semanticPatterns behavior', () => {
      // database → deployment + statefulset (both registered the alias)
      const dbKinds = getSemanticCandidateKinds('database');
      expect(dbKinds).toBeDefined();
      expect(dbKinds!).toContain('deployment');
      expect(dbKinds!).toContain('statefulset');

      // service → service
      expect(getSemanticCandidateKinds('service')).toContain('service');
      expect(getSemanticCandidateKinds('svc')).toContain('service');

      // ingress → ingress
      expect(getSemanticCandidateKinds('ingress')).toContain('ingress');

      // configmap → configmap
      expect(getSemanticCandidateKinds('configmap')).toContain('configmap');

      // secret → secret
      expect(getSemanticCandidateKinds('secret')).toContain('secret');
    });

    it('getKindInfo returns correct info for self-registered factories', () => {
      expect(getKindInfo('Deployment')).toEqual({ apiVersion: 'apps/v1', kind: 'Deployment' });
      expect(getKindInfo('Service')).toEqual({ apiVersion: 'v1', kind: 'Service' });
      expect(getKindInfo('ConfigMap')).toEqual({ apiVersion: 'v1', kind: 'ConfigMap' });
      expect(getKindInfo('Secret')).toEqual({ apiVersion: 'v1', kind: 'Secret' });
      expect(getKindInfo('Ingress')).toEqual({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
      });
    });
  });
});
