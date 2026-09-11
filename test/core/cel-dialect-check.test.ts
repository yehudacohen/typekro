/**
 * Serialization-time dual-dialect check.
 *
 * Every emitted status expression is run through cel-js and through a curated
 * denylist of confirmed cel-js/cel-go divergences. Each denylisted form must be
 * rejected with the dialect that rejects it named; the one blessed guard form
 * must pass both.
 */

import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { TypeKroError } from '../../src/core/errors.js';
import { KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import { Cel, type LoadBalancerServiceRef } from '../../src/core/references/cel.js';
import { simple, toResourceGraph } from '../../src/index.js';
import {
  CEL_DIALECT_MAX_EXCERPT_LENGTH,
  CEL_DIALECT_MAX_EXPRESSION_LENGTH,
  CEL_DIALECT_RULES,
  type CelDialectFinding,
  checkCelDialectCompatibility,
  collectStatusCelDialectFindings,
  formatCelDialectFindings,
  hasCelDialectDivergence,
} from '../../src/core/validation/cel-dialect.js';

function check(expression: string): CelDialectFinding[] {
  return checkCelDialectCompatibility(expression, 'endpoint');
}

/** The `webService` Service, as the graph would hand it to a status builder. */
function webService(): LoadBalancerServiceRef {
  return {
    status: {
      loadBalancer: {
        ingress: {
          [KUBERNETES_REF_BRAND]: true,
          resourceId: 'webService',
          fieldPath: 'status.loadBalancer.ingress',
        } as unknown as readonly { ip?: string; hostname?: string }[],
      },
    },
  };
}

/**
 * Pad an expression out to `length` characters with a string literal, so the
 * padded form stays valid CEL and keeps whatever denylisted form it carries.
 */
function padded(prefix: string, suffix: string, length: number): string {
  return `${prefix}"${'p'.repeat(Math.max(0, length - prefix.length - suffix.length - 2))}"${suffix}`;
}

describe('curated denylist', () => {
  it('names a dialect, a kind and a documented observation for every rule', () => {
    for (const rule of CEL_DIALECT_RULES) {
      expect(['cel-js', 'cel-go', 'both', 'unchecked']).toContain(rule.dialect);
      expect(['divergence', 'note']).toContain(rule.kind);
      expect(rule.summary.length).toBeGreaterThan(0);
      expect(rule.observed.length).toBeGreaterThan(0);
    }
  });

  it('only names a single engine for a rule that claims a divergence', () => {
    // A divergence is one engine behaving differently from the other. 'both'
    // (neither accepts it) and 'unchecked' (no verdict) cannot be divergences.
    for (const rule of CEL_DIALECT_RULES) {
      if (rule.kind !== 'divergence') continue;
      expect(['cel-js', 'cel-go']).toContain(rule.dialect);
    }
  });
});

describe('checkCelDialectCompatibility', () => {
  it('rejects has() on an index expression, naming cel-js', () => {
    const findings = check('has(webService.status.loadBalancer.ingress[0].ip)');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('has-index-argument');
    expect(findings[0]?.kind).toBe('divergence');
    expect(findings[0]?.dialect).toBe('cel-js');
    expect(findings[0]?.field).toBe('endpoint');
    expect(findings[0]?.fragment).toBe('has(webService.status.loadBalancer.ingress[0].ip)');
  });

  it('rejects has() on a map-key index too, which is the same cel-js refusal', () => {
    // cel-js throws "has() does not support atomic expressions" for the operand
    // shape, whatever the index is. The rule therefore needs no claim about
    // whether the indexed thing is a list or a map.
    const findings = check('has(config.metadata.annotations["typekro.dev/host"].value)');

    expect(findings.map((found) => found.rule)).toEqual(['has-index-argument']);
    expect(findings[0]?.kind).toBe('divergence');
  });

  it('notes — but does not fail — `in` on something that may be a list entry', () => {
    // Whether cel-go types this entry as a message (which rejects `in`) or as a
    // map (which accepts it) is a fact about the resource schema that the
    // checker cannot see, so it may not fail strict mode on it.
    for (const expression of [
      '"ip" in webService.status.loadBalancer.ingress[0]',
      'webService.status.loadBalancer.ingress.exists(e, "ip" in e)',
    ]) {
      const findings = check(expression);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe('in-on-list-entry');
      expect(findings[0]?.kind).toBe('note');
      expect(findings[0]?.dialect).toBe('cel-go');
    }
  });

  it('rejects a has() guard written to the right of the access it guards', () => {
    const findings = check(
      'size(webService.status.loadBalancer.ingress) > 0 && has(webService.status.loadBalancer.ingress)'
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('guard-after-use-in-logical-chain');
    expect(findings[0]?.dialect).toBe('cel-js');
    expect(findings[0]?.message).toContain('cel-go absorbs the error');
  });

  /**
   * A guard already written to the left can make a later one redundant, but
   * only if it actually says the later guard's path is present. Reaching a path
   * and establishing it are different relations, and they point opposite ways
   * along the same prefix chain.
   */
  describe('an earlier guard only excuses a late one if it establishes it', () => {
    it('flags a late guard that a shallower earlier guard does not establish', () => {
      // has(a.status) says the status object is there. It says nothing about
      // a.status.list, so cel-js still fails on a.status.list[0] before it ever
      // reaches the late has() — which is exactly the divergence this rule is
      // for. Treating the shallower guard as cover hid it.
      const findings = check('has(a.status) && a.status.list[0].f != "" && has(a.status.list)');

      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe('guard-after-use-in-logical-chain');
      expect(findings[0]?.dialect).toBe('cel-js');
    });

    it('passes a late guard the same earlier guard already established', () => {
      // Redundant, but harmless: the access is guarded before it happens.
      expect(
        check('has(a.status.list) && a.status.list[0].f != "" && has(a.status.list)')
      ).toEqual([]);
    });

    it('passes a late guard a deeper earlier guard established', () => {
      // has(a.status.list.deeper) evaluates its receiver before testing the last
      // field, so for it to have returned true rather than errored, a.status.list
      // was present. The later has(a.status.list) adds nothing and breaks nothing.
      expect(
        check('has(a.status.list.deeper) && a.status.list[0].f != "" && has(a.status.list)')
      ).toEqual([]);
    });

    it('leaves an unguarded access with no late guard alone', () => {
      // No has() to the right of the access, so this rule has nothing to say —
      // indexing a list is valid on both engines.
      expect(check('has(a.status) && a.status.list[0].f != ""')).toEqual([]);
    });
  });

  /**
   * A logical chain is not a flat operand list. `&&` binds tighter than `||`,
   * and the two operators are decided by opposite values — `&&` by `false`,
   * `||` by `true` — so which `has()` form guards, and which one is the
   * divergent late guard, follows the operator.
   *
   * Every case below is stated as what the two engines do on data where the
   * guarded path is absent, since that is the only data that can separate them.
   */
  describe('operator precedence and guard polarity', () => {
    describe('precedence: a guard reaches only its own || disjunct', () => {
      it('reports a late guard an earlier disjunct appears to cover but does not', () => {
        // `has(l) || (l[0].f != "" && has(l))`. With `l` absent the left
        // disjunct is false and decides nothing, so the right one runs: cel-js
        // errors on `l[0]`, cel-go absorbs that error under the deciding
        // `false` from the late `has(l)` and yields `false || false` = false.
        // Reading the chain flat would let the leading `has(l)` excuse the late
        // guard, and the divergence would go unreported.
        const findings = check(
          'has(a.status.list) || a.status.list[0].f != "" && has(a.status.list)'
        );

        expect(findings).toHaveLength(1);
        expect(findings[0]?.rule).toBe('guard-after-use-in-logical-chain');
        expect(findings[0]?.fragment).toBe('a.status.list[0].f != ""');
      });

      it('passes the same chain when the earlier disjunct really does establish the path', () => {
        // `!has(l) || (l[0].f != "" && has(l))`. Now the left disjunct is
        // *true* when `l` is absent, so the chain short-circuits and the access
        // is never reached — on either engine. What a disjunct establishes also
        // carries into the `&&` chain nested inside the next one.
        expect(
          check('!has(a.status.list) || a.status.list[0].f != "" && has(a.status.list)')
        ).toEqual([]);
      });
    });

    describe('|| polarity: has() does not guard, !has() does', () => {
      it('does not report a trailing has() in an || chain', () => {
        // `l[0].f != "" || has(l)`. With `l` absent cel-js errors on the left,
        // and cel-go's absorbed error meets `false` — which decides nothing —
        // so cel-go errors too. Both engines error: a defect, but not a
        // divergence, and this rule may only fail strict mode on a divergence.
        expect(check('a.status.list[0].f != "" || has(a.status.list)')).toEqual([]);
      });

      it('passes !has() written before the access, which is the || guard form', () => {
        expect(check('!has(a.status.list) || a.status.list[0].f != ""')).toEqual([]);
      });

      it('leaves has() written before the access in an || chain alone', () => {
        // Not a guard — with `l` absent both engines error — but not a
        // divergence either, so there is nothing for this rule to report.
        expect(check('has(a.status.list) || a.status.list[0].f != ""')).toEqual([]);
      });
    });

    describe('&& polarity: a negated guard establishes nothing', () => {
      it('reports a late guard that a negated earlier guard appears to cover', () => {
        // `!has(l) && l[0].f != "" && has(l)`. With `l` absent the first
        // operand is *true*, so the chain carries on into the access: cel-js
        // errors, cel-go absorbs it under the deciding `false` from `has(l)`.
        // Ignoring the `!` would treat the first operand as establishing `l`.
        const findings = check(
          '!has(a.status.list) && a.status.list[0].f != "" && has(a.status.list)'
        );

        expect(findings).toHaveLength(1);
        expect(findings[0]?.rule).toBe('guard-after-use-in-logical-chain');
      });

      it('passes the same chain with the guard unnegated', () => {
        expect(
          check('has(a.status.list) && a.status.list[0].f != "" && has(a.status.list)')
        ).toEqual([]);
      });
    });

    describe('the late-guard mirror in an || chain', () => {
      it('reports a trailing !has() written after the access it guards', () => {
        // `l[0].f != "" || !has(l)`. With `l` absent cel-js errors; cel-go
        // absorbs the error under the deciding `true` and yields true.
        const findings = check('a.status.list[0].f != "" || !has(a.status.list)');

        expect(findings).toHaveLength(1);
        expect(findings[0]?.rule).toBe('guard-after-use-in-logical-chain');
        expect(findings[0]?.message).toContain('!has(a.status.list) guards this operand');
        expect(findings[0]?.suggestion).toContain('Move !has(a.status.list) to the left');
      });

      it('leaves the same trailing !has() in an && chain alone', () => {
        // `l[0].f != "" && !has(l)`: cel-go's absorbed error meets `true`,
        // which decides nothing, so cel-go errors where cel-js errors.
        expect(check('a.status.list[0].f != "" && !has(a.status.list)')).toEqual([]);
      });
    });

    describe('group negation, and where the lexical reading stops', () => {
      it('reads !(has(p)) the same as !has(p), in both directions', () => {
        expect(check('a.status.list[0].f != "" || !(has(a.status.list))')).toHaveLength(1);
        expect(
          check('!(has(a.status.list)) || a.status.list[0].f != "" && has(a.status.list)')
        ).toEqual([]);
      });

      it('does not read a negated compound as a guard, and so still reports', () => {
        // `!(has(l) && x.y)` is true whenever `l` is absent, so the access is
        // reached and the chain does diverge. The checker gets there by
        // refusing to read the compound as a guard at all rather than by
        // reasoning about it — the conservative reading, and the right answer.
        expect(
          check('!(has(a.status.list) && x.y) && a.status.list[0].f != "" && has(a.status.list)')
        ).toHaveLength(1);
      });

      it('carries an established path into a parenthesized group', () => {
        expect(
          check('has(a.status.list) && (a.status.list[0].f != "" && has(a.status.list))')
        ).toEqual([]);
        expect(
          check('has(a.other) && (a.status.list[0].f != "" && has(a.status.list))')
        ).toHaveLength(1);
      });
    });
  });

  it('reports text that is not CEL at all against both dialects, as a note', () => {
    // JavaScript that leaked through the expression converter. A real defect,
    // but the same defect on cel-js and cel-go, so not a divergence.
    for (const expression of [
      'webService.status.loadBalancer.ingress?[0]?.ip',
      'appService.status.loadBalancer?.ingress?[0]?.ip',
      'configmapPlatformConfig.data.?region',
      '[a.status.x.length > 0 ? "a" : ""].filter(s, s != "")',
    ]) {
      const findings = check(expression);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe('not-valid-cel');
      expect(findings[0]?.kind).toBe('note');
      expect(findings[0]?.dialect).toBe('both');
    }
  });
});


/**
 * A CEL map literal is not portable unless its values share one type.
 *
 * cel-js takes the map's value type from the first entry and throws
 * `invalid_argument` on the first entry that differs, so it cannot build
 * `{"name": "http", "port": 80}` at all; cel-go types such a literal as
 * `map(string, dyn)` and evaluates it. That is a divergence established without
 * any schema — the differing types are written out in the literal — and it
 * matters here because a structured projection fallback emits exactly this
 * shape.
 */
describe('heterogeneous map literals', () => {
  it('rejects a map mixing a string and an int value, naming cel-js', () => {
    const findings = check('has(a.b) ? a.b : dyn({"name": "http", "port": 80})');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('heterogeneous-map-literal');
    expect(findings[0]?.kind).toBe('divergence');
    expect(findings[0]?.dialect).toBe('cel-js');
    expect(findings[0]?.fragment).toBe('{"name": "http", "port": 80}');
    expect(findings[0]?.message).toContain('cannot evaluate this map at all');
  });

  it('separates int from double, because cel-js does', () => {
    expect(check('{"a": 1, "b": 2.5}').map((found) => found.rule)).toEqual([
      'heterogeneous-map-literal',
    ]);
  });

  it('reaches a map nested inside a list literal', () => {
    expect(check('{"ports": [{"protocol": "TCP", "port": 8080}]}').map((f) => f.rule)).toEqual([
      'heterogeneous-map-literal',
    ]);
  });

  it('accepts maps whose values share a type, and the empty map', () => {
    for (const expression of [
      '{"name": "http", "host": "edge.example.test"}',
      '{"a": 1, "b": 2, "c": 3}',
      '{"a": true, "b": false}',
      '{}',
      '{"only": 1}',
      // Lists have no such restriction: cel-js evaluates a mixed list happily.
      '[1, "a", true]',
      '[]',
    ]) {
      expect(check(expression)).toEqual([]);
    }
  });

  it('does not read a separator out of a string literal', () => {
    // `, ` and `: ` inside the quoted value are data, not structure. Splitting
    // the unmasked text would see three entries here and two value types.
    expect(check('{"msg": "a, b: c", "other": "x"}')).toEqual([]);
  });

  it('says nothing about a value whose type the syntax does not settle', () => {
    // An identifier, a call or a ternary may well be the type that trips
    // cel-js, but the checker cannot tell, and under-reporting is the only safe
    // direction for a rule that fails strict mode.
    for (const expression of [
      '{"zone": config.data.zone, "count": 1}',
      '{"a": x ? 1 : 2, "b": "s"}',
      '{"a": size(l), "b": "s"}',
      '{"a": 1 + 2, "b": "s"}',
    ]) {
      expect(check(expression).map((found) => found.rule)).not.toContain(
        'heterogeneous-map-literal'
      );
    }
  });
});
/**
 * A rule may only fail strict mode when the two engines actually diverge. These
 * pin the forms that were being failed before and are valid on both engines, so
 * a future rule cannot quietly start rejecting them again.
 */
describe('forms that are not a divergence', () => {
  it('accepts indexing a required list inside a logical chain', () => {
    // On an empty list cel-js short-circuits on the `false` and never indexes;
    // cel-go absorbs the index error under the deciding `false`. Both yield
    // false. On an out-of-range index with nothing to decide the result, both
    // error. No data separates the engines.
    expect(
      check(
        'size(webService.status.loadBalancer.ingress) > 0 && webService.status.loadBalancer.ingress[0].ip != ""'
      )
    ).toEqual([]);
  });

  it('accepts indexing a required list on either side of || as well', () => {
    expect(
      check('deployment.spec.template.spec.containers[0].image != "" || deployment.spec.paused')
    ).toEqual([]);
  });

  it('accepts a map lookup that is not inside has()', () => {
    expect(
      check('config.metadata.annotations["typekro.dev/enabled"] == "true" && other.spec.replicas > 0')
    ).toEqual([]);
  });

  it('never reports the rule that was removed', () => {
    expect(CEL_DIALECT_RULES.map((rule) => rule.id)).not.toContain(
      'unguarded-index-in-logical-chain'
    );
  });
});

describe('forms both dialects accept', () => {
  it('passes the blessed filter-inside-a-lazy-ternary form', () => {
    const blessed = (
      Cel.loadBalancerAddress(webService(), 'ip') as unknown as { expression: string }
    ).expression;

    expect(blessed).toContain('filter(entry, has(entry.ip))');
    expect(check(blessed)).toEqual([]);
  });

  it('passes a guard written before the access it guards', () => {
    expect(
      check(
        'has(webService.status.loadBalancer) && size(webService.status.loadBalancer.ingress) > 0'
      )
    ).toEqual([]);
  });

  it('passes an ordinary multi-resource readiness conjunction', () => {
    expect(
      check('deployment.status.readyReplicas > 0 && webService.status.clusterIP != ""')
    ).toEqual([]);
  });

  it('passes a condition guarded per entry inside a collection macro', () => {
    expect(
      check(
        'has(release.status.conditions) && release.status.conditions.exists(c, c.type == "Ready" && c.status == "True" && (has(c.observedGeneration) ? c.observedGeneration >= release.metadata.generation : true))'
      )
    ).toEqual([]);
  });

  it('does not treat a map lookup as a list index', () => {
    expect(
      check(
        'config.metadata.annotations["typekro.dev/enabled"] != "true" || other.metadata.name != ""'
      )
    ).toEqual([]);
  });
});

/**
 * Both halves of the check — cel-js's parser and the denylist walk — are linear
 * in the length of the expression, so an expression that has run away makes the
 * check run away with it: a 6MB status field cost ~6.5s to analyze and, having
 * no denylisted form in it, reported nothing for the trouble.
 *
 * These tests pin that an over-budget expression *skips* both halves rather
 * than merely running them faster, without measuring wall-clock: each one feeds
 * the same denylisted content under and over the budget, and the rule that fires
 * under the budget must be absent over it.
 */
describe('analysis budget', () => {
  /**
   * The self-nesting shape the nested-composition inliner produces: each level
   * substitutes a fragment that still contains the reference it replaced, so the
   * expression doubles per level.
   */
  function runaway(levels: number): string {
    let expression = 'service1.status.phase != null ? service1.status.phase : "Pending"';
    for (let level = 0; level < levels; level += 1) {
      expression = `(${expression}) != null ? (${expression}) : "Pending"`;
    }
    return expression;
  }

  it('reports the size itself, once, for an expression past the budget', () => {
    const expression = runaway(12);
    expect(expression.length).toBeGreaterThan(CEL_DIALECT_MAX_EXPRESSION_LENGTH);

    const findings = check(expression);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('expression-too-large');
    expect(findings[0]?.dialect).toBe('unchecked');
    expect(findings[0]?.field).toBe('endpoint');
    expect(findings[0]?.message).toContain(String(expression.length));
  });

  it('leaves cel-js unasked once the expression is over budget', () => {
    // Identical malformed text either side of the budget. Under it cel-js is
    // consulted and rejects it; over it the absence of that rejection is the
    // evidence that the parser was never invoked.
    const malformed = '!!!(((';
    const under = malformed.repeat(4);
    const over = malformed.repeat(
      Math.ceil(CEL_DIALECT_MAX_EXPRESSION_LENGTH / malformed.length) + 1
    );
    expect(under.length).toBeLessThanOrEqual(CEL_DIALECT_MAX_EXPRESSION_LENGTH);
    expect(over.length).toBeGreaterThan(CEL_DIALECT_MAX_EXPRESSION_LENGTH);

    expect(check(under).map((found) => found.rule)).toEqual(['not-valid-cel']);
    expect(check(over).map((found) => found.rule)).toEqual(['expression-too-large']);
  });

  it('leaves the denylist rules unrun once the expression is over budget', () => {
    const prefix = 'has(webService.status.loadBalancer.ingress[0].ip) ? ';
    const suffix = ' : ""';
    const under = padded(prefix, suffix, CEL_DIALECT_MAX_EXPRESSION_LENGTH);
    const over = padded(prefix, suffix, CEL_DIALECT_MAX_EXPRESSION_LENGTH + 1_000);
    expect(under.length).toBeLessThanOrEqual(CEL_DIALECT_MAX_EXPRESSION_LENGTH);
    expect(over.length).toBeGreaterThan(CEL_DIALECT_MAX_EXPRESSION_LENGTH);

    expect(check(under).map((found) => found.rule)).toEqual(['has-index-argument']);
    expect(check(over).map((found) => found.rule)).toEqual(['expression-too-large']);
  });

  it('carries a bounded excerpt rather than the whole expression', () => {
    const expression = runaway(14);
    expect(expression.length).toBeGreaterThan(1_000_000);

    const findings = check(expression);

    expect(findings[0]?.expression.length).toBeLessThan(1_000);
    expect(findings[0]?.expression.endsWith('…')).toBe(true);
  });

  it('reports an oversize leaf once, not once per nested occurrence', () => {
    const findings = collectStatusCelDialectFindings({
      servicePhase: `\${${runaway(12)}}`,
      ready: '${deployment.status.readyReplicas > 0}',
    });

    expect(findings.map((found) => `${found.field}:${found.rule}`)).toEqual([
      'servicePhase:expression-too-large',
    ]);
  });

  it('formats an unchecked finding as not checked rather than rejected', () => {
    const report = formatCelDialectFindings(check(runaway(12)));

    expect(report).toContain('status.endpoint: not checked [expression-too-large, note]');
    expect(report).not.toContain('rejected by');
  });
});

describe('collectStatusCelDialectFindings', () => {
  it('walks nested status shapes and reports the full leaf path', () => {
    const findings = collectStatusCelDialectFindings({
      ready: '${deployment.status.readyReplicas > 0}',
      loadBalancer: {
        ip: '${has(webService.status.loadBalancer.ingress[0].ip)}',
      },
      addresses: ['${"ip" in webService.status.loadBalancer.ingress[0]}'],
      staticField: 'not-an-expression',
    });

    expect(findings.map((found) => `${found.field}:${found.dialect}:${found.kind}`)).toEqual([
      'loadBalancer.ip:cel-js:divergence',
      'addresses[0]:cel-go:note',
    ]);
  });

  it('formats findings with the leaf, the dialect and the expression', () => {
    const report = formatCelDialectFindings(
      collectStatusCelDialectFindings({
        endpoint: '${has(webService.status.loadBalancer.ingress[0].ip)}',
      })
    );

    expect(report).toContain('status.endpoint');
    expect(report).toContain('rejected by cel-js');
    expect(report).toContain('expression: has(webService.status.loadBalancer.ingress[0].ip)');
    expect(report).toContain('Cel.firstWhereHas()');
  });
});

describe('serialization-time gate', () => {
  const AppSpec = type({ name: 'string' });
  const AppStatus = type({ ready: 'boolean', endpoint: 'string' });

  function buildGraph(endpoint: ReturnType<typeof Cel.expr<string>>) {
    return toResourceGraph(
      {
        name: 'cel-dialect-gate-test',
        apiVersion: 'example.com/v1',
        kind: 'CelDialectGateTest',
        spec: AppSpec,
        status: AppStatus,
      },
      (schema) => ({
        webService: simple.Service({
          name: schema.spec.name,
          selector: { app: 'cel-dialect-gate-test' },
          ports: [{ port: 80 }],
          id: 'webService',
        }),
      }),
      () => ({
        ready: Cel.expr<boolean>('webService.metadata.name != ""'),
        endpoint,
      })
    );
  }

  const divergent = () =>
    Cel.expr<string>('has(webService.status.loadBalancer.ingress[0].ip) ? "up" : ""');

  it('fails toYaml() in strict mode with the leaf, the expression and the dialect', () => {
    const factory = buildGraph(divergent()).factory('kro', { strictCelDiagnostics: true });

    expect(() => factory.toYaml()).toThrow(TypeKroError);
    try {
      factory.toYaml();
      throw new Error('expected toYaml to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeKroError);
      const message = (error as TypeKroError).message;
      expect(message).toContain('cel-dialect-gate-test');
      expect(message).toContain('status.endpoint');
      expect(message).toContain('rejected by cel-js');
      expect(message).toContain('has(webService.status.loadBalancer.ingress[0].ip)');
    }
  });

  it('emits the expression and warns (lenient) without the option', () => {
    const yaml = buildGraph(divergent()).factory('kro').toYaml();

    expect(yaml).toContain('has(webService.status.loadBalancer.ingress[0].ip)');
  });

  it('accepts the helper-emitted form even in strict mode', () => {
    const factory = buildGraph(
      Cel.loadBalancerAddress(webService(), 'ip') as ReturnType<typeof Cel.expr<string>>
    ).factory('kro', { strictCelDiagnostics: true });

    expect(factory.toYaml()).toContain('filter(entry, has(entry.ip))');
  });

  it('does not fail strict mode on a note, only on a divergence', () => {
    // `in` on something that may be a list entry: reported, because it may be a
    // real cel-go rejection, but the check cannot establish the entry's type, so
    // failing here would reject CEL that is valid against the actual schema.
    const noted = Cel.expr<string>(
      '"ip" in webService.status.loadBalancer.ingress[0] ? "up" : ""'
    );
    const factory = buildGraph(noted).factory('kro', { strictCelDiagnostics: true });

    expect(factory.toYaml()).toContain('"ip" in webService.status.loadBalancer.ingress[0]');
  });

  it('does not fail strict mode on emitted text that is not CEL at all', () => {
    // Converter leakage. A defect, and one to fix — but both engines reject it
    // identically, so it is not the dual-dialect check's verdict to fail on.
    const leaked = Cel.expr<string>('webService.status.loadBalancer.ingress?[0]?.ip');
    const factory = buildGraph(leaked).factory('kro', { strictCelDiagnostics: true });

    expect(factory.toYaml()).toContain('webService.status.loadBalancer.ingress?[0]?.ip');
  });

  it('names only the divergences in the strict-mode failure it raises', () => {
    const mixed = Cel.expr<string>(
      'has(webService.status.loadBalancer.ingress[0].ip) && "ip" in webService.status.loadBalancer.ingress[0] ? "up" : ""'
    );
    const factory = buildGraph(mixed).factory('kro', { strictCelDiagnostics: true });

    try {
      factory.toYaml();
      throw new Error('expected toYaml to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeKroError);
      const message = (error as TypeKroError).message;
      expect(message).toContain('has-index-argument, divergence');
      expect(message).not.toContain('in-on-list-entry');
    }
  });
});

/**
 * The analysis budget is a ceiling on work, so it is only worth having if the
 * work under it is actually bounded. These feed the shapes that stress the walk
 * hardest — deep parenthesis nesting, a very wide `&&` chain, nested ternaries —
 * at the budget, and pin that each stays well inside a single-digit fraction of
 * a second rather than growing super-linearly the way the 6MB expression did.
 */
describe('analysis cost at the budget', () => {
  function atBudget(build: (target: number) => string): string {
    return build(CEL_DIALECT_MAX_EXPRESSION_LENGTH - 100).slice(
      0,
      CEL_DIALECT_MAX_EXPRESSION_LENGTH
    );
  }

  const shapes: Record<string, (target: number) => string> = {
    'deeply nested parentheses': (target) => {
      let expression = 'a.b != "" && c.d != ""';
      while (expression.length + 2 < target) expression = `(${expression})`;
      return expression;
    },
    'a very wide && chain': (target) => {
      const parts: string[] = [];
      while (parts.join(' && ').length < target) {
        parts.push(`r${parts.length}.status.f${parts.length} != ""`);
      }
      return parts.join(' && ');
    },
    'nested ternaries': (target) => {
      let expression = '"x"';
      while (expression.length < target) {
        expression = `(a.b ? ${expression} : ${expression.slice(0, 40)})`;
      }
      return expression;
    },
  };

  for (const [name, build] of Object.entries(shapes)) {
    it(`stays bounded on ${name}`, () => {
      const expression = atBudget(build);
      expect(expression.length).toBeGreaterThan(CEL_DIALECT_MAX_EXPRESSION_LENGTH / 2);

      const started = performance.now();
      checkCelDialectCompatibility(expression, 'endpoint');
      const elapsed = performance.now() - started;

      // Measured at ~75ms for the worst of these on a development laptop; the
      // ceiling is generous so a slower CI box does not make this flaky, while
      // still catching a regression to quadratic behaviour.
      expect(elapsed).toBeLessThan(2_000);
    });
  }
});

describe('report excerpts', () => {
  it('bounds the expression it quotes, whatever the caller hands it', () => {
    // The budget already keeps checkCelDialectCompatibility from producing one
    // this large, but formatCelDialectFindings is exported and takes findings
    // from wherever the caller got them.
    const report = formatCelDialectFindings([
      {
        rule: 'has-index-argument',
        kind: 'divergence',
        dialect: 'cel-js',
        field: 'endpoint',
        expression: 'x'.repeat(5_000_000),
        fragment: 'y'.repeat(5_000_000),
        message: 'message',
        suggestion: 'suggestion',
      },
    ]);

    expect(report.length).toBeLessThan(4 * CEL_DIALECT_MAX_EXCERPT_LENGTH);
    expect(report).toContain('(5000000 characters)');
  });

  it('quotes a short expression whole', () => {
    const report = formatCelDialectFindings(
      check('has(webService.status.loadBalancer.ingress[0].ip)')
    );

    expect(report).toContain('expression: has(webService.status.loadBalancer.ingress[0].ip)');
    expect(report).not.toContain('characters)');
  });
});

describe('hasCelDialectDivergence', () => {
  it('is false for a set of notes and true as soon as one divergence is present', () => {
    const notes = check('"ip" in webService.status.loadBalancer.ingress[0]');
    const divergence = check('has(webService.status.loadBalancer.ingress[0].ip)');

    expect(notes.length).toBeGreaterThan(0);
    expect(hasCelDialectDivergence(notes)).toBe(false);
    expect(hasCelDialectDivergence(divergence)).toBe(true);
    expect(hasCelDialectDivergence([...notes, ...divergence])).toBe(true);
    expect(hasCelDialectDivergence([])).toBe(false);
  });
});
