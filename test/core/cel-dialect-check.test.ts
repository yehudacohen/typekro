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
import { Cel } from '../../src/core/references/cel.js';
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
      Cel.loadBalancerAddress('webService', 'ip') as unknown as { expression: string }
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
      Cel.loadBalancerAddress('webService', 'ip') as ReturnType<typeof Cel.expr<string>>
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
