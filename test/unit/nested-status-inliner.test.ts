/**
 * Nested-composition status inliner (`resolveNestedCompositionRefs`).
 *
 * Covers the recursive resolver introduced for #200:
 *  - emitted YAML is pinned for a two-level and a three-level nesting so any
 *    future change to the inliner shows up as a diff,
 *  - the expression the inliner emits stays LINEAR in the size of the
 *    nested-status mapping (the old fixed-point loop re-scanned its own
 *    output and produced a 6 MB expression from a two-level fixture),
 *  - cycles are terminal (the concrete `<id>.status.<field>` reference is the
 *    answer) rather than something the depth guard has to stop,
 *  - the depth guard still catches genuinely deep, acyclic nesting, and is an
 *    error under strict CEL diagnostics.
 */

import { type } from 'arktype';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { getComponentLogger } from '../../src/core/logging/index.js';
import { finalizeCelForKro } from '../../src/core/serialization/cel-references.js';
import type { SerializationContext } from '../../src/core/types/serialization.js';
import { kubernetesComposition, simple } from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `cel-references.ts` holds a module-private component logger. Every logger
 * shares one prototype, so spying there intercepts the module's own `warn`
 * without exporting the instance for tests.
 */
function spyOnLoggerWarn() {
  const loggerPrototype = Object.getPrototypeOf(
    getComponentLogger('nested-status-inliner-test')
  ) as {
    warn: (message: string, metadata?: Record<string, unknown>) => void;
  };
  return spyOn(loggerPrototype, 'warn');
}

function serializationContext(resourceIds: string[]): SerializationContext {
  return {
    celPrefix: '',
    resourceIdStrategy: 'deterministic',
    resourceIds: new Set(resourceIds),
  };
}

/** A chain of `length` mappings, each referencing the next, ending at a resource. */
function buildNestingChain(length: number): Record<string, string> {
  const table: Record<string, string> = {};
  for (let level = 0; level < length; level++) {
    table[`__nestedStatus:level${level}:ready`] =
      level === length - 1
        ? 'leafWorkload.status.readyReplicas >= 1'
        : `level${level + 1}.status.ready`;
  }
  return table;
}

// ---------------------------------------------------------------------------
// Shared fixture compositions
// ---------------------------------------------------------------------------

/**
 * The leaf's `phase` mapping reads back the flattened child id — the exact
 * shape that made the old fixed-point loop double its output on every pass,
 * because that id is also a concrete resource in the emitted graph.
 */
const leafComposition = kubernetesComposition(
  {
    name: 'inliner-fixture-leaf',
    apiVersion: 'typekro.test/v1alpha1',
    kind: 'InlinerFixtureLeaf',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean', phase: 'string', replicas: 'number' }),
  },
  (spec) => {
    const workload = simple.Deployment({ id: 'workload', name: spec.name, image: 'nginx' });
    return {
      ready: workload.status.readyReplicas >= 1,
      phase: workload.status.phase || 'Pending',
      replicas: workload.status.readyReplicas || 0,
    };
  }
);

const middleComposition = kubernetesComposition(
  {
    name: 'inliner-fixture-middle',
    apiVersion: 'typekro.test/v1alpha1',
    kind: 'InlinerFixtureMiddle',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean', phase: 'string' }),
  },
  (spec) => {
    const inner = leafComposition({ name: `${spec.name}-leaf` });
    return { ready: inner.status.ready, phase: inner.status.phase };
  }
);

const twoLevelComposition = kubernetesComposition(
  {
    name: 'inliner-fixture-two-level',
    apiVersion: 'typekro.test/v1alpha1',
    kind: 'InlinerFixtureTwoLevel',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean', phase: 'string', replicas: 'number' }),
  },
  (spec) => {
    const inner = leafComposition({ name: `${spec.name}-leaf` });
    return {
      ready: inner.status.ready,
      phase: inner.status.phase,
      replicas: inner.status.replicas,
    };
  }
);

const threeLevelComposition = kubernetesComposition(
  {
    name: 'inliner-fixture-three-level',
    apiVersion: 'typekro.test/v1alpha1',
    kind: 'InlinerFixtureThreeLevel',
    spec: type({ name: 'string' }),
    status: type({ ready: 'boolean', phase: 'string' }),
  },
  (spec) => {
    const mid = middleComposition({ name: `${spec.name}-mid` });
    return { ready: mid.status.ready, phase: mid.status.phase };
  }
);

// ---------------------------------------------------------------------------
// Pinned YAML fixtures
// ---------------------------------------------------------------------------

describe('nested-composition status inlining — pinned YAML', () => {
  it('emits the expected RGD for a two-level nested composition', () => {
    const yaml = twoLevelComposition.factory('kro', { namespace: 'fixture' }).toYaml();

    expect(yaml).toBe(`apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
metadata:
  name: inliner-fixture-two-level
spec:
  resources:
    - id: inlinerFixtureLeaf1
      template:
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          labels:
            app: \${string(schema.spec.name)}-leaf
          name: \${string(schema.spec.name)}-leaf
        spec:
          replicas: 1
          selector:
            matchLabels:
              app: \${string(schema.spec.name)}-leaf
          template:
            metadata:
              labels:
                app: \${string(schema.spec.name)}-leaf
            spec:
              containers:
                - image: nginx
                  name: \${string(schema.spec.name)}-leaf
  schema:
    apiVersion: v1alpha1
    group: typekro.test
    kind: InlinerFixtureTwoLevel
    spec:
      name: string
      typekroArtifactBindings: map[string]map[string]string
    status:
      phase: '\${inlinerFixtureLeaf1.status.phase != null ? inlinerFixtureLeaf1.status.phase : "Pending"}'
      ready: \${inlinerFixtureLeaf1.status.readyReplicas >= 1}
      replicas: '\${inlinerFixtureLeaf1.status.readyReplicas != null ? inlinerFixtureLeaf1.status.readyReplicas : 0}'`);
  });

  it('emits the expected RGD for a three-level nested composition', () => {
    const yaml = threeLevelComposition.factory('kro', { namespace: 'fixture' }).toYaml();

    // One parenthesis level per level of nesting — the resolver adds exactly
    // one wrap per expanded mapping, never one per re-scan.
    expect(yaml).toBe(`apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
metadata:
  name: inliner-fixture-three-level
spec:
  resources:
    - id: inlinerFixtureLeaf1
      template:
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          labels:
            app: \${string(schema.spec.name)}-mid-leaf
          name: \${string(schema.spec.name)}-mid-leaf
        spec:
          replicas: 1
          selector:
            matchLabels:
              app: \${string(schema.spec.name)}-mid-leaf
          template:
            metadata:
              labels:
                app: \${string(schema.spec.name)}-mid-leaf
            spec:
              containers:
                - image: nginx
                  name: \${string(schema.spec.name)}-mid-leaf
  schema:
    apiVersion: v1alpha1
    group: typekro.test
    kind: InlinerFixtureThreeLevel
    spec:
      name: string
      typekroArtifactBindings: map[string]map[string]string
    status:
      phase: '\${(inlinerFixtureLeaf1.status.phase != null ? inlinerFixtureLeaf1.status.phase : "Pending")}'
      ready: \${(inlinerFixtureLeaf1.status.readyReplicas >= 1)}`);
  });
});

// ---------------------------------------------------------------------------
// Expression size — the #200 reproduction
// ---------------------------------------------------------------------------

describe('nested-composition status inlining — expression size (#200)', () => {
  const serviceComposition = kubernetesComposition(
    {
      name: 'inliner-size-service',
      apiVersion: 'typekro.test/v1alpha1',
      kind: 'InlinerSizeService',
      spec: type({ name: 'string' }),
      status: type({ ready: 'boolean', phase: 'string', replicas: 'number' }),
    },
    (spec) => {
      const deployment = simple.Deployment({ id: 'deployment', name: spec.name, image: 'nginx' });
      return {
        ready: deployment.status.readyReplicas >= 1,
        phase: deployment.status.phase || 'Pending',
        replicas: deployment.status.readyReplicas || 0,
      };
    }
  );

  const orchestratorStatus = type({
    allReady: 'boolean',
    servicePhase: 'string',
    totalReplicas: 'number',
  });

  const twoServiceOrchestrator = kubernetesComposition(
    {
      name: 'inliner-size-orchestrator-2',
      apiVersion: 'typekro.test/v1alpha1',
      kind: 'InlinerSizeOrchestrator2',
      spec: type({ name: 'string' }),
      status: orchestratorStatus,
    },
    (spec) => {
      const service1 = serviceComposition({ name: `${spec.name}-svc1` });
      const service2 = serviceComposition({ name: `${spec.name}-svc2` });
      return {
        allReady: service1.status.ready && service2.status.ready,
        servicePhase: service1.status.phase,
        totalReplicas: service1.status.replicas + service2.status.replicas,
      };
    }
  );

  const threeServiceOrchestrator = kubernetesComposition(
    {
      name: 'inliner-size-orchestrator-3',
      apiVersion: 'typekro.test/v1alpha1',
      kind: 'InlinerSizeOrchestrator3',
      spec: type({ name: 'string' }),
      status: orchestratorStatus,
    },
    (spec) => {
      const service1 = serviceComposition({ name: `${spec.name}-svc1` });
      const service2 = serviceComposition({ name: `${spec.name}-svc2` });
      const service3 = serviceComposition({ name: `${spec.name}-svc3` });
      return {
        allReady: service1.status.ready && service2.status.ready && service3.status.ready,
        servicePhase: service1.status.phase,
        totalReplicas:
          service1.status.replicas + service2.status.replicas + service3.status.replicas,
      };
    }
  );

  function statusExpressions(
    factory: { toYaml: () => string },
    kind: string
  ): Record<string, string> {
    const yaml = factory.toYaml();
    const entries: Record<string, string> = {};
    for (const field of ['allReady', 'servicePhase', 'totalReplicas']) {
      const match = new RegExp(`^ {6}${field}: (.*)$`, 'm').exec(yaml);
      expect(match, `${kind}: no ${field} status line in emitted YAML`).not.toBeNull();
      entries[field] = match?.[1] ?? '';
    }
    return entries;
  }

  it('bounds the emitted expression for a self-referential nested mapping', () => {
    const warnSpy = spyOnLoggerWarn();
    try {
      const emitted = statusExpressions(
        twoServiceOrchestrator.factory('kro', { namespace: 'test' }),
        'two services'
      );

      // On master this expression was 6,029,288 characters.
      expect(emitted.servicePhase?.length).toBeLessThan(2000);
      expect(emitted.servicePhase).toContain('inlinerSizeService1.status.phase');
      expect(emitted.servicePhase).not.toContain('((');

      // The depth guard is a safety net for deep nesting, not the thing that
      // stops this expression growing.
      const depthWarnings = warnSpy.mock.calls.filter(
        ([message]) => message === 'Nested composition resolution depth limit exceeded'
      );
      expect(depthWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('grows additively, not multiplicatively, with the number of nested instances', () => {
    const two = statusExpressions(
      twoServiceOrchestrator.factory('kro', { namespace: 'test' }),
      'two services'
    );
    const three = statusExpressions(
      threeServiceOrchestrator.factory('kro', { namespace: 'test' }),
      'three services'
    );

    // A field that references one nested instance is unaffected by adding
    // another instance — nothing re-expands.
    expect(three.servicePhase).toBe(two.servicePhase ?? '');

    // Fields that reference every instance grow by roughly one instance's
    // worth of text, never by a factor.
    const perInstance = (three.totalReplicas?.length ?? 0) - (two.totalReplicas?.length ?? 0);
    expect(perInstance).toBeGreaterThan(0);
    expect(three.totalReplicas?.length).toBeLessThan((two.totalReplicas?.length ?? 0) * 2);
    expect((three.allReady?.length ?? 0) - (two.allReady?.length ?? 0)).toBeLessThan(
      two.allReady?.length ?? 0
    );
  });
});

// ---------------------------------------------------------------------------
// Resolver-level behavior
// ---------------------------------------------------------------------------

describe('nested-composition status inlining — resolver semantics', () => {
  const originalStrictCel = process.env.TYPEKRO_STRICT_CEL;

  afterEach(() => {
    if (originalStrictCel === undefined) {
      delete process.env.TYPEKRO_STRICT_CEL;
    } else {
      process.env.TYPEKRO_STRICT_CEL = originalStrictCel;
    }
  });

  it('keeps the concrete reference for a self-referential mapping', () => {
    const table = {
      '__nestedStatus:svc:phase': 'svc.status.phase != null ? svc.status.phase : "Pending"',
    };

    const result = finalizeCelForKro('svc.status.phase', table);

    expect(result).toBe('${(svc.status.phase != null ? svc.status.phase : "Pending")}');
  });

  it('keeps the concrete reference for a self-referential mapping on a known resource id', () => {
    const table = {
      '__nestedStatus:svc:phase': 'svc.status.phase != null ? svc.status.phase : "Pending"',
    };

    const result = finalizeCelForKro('svc.status.phase', table, serializationContext(['svc']));

    expect(result).toBe('${(svc.status.phase != null ? svc.status.phase : "Pending")}');
  });

  it('breaks an indirect cycle without expanding it repeatedly', () => {
    const table = {
      '__nestedStatus:a:x': 'b.status.y',
      '__nestedStatus:b:y': 'a.status.x',
    };

    const result = finalizeCelForKro('a.status.x', table);

    // a → b → a: the second `a.status.x` is terminal.
    expect(result).toBe('${((a.status.x))}');
  });

  it('resolves a deep but acyclic chain below the depth limit', () => {
    const table = buildNestingChain(12);
    const warnSpy = spyOnLoggerWarn();
    try {
      const result = finalizeCelForKro('level0.status.ready', table);

      expect(result).toContain('leafWorkload.status.readyReplicas >= 1');
      expect(result).not.toMatch(/level\d+\.status\.ready/);
      expect(
        warnSpy.mock.calls.filter(
          ([message]) => message === 'Nested composition resolution depth limit exceeded'
        )
      ).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns and returns a partial expansion when nesting exceeds the depth limit', () => {
    const table = buildNestingChain(24);
    delete process.env.TYPEKRO_STRICT_CEL;
    const warnSpy = spyOnLoggerWarn();
    try {
      const result = finalizeCelForKro('level0.status.ready', table);

      // Stopped part-way, but still a string the caller can emit.
      expect(result).toMatch(/level\d+\.status\.ready/);
      expect(
        warnSpy.mock.calls.filter(
          ([message]) => message === 'Nested composition resolution depth limit exceeded'
        ).length
      ).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('throws when nesting exceeds the depth limit under strict CEL diagnostics', () => {
    const table = buildNestingChain(24);
    process.env.TYPEKRO_STRICT_CEL = '1';

    expect(() => finalizeCelForKro('level0.status.ready', table)).toThrow(
      /exceeded 16 levels of nesting/
    );
  });

  it('leaves schema references and CEL macro lambda variables alone', () => {
    const table = {
      '__nestedStatus:schema:spec': 'SHOULD_NOT_APPEAR',
      '__nestedStatus:c:phase': 'SHOULD_NOT_APPEAR',
      '__nestedStatus:stack:ready':
        'gate.status.conditions.exists(c, c.status.phase == "Ready") && schema.spec.enabled',
    };

    const result = finalizeCelForKro('stack.status.ready', table);

    expect(result).not.toContain('SHOULD_NOT_APPEAR');
    expect(result).toContain('exists(c, c.status.phase == "Ready")');
    expect(result).toContain('schema.spec.enabled');
  });

  it('keeps a lambda variable shielded inside an inlined inner expression', () => {
    const table = {
      '__nestedStatus:item:phase': 'SHOULD_NOT_APPEAR',
      '__nestedStatus:stack:ready': 'item.status.phase == "Ready"',
    };

    // `item` is bound by the macro in the OUTER expression; the inner
    // expression is inlined into that scope, so it must stay shielded.
    const result = finalizeCelForKro('pods.all(item, stack.status.ready)', table);

    expect(result).not.toContain('SHOULD_NOT_APPEAR');
    expect(result).toBe('${pods.all(item, (item.status.phase == "Ready"))}');
  });

  it('substitutes a concrete resource id only inside an expanded nested boundary', () => {
    const table = {
      '__nestedStatus:workload:ready': 'workloadDeployment.status.readyReplicas >= 1',
      '__nestedStatus:stack:ready': 'workload.status.ready',
    };
    const context = serializationContext(['workload']);

    // The top-level text names a concrete resource: left untouched.
    expect(finalizeCelForKro('workload.status.ready', table, context, false)).toBe(
      '${workload.status.ready}'
    );

    // Reached through an expanded nested mapping: the exact mapping wins.
    expect(finalizeCelForKro('stack.status.ready', table, context, false)).toBe(
      '${((workloadDeployment.status.readyReplicas >= 1))}'
    );
  });
});
