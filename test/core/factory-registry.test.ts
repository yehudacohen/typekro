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
import type { KubernetesResource } from '../../src/core/types/kubernetes.js';
import {
  clearFactoryRegistry,
  getFactoryRegistration,
  getFactoryRegistrationsForGVK,
  getKindInfo,
  getRegisteredFactoryCount,
  getRegisteredFactoryNames,
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

    it('indexes registrations by the complete apiVersion and kind', () => {
      registerFactory({
        factoryName: 'CoreWidget',
        kind: 'Widget',
        apiVersion: 'core.example.dev/v1',
      });
      registerFactory({
        factoryName: 'OtherWidget',
        kind: 'Widget',
        apiVersion: 'other.example.dev/v1',
      });

      expect(getFactoryRegistrationsForGVK('core.example.dev/v1', 'Widget')).toEqual([
        expect.objectContaining({ factoryName: 'CoreWidget' }),
      ]);
      expect(getFactoryRegistrationsForGVK('other.example.dev/v1', 'Widget')).toEqual([
        expect.objectContaining({ factoryName: 'OtherWidget' }),
      ]);
    });

    it('allows identical canonicalizer registration and rejects GVK conflicts', () => {
      const canonicalize = (resource: KubernetesResource): KubernetesResource => resource;
      registerFactory({
        factoryName: 'CanonicalWidgetA',
        kind: 'CanonicalWidget',
        apiVersion: 'canonical.example.dev/v1',
        desiredCanonicalizer: {
          id: 'canonical.example.dev/widget',
          revision: '1',
          canonicalize,
        },
      });
      expect(() =>
        registerFactory({
          factoryName: 'CanonicalWidgetAlias',
          kind: 'CanonicalWidget',
          apiVersion: 'canonical.example.dev/v1',
          desiredCanonicalizer: {
            id: 'canonical.example.dev/widget',
            revision: '1',
            canonicalize,
          },
        })
      ).not.toThrow();
      expect(() =>
        registerFactory({
          factoryName: 'CanonicalWidgetConflict',
          kind: 'CanonicalWidget',
          apiVersion: 'canonical.example.dev/v1',
          desiredCanonicalizer: {
            id: 'canonical.example.dev/widget',
            revision: '2',
            canonicalize,
          },
        })
      ).toThrow('Conflicting desired canonicalizers');
    });

    it('allows identical live canonicalizers and rejects full-GVK conflicts', () => {
      const canonicalize = (resource: KubernetesResource): KubernetesResource => resource;
      registerFactory({
        factoryName: 'LiveCanonicalWidgetA',
        kind: 'LiveCanonicalWidget',
        apiVersion: 'canonical.example.dev/v1',
        liveCanonicalizer: {
          id: 'canonical.example.dev/live-widget',
          revision: '1',
          canonicalize,
        },
      });
      expect(() =>
        registerFactory({
          factoryName: 'LiveCanonicalWidgetAlias',
          kind: 'LiveCanonicalWidget',
          apiVersion: 'canonical.example.dev/v1',
          liveCanonicalizer: {
            id: 'canonical.example.dev/live-widget',
            revision: '1',
            canonicalize,
          },
        })
      ).not.toThrow();
      expect(() =>
        registerFactory({
          factoryName: 'LiveCanonicalWidgetConflict',
          kind: 'LiveCanonicalWidget',
          apiVersion: 'canonical.example.dev/v1',
          liveCanonicalizer: {
            id: 'canonical.example.dev/live-widget',
            revision: '2',
            canonicalize,
          },
        })
      ).toThrow('Conflicting live-comparison canonicalizers');
    });

    it('rejects changing or removing a canonicalizer when the same factory re-registers', () => {
      const canonicalize = (resource: KubernetesResource): KubernetesResource => resource;
      registerFactory({
        factoryName: 'StableCanonicalWidget',
        kind: 'StableCanonicalWidget',
        apiVersion: 'canonical.example.dev/v1',
        desiredCanonicalizer: {
          id: 'canonical.example.dev/stable-widget',
          revision: '1',
          canonicalize,
        },
      });

      expect(() =>
        registerFactory({
          factoryName: 'StableCanonicalWidget',
          kind: 'StableCanonicalWidget',
          apiVersion: 'canonical.example.dev/v1',
          desiredCanonicalizer: {
            id: 'canonical.example.dev/stable-widget',
            revision: '2',
            canonicalize,
          },
        })
      ).toThrow('Conflicting desired canonicalizers');
      expect(() =>
        registerFactory({
          factoryName: 'StableCanonicalWidget',
          kind: 'StableCanonicalWidget',
          apiVersion: 'canonical.example.dev/v1',
        })
      ).toThrow('Conflicting desired canonicalizers');

      expect(getFactoryRegistration('StableCanonicalWidget')?.desiredCanonicalizer?.revision).toBe(
        '1'
      );
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
      const registrations = getRegisteredFactoryNames().flatMap((factoryName) => {
        const registration = getFactoryRegistration(factoryName);
        return registration ? [registration] : [];
      });

      try {
        clearFactoryRegistry();
        expect(getRegisteredFactoryCount()).toBe(0);
        expect(isKnownFactory('Deployment')).toBe(false);
      } finally {
        // Factory modules self-register only once per process. Restore the exact
        // registry snapshot so this test cannot poison later files in a full run.
        registrations.forEach(registerFactory);
      }

      expect(getRegisteredFactoryCount()).toBe(countBefore);
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
