/**
 * Tests for lazyComposition — deferred factory resource-graph serialization.
 *
 * Background: `kubernetesComposition(...)` executes (and serializes) eagerly.
 * Built-in factory modules declare their composition at module scope, and the
 * factory barrel (`src/factories/index.ts`) re-exports every one of them — so
 * importing any single factory used to serialize the ENTIRE catalog. None of
 * those graphs are deployed; it was pure wasted work + log noise.
 *
 * `lazyComposition(() => kubernetesComposition(...))` defers a single
 * composition's construction behind a memoized thunk that only runs on first
 * use. These tests assert:
 *   1. The build thunk is NOT invoked at wrap time (the core fix).
 *   2. The thunk runs at most once and is memoized.
 *   3. The wrapped value transparently behaves like the real composition
 *      (callable, property access, public surface).
 *   4. Built-in factories that ARE used still build + work identically.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { Cel, kubernetesComposition, simple } from '../../src/index.js';
import { lazyComposition } from '../../src/core/composition/lazy-composition.js';

const SpecSchema = type({ name: 'string', image: 'string', replicas: 'number%1' });
const StatusSchema = type({ ready: 'boolean', readyReplicas: 'number%1' });

const definition = {
  name: 'lazy-test-webapp',
  apiVersion: 'example.com/v1alpha1',
  kind: 'LazyWebApp',
  spec: SpecSchema,
  status: StatusSchema,
} as const;

function makeRealComposition() {
  return kubernetesComposition(definition, (spec) => {
    const deployment = simple.Deployment({
      name: spec.name,
      image: spec.image,
      replicas: spec.replicas,
      id: 'lazyTestDeployment',
    });
    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0'),
      readyReplicas: deployment.status.readyReplicas,
    };
  });
}

describe('lazyComposition', () => {
  it('does NOT invoke the build thunk at wrap time', () => {
    let builds = 0;
    lazyComposition(() => {
      builds++;
      return makeRealComposition();
    });

    // The wrap itself must be free of serialization — this is the bug fix.
    expect(builds).toBe(0);
  });

  it('builds exactly once, on first use, and memoizes', () => {
    let builds = 0;
    const lazy = lazyComposition(() => {
      builds++;
      return makeRealComposition();
    });

    expect(builds).toBe(0);

    // First property read triggers materialization.
    expect(lazy.name).toBe('lazy-test-webapp');
    expect(builds).toBe(1);

    // Subsequent reads reuse the memoized composition.
    void lazy.resources;
    void lazy.factory;
    expect(builds).toBe(1);
  });

  it('exposes the real composition public surface transparently', () => {
    const lazy = lazyComposition(() => makeRealComposition());

    expect(lazy.name).toBe('lazy-test-webapp');
    expect(Array.isArray(lazy.resources)).toBe(true);
    expect(lazy.resources.length).toBeGreaterThan(0);
    expect(typeof lazy.factory).toBe('function');

    // Enumeration and brand checks must work through the proxy.
    expect(Object.keys(lazy)).toContain('name');
  });

  it('is callable with a spec, building lazily', () => {
    let builds = 0;
    const lazy = lazyComposition(() => {
      builds++;
      return makeRealComposition();
    });

    expect(builds).toBe(0);
    const instance = lazy({ name: 'app', image: 'nginx', replicas: 2 });
    expect(builds).toBe(1);
    expect(instance).toBeDefined();
  });

  it('produces a factory that can serialize to YAML (used factory still works)', () => {
    const lazy = lazyComposition(() => makeRealComposition());
    const factory = lazy.factory('kro');
    const yaml = factory.toYaml();
    expect(yaml).toContain('LazyWebApp');
  });
});

describe('built-in factory laziness', () => {
  it('spies prove an unused lazy factory is never built, but a used one is', () => {
    // This mirrors the real catalog problem at the unit level: two factories
    // are declared, only one is "used". The unused one must never build.
    let usedBuilds = 0;
    let unusedBuilds = 0;

    const used = lazyComposition(() => {
      usedBuilds++;
      return makeRealComposition();
    });
    // Not bound: like an un-touched factory in the barrel — created, never used.
    lazyComposition(() => {
      unusedBuilds++;
      return makeRealComposition();
    });

    // Declaring both (as the barrel does for the whole catalog) serializes
    // nothing.
    expect(usedBuilds).toBe(0);
    expect(unusedBuilds).toBe(0);

    // Use only one.
    used.factory('kro').toYaml();

    expect(usedBuilds).toBe(1);
    // The unused factory was never touched -> never serialized.
    expect(unusedBuilds).toBe(0);
  });

  it('exposes built-in dagsterBootstrap as a working lazy composition', async () => {
    const { dagsterBootstrap } = await import(
      '../../src/factories/dagster/compositions/dagster-bootstrap.js'
    );
    expect(dagsterBootstrap.name).toBe('dagster-bootstrap');
    const factory = dagsterBootstrap.factory('kro');
    const yaml = factory.toYaml();
    expect(yaml).toContain('DagsterBootstrap');
  });
});
