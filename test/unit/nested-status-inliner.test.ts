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
import { KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import {
  celStringLiteralSpans,
  maskClosedCelLiteralsAndComments,
} from '../../src/core/references/cel-lexical-scanner.js';
import {
  finalizeCelForKro,
  inlineNestedStatusRefs,
  inlineNestedStatusRefsWithStats,
  normalizeCelArrayIndexPaths,
  normalizeRefMarkersToCelPaths,
  processResourceReferences,
  serializeStatusMappingsToCel,
} from '../../src/core/serialization/cel-references.js';
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

describe('nested-composition status inlining — CEL string literals', () => {
  // One mapping, whose inner expression names a leaf field that is NOT itself a
  // mapping key, so every substitution below is exactly one level deep.
  const table = { '__nestedStatus:svc:phase': 'innerDeployment.status.currentPhase' };

  it('leaves a token inside a double-quoted literal alone', () => {
    expect(finalizeCelForKro('"see svc.status.phase"', table)).toBe('${"see svc.status.phase"}');
  });

  it('leaves a token inside a single-quoted literal alone', () => {
    expect(finalizeCelForKro("'see svc.status.phase'", table)).toBe("${'see svc.status.phase'}");
  });

  it('leaves a token inside a URL-ish literal alone', () => {
    expect(finalizeCelForKro('"http://svc.status.phase/x"', table)).toBe(
      '${"http://svc.status.phase/x"}'
    );
  });

  it('substitutes the same token outside the literal in the same expression', () => {
    expect(finalizeCelForKro('svc.status.phase + "see svc.status.phase"', table)).toBe(
      '${(innerDeployment.status.currentPhase) + "see svc.status.phase"}'
    );
  });

  it('keeps the literal open across an escaped quote', () => {
    // The `\\"` does NOT close the literal, so the token after it is still
    // quoted data; the one after the real closing quote is not.
    expect(finalizeCelForKro('"a \\" svc.status.phase" == svc.status.phase', table)).toBe(
      '${"a \\" svc.status.phase" == (innerDeployment.status.currentPhase)}'
    );
  });

  it('treats an unterminated quote as ordinary text', () => {
    // Marker-laden strings come from template literals and may carry a bare
    // apostrophe. Here the double-quoted literal IS closed, so the apostrophe
    // inside it is just data and the token outside still resolves.
    expect(finalizeCelForKro('svc.status.phase == "it\'s ready"', table)).toBe(
      '${(innerDeployment.status.currentPhase) == "it\'s ready"}'
    );
  });

  it('still resolves __KUBERNETES_REF__ markers embedded in template text', () => {
    // Markers are deliberately embedded in literal-looking text by template
    // literals. They are marker conversions, not nested tokens, and the literal
    // masking must not reach them.
    const markerTable = {
      '__nestedStatus:stack:host': 'innerService.status.hostName',
      '__nestedStatus:stack:cachePort': '6379',
    };

    expect(
      normalizeRefMarkersToCelPaths(
        'redis://__KUBERNETES_REF_stack_status.host__:__KUBERNETES_REF_stack_status.cachePort__',
        { celPrefix: '', resourceIdStrategy: 'deterministic', nestedStatusCel: markerTable }
      )
    ).toBe('redis://${innerService.status.hostName}:${string(6379)}');
  });
});

describe('nested-composition status inlining — CEL string literal forms', () => {
  // `STRING_LIT ::= [rR]? ( '"' … | "'" … | '"""' … | "'''" … )` and
  // `BYTES_LIT ::= [bB] STRING_LIT` (cel-spec doc/langdef.md, lexis). Every form
  // hides expression-shaped text from the inliner; the round-1 implementation
  // knew only the two single-quoted ones.
  const table = { '__nestedStatus:svc:phase': 'innerDeployment.status.currentPhase' };
  const inline = (text: string) => inlineNestedStatusRefs(text, table);

  it('masks a token inside a triple-quoted double-quoted literal', () => {
    // The embedded single `"` is what the round-1 scanner tripped over: it read
    // `"""` as an empty string plus an opener, closed that opener on the
    // embedded quote, and left the rest of the literal live.
    expect(inline('""" a " svc.status.phase """')).toBe('""" a " svc.status.phase """');
  });

  it('masks a token inside a triple-quoted single-quoted literal', () => {
    expect(inline("''' a ' svc.status.phase '''")).toBe("''' a ' svc.status.phase '''");
  });

  it('masks a token on the line after a newline inside a triple-quoted literal', () => {
    expect(inline('"""x\nsvc.status.phase\ny"""')).toBe('"""x\nsvc.status.phase\ny"""');
  });

  it('substitutes a token after the triple-quoted literal closes', () => {
    expect(inline('""" a " b """ + svc.status.phase')).toBe(
      '""" a " b """ + (innerDeployment.status.currentPhase)'
    );
  });

  it('masks a token inside a bytes literal, prefix letter in either case', () => {
    expect(inline('b"svc.status.phase"')).toBe('b"svc.status.phase"');
    expect(inline("B'svc.status.phase'")).toBe("B'svc.status.phase'");
  });

  it('masks a token inside a raw literal, prefix letter in either case', () => {
    expect(inline('r"svc.status.phase"')).toBe('r"svc.status.phase"');
    expect(inline("R'svc.status.phase'")).toBe("R'svc.status.phase'");
  });

  it('masks a token inside a combined raw-bytes literal, prefix in either order', () => {
    expect(inline('rb"svc.status.phase"')).toBe('rb"svc.status.phase"');
    expect(inline("BR'svc.status.phase'")).toBe("BR'svc.status.phase'");
  });

  it('masks a token inside a prefixed triple-quoted literal', () => {
    expect(inline('rb"""a\nsvc.status.phase"""')).toBe('rb"""a\nsvc.status.phase"""');
  });

  it('keeps a non-raw literal open across an escaped quote', () => {
    expect(inline('"a \\" svc.status.phase" == svc.status.phase')).toBe(
      '"a \\" svc.status.phase" == (innerDeployment.status.currentPhase)'
    );
  });

  it('closes a RAW literal on the quote a backslash precedes', () => {
    // cel-go lexes the raw forms as `RAW '"' ~["\n\r]* '"'` — no `ESC_SEQ`
    // alternative — so `r"a\"` is a complete token and what follows is live
    // expression text, not literal data.
    expect(inline('r"a\\" == svc.status.phase')).toBe(
      'r"a\\" == (innerDeployment.status.currentPhase)'
    );
  });

  it('treats a prefix letter that only ENDS an identifier as an identifier', () => {
    // `b` here is an operand, not a prefix: the literal starts at the quote.
    expect(inline('b + "svc.status.phase"')).toBe('b + "svc.status.phase"');
    expect(inline('ab"svc.status.phase"')).toBe('ab"svc.status.phase"');
  });

  it('does not let a single-quoted literal span a newline', () => {
    // `'a` cannot close on its line, so it is ordinary text and the token on the
    // next line is live CEL.
    expect(inline("'a\nsvc.status.phase")).toBe("'a\n(innerDeployment.status.currentPhase)");
  });

  it('treats an unterminated triple-quote the way the spec lexer does', () => {
    // No `"""` closes it, so the longest literal the lexis can form there is the
    // empty `""` — and the text after it stays live expression text.
    expect(inline('"""svc.status.phase')).toBe('"""(innerDeployment.status.currentPhase)');
  });

  it('reports the prefix letters as part of the literal span', () => {
    expect(celStringLiteralSpans('rb"x"')).toEqual([{ start: 0, end: 5 }]);
    expect(celStringLiteralSpans('ab"x"')).toEqual([{ start: 2, end: 5 }]);
    expect(maskClosedCelLiteralsAndComments('rb"x" + ab"x"')).toBe('      + ab   ');
  });
});

describe('nested-composition status inlining — CEL comments', () => {
  // `COMMENT ::= '//' ~NEWLINE*` (cel-spec doc/langdef.md, lexis). A token
  // inside one is commented-out text, not a reference.
  const table = { '__nestedStatus:svc:phase': 'innerDeployment.status.currentPhase' };
  const inline = (text: string) => inlineNestedStatusRefs(text, table);

  it('leaves a token inside a line comment alone', () => {
    expect(inline('// svc.status.phase')).toBe('// svc.status.phase');
  });

  it('substitutes the token on the line after the comment', () => {
    expect(inline('// svc.status.phase\nsvc.status.phase')).toBe(
      '// svc.status.phase\n(innerDeployment.status.currentPhase)'
    );
  });

  it('keeps a comment from swallowing the rest of a single-line expression', () => {
    expect(inline('svc.status.phase // svc.status.phase')).toBe(
      '(innerDeployment.status.currentPhase) // svc.status.phase'
    );
  });

  it('reads a `//` inside a string literal as string, not as a comment', () => {
    expect(inline('"a // b" + svc.status.phase')).toBe(
      '"a // b" + (innerDeployment.status.currentPhase)'
    );
    expect(inline('"a // svc.status.phase"')).toBe('"a // svc.status.phase"');
  });

  it('reads a `//` inside a triple-quoted literal as string, not as a comment', () => {
    expect(inline('"""a // svc.status.phase"""')).toBe('"""a // svc.status.phase"""');
  });

  it('reads a quote inside a comment as comment, not as a string opener', () => {
    // A strings-only mask lets the apostrophe in `it's` open a literal and flip
    // the masking of everything after it.
    expect(inline("// it's\nsvc.status.phase")).toBe(
      "// it's\n(innerDeployment.status.currentPhase)"
    );
    expect(inline('// it\'s "x\nsvc.status.phase')).toBe(
      '// it\'s "x\n(innerDeployment.status.currentPhase)'
    );
  });

  it('masks a comment without disturbing offsets or line structure', () => {
    expect(maskClosedCelLiteralsAndComments('a // c\nb')).toBe('a     \nb');
    expect(maskClosedCelLiteralsAndComments('"s" // c')).toBe('        ');
  });
});

describe('nested-composition status inlining — lambda variable scope', () => {
  // Inner expressions name leaf fields, so the only nesting on show is scope.
  const table = {
    '__nestedStatus:svc:phase': 'innerDeployment.status.currentPhase',
    '__nestedStatus:svc:x': 'innerDeployment.status.x',
    '__nestedStatus:outer:w': 'svc.status.phase',
  };
  const inline = (text: string) => inlineNestedStatusRefs(text, table);

  it('shields the macro-bound occurrence and substitutes the one outside it', () => {
    // The first `svc` is the iteration element; the second is a real nested
    // composition id. Shielding the name everywhere left it unexpanded, putting
    // a virtual id into the emitted RGD.
    expect(inline('list.map(svc, svc.status.x) && svc.status.phase')).toBe(
      'list.map(svc, svc.status.x) && (innerDeployment.status.currentPhase)'
    );
  });

  it('shields each variable of a nested macro only inside its own body', () => {
    expect(
      inline('a.map(x, b.filter(y, x.status.phase + y.status.phase)) + x.status.phase')
    ).toBe(
      'a.map(x, b.filter(y, x.status.phase + y.status.phase)) + (innerDeployment.status.currentPhase)'
    );
  });

  it('does not let a macro in quoted data or a comment bind anything', () => {
    expect(inline('"list.map(svc," + svc.status.phase')).toBe(
      '"list.map(svc," + (innerDeployment.status.currentPhase)'
    );
    expect(inline('// list.map(svc,\nsvc.status.phase')).toBe(
      '// list.map(svc,\n(innerDeployment.status.currentPhase)'
    );
  });

  it('shields an inlined inner expression inserted INSIDE the macro body', () => {
    // `outer.status.w` is `svc.status.phase`; inserted inside `map(svc, …)` the
    // `svc` it names is the iteration element, so it stays put.
    expect(inline('list.map(svc, outer.status.w)')).toBe('list.map(svc, (svc.status.phase))');
  });

  it('does not shield an inlined inner expression inserted OUTSIDE the body', () => {
    // Same inner text, inserted where the macro's variable is not in scope.
    expect(inline('list.map(svc, 1) + outer.status.w')).toBe(
      'list.map(svc, 1) + ((innerDeployment.status.currentPhase))'
    );
  });

  it('never shares a memo hit between two different scopes', () => {
    const { text, stats } = inlineNestedStatusRefsWithStats(
      'list.map(svc, outer.status.w) + outer.status.w',
      table
    );

    expect(text).toBe(
      'list.map(svc, (svc.status.phase)) + ((innerDeployment.status.currentPhase))'
    );
    // The two insertions sit in different scopes, so the entry is expanded
    // twice rather than the first result being reused for the second.
    expect(stats.memoHits).toBe(0);
  });

  it('still serves a memo hit for two insertions in the SAME scope', () => {
    const { text, stats } = inlineNestedStatusRefsWithStats(
      'list.map(svc, outer.status.w) + list.map(svc, outer.status.w)',
      table
    );

    expect(text).toBe(
      'list.map(svc, (svc.status.phase)) + list.map(svc, (svc.status.phase))'
    );
    expect(stats.memoHits).toBe(1);
  });

  it("keeps Kro's implicit `each` element variable shielded everywhere", () => {
    // `each` has no binder in the expression — Kro supplies it to a whole
    // `forEach` readyWhen body — so it has no lexical scope to be inside of.
    expect(inline('each.status.phase')).toBe('each.status.phase');
    expect(inline('list.map(svc, each.status.phase)')).toBe('list.map(svc, each.status.phase)');
  });
});

describe('nested-composition status inlining — postfix operations', () => {
  // Every inner expression names a leaf field that is not itself a mapping key,
  // so the only nesting on show is the postfix handling under test.
  const table = {
    '__nestedStatus:svc:items': 'innerService.status.loadBalancer.ingress',
    '__nestedStatus:svc:phase': 'innerDeployment.status.currentPhase',
    '__nestedStatus:svc:addr': 'innerService.status.loadBalancer.ingress[0]',
  };

  it('preserves a method call on a nested field (KRO)', () => {
    expect(finalizeCelForKro('svc.status.items.size()', table)).toBe(
      '${(innerService.status.loadBalancer.ingress).size()}'
    );
  });

  it('preserves a method call with arguments on a nested field (KRO)', () => {
    expect(finalizeCelForKro('svc.status.phase.startsWith("Run")', table)).toBe(
      '${(innerDeployment.status.currentPhase).startsWith("Run")}'
    );
  });

  it('preserves a field access past the mapping key (KRO)', () => {
    expect(finalizeCelForKro('svc.status.addr.ip', table)).toBe(
      '${(innerService.status.loadBalancer.ingress[0]).ip}'
    );
  });

  it('preserves all three shapes in direct serialization', () => {
    expect(inlineNestedStatusRefs('svc.status.items.size()', table)).toBe(
      '(innerService.status.loadBalancer.ingress).size()'
    );
    expect(inlineNestedStatusRefs('svc.status.phase.startsWith("Run")', table)).toBe(
      '(innerDeployment.status.currentPhase).startsWith("Run")'
    );
    expect(inlineNestedStatusRefs('svc.status.addr.ip', table)).toBe(
      '(innerService.status.loadBalancer.ingress[0]).ip'
    );
  });

  it('preserves a field access past the mapping key on the marker path', () => {
    expect(
      normalizeRefMarkersToCelPaths('__KUBERNETES_REF_svc_status.addr.ip__', {
        celPrefix: '',
        resourceIdStrategy: 'deterministic',
        nestedStatusCel: table,
      })
    ).toBe('${(innerService.status.loadBalancer.ingress[0]).ip}');
  });

  it('matches a mapping key that itself contains dots whole', () => {
    const dotted = {
      '__nestedStatus:stack:components.app': 'appDeployment.status.readyReplicas >= 1',
      '__nestedStatus:stack:components': 'SHOULD_NOT_APPEAR',
    };

    const result = finalizeCelForKro('stack.status.components.app', dotted);

    expect(result).toBe('${(appDeployment.status.readyReplicas >= 1)}');
    expect(result).not.toContain('SHOULD_NOT_APPEAR');
  });

  it('does not resolve a method name that collides with a sibling key', () => {
    const sibling = {
      '__nestedStatus:svc:phase': 'innerDeployment.status.currentPhase',
      '__nestedStatus:svc:startsWith': 'SHOULD_NOT_APPEAR',
    };

    const result = finalizeCelForKro('svc.status.phase.startsWith("Run")', sibling);

    expect(result).toBe('${(innerDeployment.status.currentPhase).startsWith("Run")}');
    expect(result).not.toContain('SHOULD_NOT_APPEAR');
  });

  it('leaves the token untouched when no dotted prefix matches', () => {
    expect(finalizeCelForKro('svc.status.unknown.deep', { '__nestedStatus:other:zzz': 'x' })).toBe(
      '${svc.status.unknown.deep}'
    );
  });
});

describe('nested-composition status inlining — indexed postfixes', () => {
  // Leaf-only inner expressions again: the nesting on show is the index chain.
  const table = {
    '__nestedStatus:svc:items': 'innerService.status.loadBalancer.ingress',
    '__nestedStatus:svc:ports': 'innerService.status.portMap',
    '__nestedStatus:svc:a': 'innerService.status.alpha',
  };

  const context: SerializationContext = {
    celPrefix: '',
    resourceIdStrategy: 'deterministic',
    nestedStatusCel: table,
  };

  /** A nested-composition {@link KubernetesRef}, as the structured paths see one. */
  function nestedRef(fieldPath: string): unknown {
    return {
      [KUBERNETES_REF_BRAND]: true,
      __nestedComposition: true,
      resourceId: 'svc',
      fieldPath,
    };
  }

  describe('regex path', () => {
    // The token capture stops at `[`, so the index chain is never inside the
    // match. What this pins is that the text after the match is spliced back
    // VERBATIM rather than rebuilt from the captured segments.
    it('keeps a list index and the field access after it', () => {
      expect(inlineNestedStatusRefs('svc.status.items[0].name', table)).toBe(
        '(innerService.status.loadBalancer.ingress)[0].name'
      );
    });

    it('keeps a map key index and the field access after it', () => {
      expect(inlineNestedStatusRefs('svc.status.ports["http"].port', table)).toBe(
        '(innerService.status.portMap)["http"].port'
      );
    });

    it('keeps an index chain reached past the mapping key', () => {
      expect(inlineNestedStatusRefs('svc.status.a.b[0][1].c', table)).toBe(
        '(innerService.status.alpha).b[0][1].c'
      );
    });

    it('keeps an index that ends the path', () => {
      expect(inlineNestedStatusRefs('svc.status.items[0]', table)).toBe(
        '(innerService.status.loadBalancer.ingress)[0]'
      );
    });

    it('leaves an indexed token whose prefix names no key untouched', () => {
      expect(inlineNestedStatusRefs('svc.status.unknown[0].name', table)).toBe(
        'svc.status.unknown[0].name'
      );
    });
  });

  describe('marker path', () => {
    // A marker field path CONTAINS its index (`status.ports[0].port` is inside
    // `KUBERNETES_REF_MARKER_FIELD_PATH_SOURCE`), so splitting it on `.` yields
    // `ports[0]`, which never equals the key `ports` — the whole marker used to
    // survive into the emitted RGD carrying the virtual id `svc`.
    it('resolves a marker whose field path carries a list index', () => {
      expect(
        normalizeRefMarkersToCelPaths('__KUBERNETES_REF_svc_status.items[0].name__', context)
      ).toBe('${(innerService.status.loadBalancer.ingress)[0].name}');
    });

    it('resolves a marker whose index ends the field path', () => {
      expect(normalizeRefMarkersToCelPaths('__KUBERNETES_REF_svc_status.items[0]__', context)).toBe(
        '${(innerService.status.loadBalancer.ingress)[0]}'
      );
    });

    it('resolves a marker whose index sits past the mapping key', () => {
      expect(normalizeRefMarkersToCelPaths('__KUBERNETES_REF_svc_status.a.b[0]__', context)).toBe(
        '${(innerService.status.alpha).b[0]}'
      );
    });

    it('leaves a marker whose prefix names no key untouched', () => {
      expect(
        normalizeRefMarkersToCelPaths('__KUBERNETES_REF_svc_status.unknown[0].name__', context)
      ).toBe('svc.status.unknown[0].name');
    });
  });

  describe('structured-ref path', () => {
    it('resolves a direct ref whose field path carries an index', () => {
      expect(processResourceReferences(nestedRef('status.items[0].name'), context)).toBe(
        '${(innerService.status.loadBalancer.ingress)[0].name}'
      );
    });

    it('resolves a direct ref whose index ends the field path', () => {
      expect(processResourceReferences(nestedRef('status.items[0]'), context)).toBe(
        '${(innerService.status.loadBalancer.ingress)[0]}'
      );
    });

    it('resolves a status mapping ref whose field path carries an index', () => {
      expect(serializeStatusMappingsToCel({ url: nestedRef('status.ports["http"].port') }, table))
        .toEqual({ url: '${(innerService.status.portMap)["http"].port}' });
    });
  });

  it('does not let a key match across an index that sits between two names', () => {
    // `a[0].b` is NOT the key `a.b`: the index sits between the two names, so
    // matching there would drop it. Only the bare-name key `a` may match.
    const dotted = {
      '__nestedStatus:svc:a.b': 'SHOULD_NOT_APPEAR',
      '__nestedStatus:svc:a': 'innerService.status.alpha',
    };

    const result = inlineNestedStatusRefs('svc.status.a[0].b', dotted);

    expect(result).toBe('(innerService.status.alpha)[0].b');
    expect(result).not.toContain('SHOULD_NOT_APPEAR');
  });

  it('still matches a dotted key whose path carries no index', () => {
    const dotted = { '__nestedStatus:svc:a.b': 'innerService.status.alphaBeta' };

    expect(inlineNestedStatusRefs('svc.status.a.b[0]', dotted)).toBe(
      '(innerService.status.alphaBeta)[0]'
    );
  });
});

describe('nested-composition status inlining — dotted numeric index segments', () => {
  // A list index reaches the resolver in two spellings. A proxy renders a
  // numeric key as `[0]` (`schema-proxy.ts`), but `extractNestedStatusCel`
  // builds an array element's mapping key as `` `${fieldPath}.${index}` `` —
  // dotted — and the marker charset admits the dotted form too. Lexed as a bare
  // NAME, `0` emitted the postfix `.0.name`: `(inner).0.name` is not CEL (`.0`
  // is not a field select) and parses on neither engine, and the late
  // `normalizeCelArrayIndexPaths` sweep cannot rescue it because the postfix
  // follows a `)`. The two spellings also failed to name the same key.
  const table = {
    '__nestedStatus:svc:items': 'innerService.status.loadBalancer.ingress',
    '__nestedStatus:svc:a': 'innerService.status.alpha',
    '__nestedStatus:svc:v2': 'innerService.status.versionTwo',
  };

  const context: SerializationContext = {
    celPrefix: '',
    resourceIdStrategy: 'deterministic',
    nestedStatusCel: table,
  };

  function nestedRef(fieldPath: string): unknown {
    return {
      [KUBERNETES_REF_BRAND]: true,
      __nestedComposition: true,
      resourceId: 'svc',
      fieldPath,
    };
  }

  describe('regex path', () => {
    it('emits a dotted numeric segment as an index', () => {
      expect(inlineNestedStatusRefs('svc.status.items.0.name', table)).toBe(
        '(innerService.status.loadBalancer.ingress)[0].name'
      );
    });

    it('emits a run of dotted numeric segments as an index chain', () => {
      expect(inlineNestedStatusRefs('svc.status.a.0.1.b', table)).toBe(
        '(innerService.status.alpha)[0][1].b'
      );
    });

    it('emits a dotted numeric segment that ends the path as an index', () => {
      expect(inlineNestedStatusRefs('svc.status.items.0', table)).toBe(
        '(innerService.status.loadBalancer.ingress)[0]'
      );
    });

    it('normalizes both spellings in one path', () => {
      expect(inlineNestedStatusRefs('svc.status.items.0.ports[1].port', table)).toBe(
        '(innerService.status.loadBalancer.ingress)[0].ports[1].port'
      );
    });

    it('leaves an identifier that merely contains digits alone', () => {
      expect(inlineNestedStatusRefs('svc.status.v2.name', table)).toBe(
        '(innerService.status.versionTwo).name'
      );
      expect(inlineNestedStatusRefs('svc.status.items.ip4', table)).toBe(
        '(innerService.status.loadBalancer.ingress).ip4'
      );
      expect(inlineNestedStatusRefs('svc.status.items._0', table)).toBe(
        '(innerService.status.loadBalancer.ingress)._0'
      );
    });

    it('keeps a trailing method name off the key while indexing the path', () => {
      expect(inlineNestedStatusRefs('svc.status.items.0.size()', table)).toBe(
        '(innerService.status.loadBalancer.ingress)[0].size()'
      );
    });
  });

  describe('marker path', () => {
    // `KUBERNETES_REF_MARKER_FIELD_PATH_SOURCE` admits a dotted digit run
    // (`[a-zA-Z0-9$-]+` after a `.`), so this spelling really does arrive here.
    it('emits a dotted numeric segment as an index', () => {
      expect(
        normalizeRefMarkersToCelPaths('__KUBERNETES_REF_svc_status.items.0.name__', context)
      ).toBe('${(innerService.status.loadBalancer.ingress)[0].name}');
    });

    it('emits a run of dotted numeric segments as an index chain', () => {
      expect(normalizeRefMarkersToCelPaths('__KUBERNETES_REF_svc_status.a.0.1.b__', context)).toBe(
        '${(innerService.status.alpha)[0][1].b}'
      );
    });

    it('emits a dotted numeric segment that ends the path as an index', () => {
      expect(normalizeRefMarkersToCelPaths('__KUBERNETES_REF_svc_status.items.0__', context)).toBe(
        '${(innerService.status.loadBalancer.ingress)[0]}'
      );
    });

    it('normalizes both spellings in one field path', () => {
      expect(
        normalizeRefMarkersToCelPaths(
          '__KUBERNETES_REF_svc_status.items[0].ports.1.port__',
          context
        )
      ).toBe('${(innerService.status.loadBalancer.ingress)[0].ports[1].port}');
    });

    it('leaves an identifier that merely contains digits alone', () => {
      expect(normalizeRefMarkersToCelPaths('__KUBERNETES_REF_svc_status.v2.name__', context)).toBe(
        '${(innerService.status.versionTwo).name}'
      );
    });
  });

  describe('structured-ref path', () => {
    it('emits a dotted numeric segment as an index', () => {
      expect(processResourceReferences(nestedRef('status.items.0.name'), context)).toBe(
        '${(innerService.status.loadBalancer.ingress)[0].name}'
      );
    });

    it('emits a run of dotted numeric segments as an index chain', () => {
      expect(processResourceReferences(nestedRef('status.a.0.1.b'), context)).toBe(
        '${(innerService.status.alpha)[0][1].b}'
      );
    });

    it('emits a dotted numeric segment that ends the path as an index', () => {
      expect(processResourceReferences(nestedRef('status.items.0'), context)).toBe(
        '${(innerService.status.loadBalancer.ingress)[0]}'
      );
    });

    it('normalizes both spellings in one field path', () => {
      expect(
        serializeStatusMappingsToCel({ url: nestedRef('status.items[0].ports.1.port') }, table)
      ).toEqual({ url: '${(innerService.status.loadBalancer.ingress)[0].ports[1].port}' });
    });
  });

  describe('key spelling', () => {
    // Keys are stored under the DOTTED spelling, so that is the spelling a key
    // path is built in — reached from either spelling of the same path.
    const keyed = { '__nestedStatus:svc:components.0.ready': 'innerService.status.ready' };
    const keyedContext: SerializationContext = {
      celPrefix: '',
      resourceIdStrategy: 'deterministic',
      nestedStatusCel: keyed,
    };

    it('matches a dotted numeric key from the dotted path spelling', () => {
      expect(inlineNestedStatusRefs('svc.status.components.0.ready', keyed)).toBe(
        '(innerService.status.ready)'
      );
    });

    it('matches a dotted numeric key from the bracketed path spelling', () => {
      expect(
        normalizeRefMarkersToCelPaths(
          '__KUBERNETES_REF_svc_status.components[0].ready__',
          keyedContext
        )
      ).toBe('${innerService.status.ready}');
    });

    it('prefers the longest key over a shorter one plus an index postfix', () => {
      const both = {
        '__nestedStatus:svc:items.0': 'innerService.status.firstIngress',
        '__nestedStatus:svc:items': 'SHOULD_NOT_APPEAR',
      };
      const bothContext: SerializationContext = {
        celPrefix: '',
        resourceIdStrategy: 'deterministic',
        nestedStatusCel: both,
      };

      // Both spellings of the same path reach the longer key. Asserted on the
      // marker path: the regex token capture stops at `[`, so on THAT path the
      // bracketed index is never inside the match to be matched against a key.
      expect(inlineNestedStatusRefs('svc.status.items.0.name', both)).toBe(
        '(innerService.status.firstIngress).name'
      );
      expect(
        normalizeRefMarkersToCelPaths('__KUBERNETES_REF_svc_status.items[0].name__', bothContext)
      ).toBe('${(innerService.status.firstIngress).name}');
    });

    it('does not let a key match across a non-numeric index', () => {
      // `ports["http"].port` has no key spelling past the map key, so only the
      // bare-name key `ports` may match — matching `ports.port` would drop it.
      const mapKeyed = {
        '__nestedStatus:svc:ports.port': 'SHOULD_NOT_APPEAR',
        '__nestedStatus:svc:ports': 'innerService.status.portMap',
      };

      expect(inlineNestedStatusRefs('svc.status.ports["http"].port', mapKeyed)).toBe(
        '(innerService.status.portMap)["http"].port'
      );
    });

    it('leaves a leading numeric segment as a name', () => {
      // An index has to apply to something; a field path is rooted at a field,
      // so a leading digit run is not an index spelling and stays verbatim.
      const leading = { '__nestedStatus:svc:0.name': 'innerService.status.zeroName' };

      expect(
        normalizeRefMarkersToCelPaths('__KUBERNETES_REF_svc_status.0.name__', {
          celPrefix: '',
          resourceIdStrategy: 'deterministic',
          nestedStatusCel: leading,
        })
      ).toBe('${innerService.status.zeroName}');
    });
  });
});

describe('normalizeCelArrayIndexPaths — dotted numeric runs', () => {
  // The late sweep decides whether a `.<digits>` run is an index from the text
  // it has already EMITTED, so a run of them chains. Reading the left context
  // off the INPUT instead stopped after the first run — the second run's left
  // neighbour was the digit the first run had just consumed — and produced
  // `a[0].1.b`, which is no more valid CEL than what it started from.

  it('chains consecutive numeric runs into an index chain', () => {
    expect(normalizeCelArrayIndexPaths('a.0.1.b')).toBe('a[0][1].b');
  });

  it('indexes numeric runs separated by a name', () => {
    expect(normalizeCelArrayIndexPaths('a.0.b.1')).toBe('a[0].b[1]');
  });

  it('indexes a numeric run that follows an existing bracket index', () => {
    expect(normalizeCelArrayIndexPaths('list[0].1')).toBe('list[0][1]');
  });

  it('indexes a numeric run after an identifier whose tail is digits', () => {
    // `v2.0` can only be an index: a NUMBER may not begin with an identifier
    // character, so `v2.0` is not a float literal the way `1.0` is.
    expect(normalizeCelArrayIndexPaths('v2.0')).toBe('v2[0]');
  });

  it('leaves an identifier that merely contains digits alone', () => {
    expect(normalizeCelArrayIndexPaths('v2.name')).toBe('v2.name');
  });

  it('keeps a chained index in front of a method call', () => {
    expect(normalizeCelArrayIndexPaths('a.0.1.size()')).toBe('a[0][1].size()');
  });

  it('leaves a float literal alone', () => {
    expect(normalizeCelArrayIndexPaths('x == 1.0')).toBe('x == 1.0');
  });

  it('leaves an exponent literal alone', () => {
    expect(normalizeCelArrayIndexPaths('y > 2.5e3')).toBe('y > 2.5e3');
  });

  it('leaves a leading fraction alone', () => {
    expect(normalizeCelArrayIndexPaths('.5 + a.0')).toBe('.5 + a[0]');
  });

  it('leaves a numeric run inside a string literal alone', () => {
    expect(normalizeCelArrayIndexPaths('"a.0.1"')).toBe('"a.0.1"');
    expect(normalizeCelArrayIndexPaths("'a.0.1' + b.0.1")).toBe("'a.0.1' + b[0][1]");
  });

  it('normalizes a template embedded in URL text', () => {
    // The `//` of a scheme is a CEL `COMMENT`, so this sweep cannot take its
    // lexing from the comment-aware scanner: masking the comment would blank
    // the template that follows and drop the rewrite.
    expect(normalizeCelArrayIndexPaths('http://${string(service.spec.ports.0.port)}')).toBe(
      'http://${string(service.spec.ports[0].port)}'
    );
  });
});

describe('nested-composition status inlining — canonical mapping identity', () => {
  it('detects a cycle that turns a corner through an alias spelling', () => {
    // `webAppStack2` is not a key; it reaches `__nestedStatus:webAppStack1:ready`
    // through the base-name strategy. Keyed by the token's own spelling the
    // cycle is invisible and the mapping gets expanded a second time.
    const table = { '__nestedStatus:webAppStack1:ready': 'webAppStack2.status.ready' };
    const warnSpy = spyOnLoggerWarn();
    try {
      const { text, stats } = inlineNestedStatusRefsWithStats('webAppStack1.status.ready', table);

      expect(stats.cycleHits).toBe(1);
      expect(stats.depthExceeded).toBe(false);
      expect(text).toBe('(webAppStack2.status.ready)');
      expect(
        warnSpy.mock.calls.filter(
          ([message]) => message === 'Nested composition resolution depth limit exceeded'
        )
      ).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('serves a second alias spelling of one entry from the memo', () => {
    const table = {
      '__nestedStatus:webAppStack1:ready': 'leafWorkload.status.readyReplicas >= 1',
      '__nestedStatus:consumer:ready': 'webAppStack1.status.ready && webAppStack2.status.ready',
    };

    const { text, stats } = inlineNestedStatusRefsWithStats('consumer.status.ready', table);

    expect(text).toBe(
      '((leafWorkload.status.readyReplicas >= 1) && (leafWorkload.status.readyReplicas >= 1))'
    );
    // One pass for the input, one for `consumer`, one for the shared entry. The
    // second spelling resolves to the same canonical key and hits the memo.
    expect(stats.textPasses).toBe(3);
    expect(stats.memoHits).toBe(1);
  });
});
