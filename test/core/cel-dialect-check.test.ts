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
import { parse } from 'cel-js';
import { TypeKroError } from '../../src/core/errors.js';
import { KUBERNETES_REF_BRAND } from '../../src/core/constants/brands.js';
import { Cel, type LoadBalancerServiceRef } from '../../src/core/references/cel.js';
import { simple, toResourceGraph } from '../../src/index.js';
import {
  CEL_DIALECT_MAX_EXCERPT_LENGTH,
  CEL_DIALECT_MAX_EXPRESSION_LENGTH,
  CEL_DIALECT_RULES,
  type CelDialectFinding,
  celDialectLexicalGap,
  celDialectParseProof,
  celDialectWorkStats,
  checkCelDialectCompatibility,
  collectStatusCelDialectFindings,
  formatCelDialectFindings,
  hasCelDialectDivergence,
  resetCelDialectWorkStats,
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

  /**
   * Parsing is not evaluating. cel-go's type checker runs after the parse with
   * KRO's type environment and function set, and it rejects grammatical CEL —
   * `1.string()` parses and the checker still refuses it, `string` being a
   * global conversion function rather than a member. Nothing in this module
   * models that checker, so nothing in it may promise what KRO does.
   */
  it('never promises that KRO resolves or serves the field', () => {
    const overclaims = [
      /resolves under KRO/i,
      /the field resolves/i,
      /KRO (?:will |does )?serves?\b/i,
      /works in Kro mode/i,
      /KRO will (?:serve|evaluate)/i,
    ];
    for (const rule of CEL_DIALECT_RULES) {
      for (const pattern of overclaims) {
        expect(rule.observed).not.toMatch(pattern);
      }
    }
  });

  it('says so in the message of every divergence a rule can raise', () => {
    // Each divergence-kind rule, exercised through a real expression, must bound
    // itself to direct mode and leave KRO's verdict to cel-go's type checker.
    const raises: Record<string, string> = {
      'has-index-argument': 'has(a.list[0].f) && a.b != ""',
      'heterogeneous-map-literal': '{"name": "http", "port": 80}',
      'cel-js-rejects-spec-cel': '"x".size() > 0',
    };
    for (const [rule, expression] of Object.entries(raises)) {
      const found = check(expression).find((candidate) => candidate.rule === rule);
      expect(found?.kind).toBe('divergence');
      expect(found?.message).toContain('never evaluate this field');
      expect(found?.message).toContain('does not model');
      expect(found?.message).not.toMatch(/resolves under KRO|the field resolves/i);
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
    // JavaScript that leaked through the expression converter. Each of these is
    // invalid under the *spec's* own grammar — an unpaired `?` cannot close
    // `Expr = ConditionalOr ["?" ConditionalOr ":" Expr]`, and `=` outside
    // `==`/`!=`/`<=`/`>=` is not a CEL token at all — so the verdict is reached
    // without asking cel-js anything. A real defect, but the same defect on
    // cel-js and cel-go, so not a divergence.
    for (const expression of [
      'webService.status.loadBalancer.ingress?[0]?.ip',
      'appService.status.loadBalancer?.ingress?[0]?.ip',
      'configmapPlatformConfig.data.?region',
      'a?.b',
      'a ?[0]',
      'a === b',
      'a !== b',
      '(x) => x',
      '${a}',
    ]) {
      const findings = check(expression);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe('not-valid-cel');
      expect(findings[0]?.kind).toBe('note');
      expect(findings[0]?.dialect).toBe('both');
      expect(hasCelDialectDivergence(findings)).toBe(false);
    }
  });

  it('reaches the non-CEL verdict even where cel-js parses the text', () => {
    // cel-js's lexer drops a character it has no token for rather than failing,
    // so `a === b` arrives at its parser as `a == b` and "parses". The token
    // scan is built from the spec rather than from cel-js's verdict, which is
    // exactly why it is not gated on a parse failure.
    expect(parse('a === b').isSuccess).toBe(true);
    expect(check('a === b').map((found) => found.rule)).toEqual(['not-valid-cel']);
  });

  it('leaves a trailing .length to the type checker rather than calling it non-CEL', () => {
    // `.length` is a plain `Member "." SELECTOR`, grammatical on both engines.
    // Whether the field exists is a question about a type this module cannot
    // see, so it is not in the non-CEL token set.
    expect(parse('a.b.length').isSuccess).toBe(true);
    expect(check('a.b.length')).toEqual([]);
  });
});

/**
 * A cel-js parse failure is a fact about direct mode and nothing else.
 *
 * cel-js 0.8.2 is not a conformant CEL parser: its `atomicExpression` rule
 * takes a postfix `.`/`[` only after an identifier — plus one index after a
 * list literal and any postfix after a map literal — while the spec's
 * `Member = Primary | Member "." SELECTOR ["(" [ExprList] ")"] | Member "[" Expr "]"`
 * takes a postfix on any Member and `Primary` includes `LITERAL` and
 * `"(" Expr ")"` (cel-spec doc/langdef.md, "Syntax"). Its lexer is likewise
 * short of the spec's `FLOAT_LIT` exponent form and of the `r`/`R`/`b`/`B` and
 * triple-quoted `STRING_LIT`/`BYTES_LIT` forms.
 *
 * So each case below asserts *both* halves: that cel-js really cannot parse it
 * — which pins this cel-js version's behaviour and fails the day cel-js catches
 * up — and that the check calls it a divergence rather than a defect.
 */
describe('valid CEL that cel-js cannot parse', () => {
  const specValid: Record<string, string> = {
    'a string literal receiver': '"x".size()',
    'a string literal receiver with arguments': '"abc".startsWith("a")',
    'a string literal receiver with whitespace before the dot': '"a" .size()',
    'a string literal indexed': '"abc"[0]',
    'a list literal receiver': '[1,2].size()',
    'a list literal receiver of a macro': '[a,b].exists(e, e > 1)',
    'a list literal past its one permitted index': '[1,2][0].f',
    'a parenthesized receiver': '(a + b).size()',
    'a parenthesized receiver of a select': '(a).b',
    'a parenthesized receiver indexed': '(a + b)[0]',
    'a global call receiver': 'size(a).b',
    'a has() call receiver': 'has(a.b).c',
    'an int literal receiver': '1.string()',
    'a double literal receiver': '1.0.string()',
    'a uint literal receiver': '2u.string()',
    'a bool literal receiver': 'true.x',
    'a null literal receiver': 'null.x',
    'an exponent float literal': 'a.b == 1e3',
    'a negative exponent float literal': 'a.b == 1.5e-3',
    'a raw string literal': 'a.b == r"x"',
    'a bytes literal': 'a.b == b"x"',
    'a triple-quoted string literal': 'a.b == """x"""',
    'a list literal of a ternary, then a macro': '[a.b > 0 ? "a" : ""].filter(s, s != "")',
  };

  for (const [name, expression] of Object.entries(specValid)) {
    it(`calls ${name} a cel-js divergence, not invalid CEL`, () => {
      // Half one: cel-js really does reject it. When this starts failing,
      // cel-js has gained the form and the rule should lose it.
      expect(parse(expression).isSuccess).toBe(false);

      // Half two: the identified form is the *only* thing cel-js refuses. Taking
      // it out — and nothing else — leaves text cel-js parses, which is what
      // rules out "the parse failed for some unrelated reason and there happened
      // to be a known shortfall in the text as well".
      const proof = celDialectParseProof(expression);
      expect(proof).toBeDefined();
      expect(proof).not.toBe(expression);
      expect(parse(proof as string).isSuccess).toBe(true);
      // …and cel-js's lexer carried every character of the rewrite on the way to
      // that parse, so the parse is a fact about the whole proof text rather
      // than about whatever survived the lexer. The original is held to the same
      // bar, so a proof is never built on top of text that is not lexically CEL.
      expect(celDialectLexicalGap(proof as string)).toBe(-1);
      expect(celDialectLexicalGap(expression)).toBe(-1);

      // Half three: the check identifies it positively rather than inferring
      // cel-go's behaviour from cel-js's refusal, and cites the rewrite it used.
      const findings = check(expression);
      expect(findings.map((found) => found.rule)).toEqual(['cel-js-rejects-spec-cel']);
      expect(findings[0]?.kind).toBe('divergence');
      expect(findings[0]?.dialect).toBe('cel-js');
      expect(hasCelDialectDivergence(findings)).toBe(true);
      // The message must not claim the expression is invalid.
      expect(findings[0]?.message).toContain('the CEL grammar permits it');
      expect(findings[0]?.message).not.toContain('KRO will refuse');
      expect(findings[0]?.message).toContain(proof as string);
    });
  }

  /**
   * A shortfall present *somewhere* in a rejected expression is not a
   * divergence. Each of these carries a real, correctly identified cel-js
   * shortfall and is also ungrammatical on its own account — unfinished
   * operators, an unbalanced paren — so cel-go refuses it exactly as cel-js
   * does. Rewriting the shortfall away leaves text cel-js still cannot parse,
   * and that is the evidence that sends them to the parse-failure bucket.
   */
  describe('a shortfall that is not the whole reason cel-js refused', () => {
    const invalidElsewhere: Record<string, string> = {
      'a string receiver in an unfinished sum': '"x".size() +',
      'a parenthesized receiver before a dangling comparison': '(a).b ==',
      'a string receiver with an unbalanced closing paren': '"x".size()) ',
      'a list receiver in an unfinished ternary': '[1,2].size() ? a : ',
      'a global-call receiver with a dangling operator': 'size(a).b &&',
      'an exponent float in an unfinished sum': 'a.b == 1e3 +',
    };

    for (const [name, expression] of Object.entries(invalidElsewhere)) {
      it(`calls ${name} a parse failure, never a divergence`, () => {
        expect(parse(expression).isSuccess).toBe(false);

        // The shortfall really is found — this is not passing by failing to
        // detect anything — but rewriting it away does not rescue the parse.
        expect(celDialectParseProof(expression)).toBeUndefined();

        const findings = check(expression);
        expect(findings.map((found) => found.rule)).toEqual(['cel-js-parse-failure']);
        expect(findings[0]?.kind).toBe('note');
        expect(hasCelDialectDivergence(findings)).toBe(false);
        expect(findings[0]?.message).toContain('still leaves the expression unparseable');
        expect(findings[0]?.message).not.toContain('cel-go');
      });
    }

    it('does not call an unpaired-ternary leak a divergence either', () => {
      // The reviewer's `[1,2].size() ? a`. A top-level `?` with no `:` cannot
      // close `Expr = ConditionalOr ["?" ConditionalOr ":" Expr]` on any engine,
      // so the spec-grammar scan reaches its verdict first and this lands in the
      // not-valid-cel bucket rather than the parse-failure one. Either way it is
      // a note, and the point the reviewer was making holds: the list-literal
      // receiver in it must not carry a divergence.
      const findings = check('[1,2].size() ? a');

      expect(findings.map((found) => found.rule)).toEqual(['not-valid-cel']);
      expect(hasCelDialectDivergence(findings)).toBe(false);
    });

    it('is false for hasCelDialectDivergence on every invalid-elsewhere case', () => {
      for (const expression of [...Object.values(invalidElsewhere), '[1,2].size() ? a']) {
        expect(hasCelDialectDivergence(check(expression))).toBe(false);
      }
    });
  });

  describe('nested and repeated shortfalls', () => {
    it('rewrites a shortfall nested inside another and still proves the divergence', () => {
      // `("x".size()).b` is two shortfalls at once: a string-literal receiver
      // inside a parenthesized receiver. The outer span wins the round, and the
      // inner one goes with it.
      const expression = '("x".size()).b';
      expect(parse(expression).isSuccess).toBe(false);

      const proof = celDialectParseProof(expression);
      expect(proof).toBe('__typekro_recv0.b');
      expect(parse(proof as string).isSuccess).toBe(true);
      expect(check(expression).map((found) => found.rule)).toEqual(['cel-js-rejects-spec-cel']);
    });

    it('needs a second round when one rewrite uncovers the next', () => {
      // `r"x".size()` is a raw-string prefix *and*, once that is gone, a plain
      // string literal used as a receiver. One round each.
      const expression = 'r"x".size()';
      expect(parse(expression).isSuccess).toBe(false);

      expect(celDialectParseProof(expression)).toBe('__typekro_recv0.size()');
      expect(check(expression).map((found) => found.rule)).toEqual(['cel-js-rejects-spec-cel']);
    });

    it('reports one divergence for two independent shortfalls, rewriting both', () => {
      // Deliberately one finding rather than one per fragment: the finding names
      // a status leaf and an expression, and the author's next move is the same
      // whichever fragment is quoted first. The proof covers both.
      const expression = '"x".size() + [1,2].size()';
      expect(parse(expression).isSuccess).toBe(false);

      const proof = celDialectParseProof(expression);
      expect(proof).toBe('__typekro_recv0.size() + __typekro_recv1.size()');
      expect(parse(proof as string).isSuccess).toBe(true);

      const findings = check(expression);
      expect(findings.map((found) => found.rule)).toEqual(['cel-js-rejects-spec-cel']);
      expect(findings[0]?.fragment).toContain('"x"');
    });

    it('yields no proof for an expression cel-js already parses', () => {
      expect(celDialectParseProof('a.b.c')).toBeUndefined();
      expect(celDialectParseProof('')).toBeUndefined();
    });
  });

  /**
   * A `receiver` rewrite over a bracketed span replaces the whole span with one
   * identifier, so whatever was inside the brackets is gone from the text cel-js
   * is asked about. That is the same defect as a lexer-dropped character, one
   * level down: the parse says nothing about the part it never saw. Each of
   * these carries a correctly identified receiver shortfall whose span is
   * ungrammatical on any engine, so cel-go refuses the original too.
   */
  describe('a rewrite that swallows a span it did not prove', () => {
    const swallowed: Record<string, string> = {
      'a parenthesized receiver with an unfinished operator': '(a &&).b',
      'a parenthesized receiver with a dangling plus': '(a + ).b',
      'a parenthesized receiver with an unclosed ternary': '(a ? b).c',
      'a global-call receiver with an unfinished argument': 'size(a +).b',
      'a list-literal receiver with an empty element': '[1, ,2].size()',
    };

    for (const [name, expression] of Object.entries(swallowed)) {
      it(`refuses to prove a divergence for ${name}`, () => {
        expect(parse(expression).isSuccess).toBe(false);
        // Lexically fine — nothing here is caught by the coverage scan. The
        // span is ungrammatical, which is a different thing.
        expect(celDialectLexicalGap(expression)).toBe(-1);
        expect(celDialectParseProof(expression)).toBeUndefined();

        const findings = check(expression);
        expect(findings.map((found) => found.rule)).toEqual(['cel-js-parse-failure']);
        expect(findings[0]?.kind).toBe('note');
        expect(hasCelDialectDivergence(findings)).toBe(false);
      });
    }

    it('still swallows a span whose only problem is a shortfall of its own', () => {
      // The recursion earns its keep here: `("x".size())` is not something
      // cel-js parses, but the reason is a divergence rather than a syntax
      // error, so the outer rewrite may swallow it after all.
      expect(celDialectParseProof('("x".size()).b')).toBe('__typekro_recv0.b');
      expect(celDialectParseProof('((r"x".size()).b).c')).toBe('__typekro_recv0.c');
    });

    it('leaves spans with no bracket in them unchecked', () => {
      // A string, number, bool or null receiver is one literal token: there is
      // no subexpression inside it for the rewrite to hide, and the coverage
      // scan has already established the token is well formed.
      for (const expression of ['"x".size()', '1.string()', 'true.x', 'r"x".size()']) {
        expect(celDialectParseProof(expression)).toBeDefined();
      }
    });
  });

  it('leaves a map literal receiver alone, because cel-js does parse it', () => {
    // The one member of the literal-primary family cel-js already handles: its
    // `mapExpression` rule carries a `MANY2` of postfix selects and indexes.
    // Nothing diverges, so nothing is reported.
    for (const expression of ['{"k":1}.size()', '{"k":1}.k', '{"k":1}["k"]']) {
      expect(parse(expression).isSuccess).toBe(true);
      expect(check(expression)).toEqual([]);
    }
  });

  it('leaves the one index cel-js allows after a list literal alone', () => {
    expect(parse('[1,2][0]').isSuccess).toBe(true);
    expect(check('[1,2][0]')).toEqual([]);
  });

  it('leaves a member call on an identifier chain alone', () => {
    // `a.map(x, x).size()` is `identifierExpression`, which cel-js does carry a
    // postfix on — so the global-call rule must not reach it.
    for (const expression of ['a.map(x,x).size()', 'a.filter(x, x.y)[0]', 'a.b.c.d']) {
      expect(parse(expression).isSuccess).toBe(true);
      expect(check(expression)).toEqual([]);
    }
  });
});

/**
 * cel-js's `parse()` reads `parserInstance.errors` and throws `lexResult.errors`
 * away, so its lexer silently drops every character it has no token for and the
 * parser "succeeds" on text cel-js never read in full. A divergence proof is a
 * claim about the whole expression, so a parse that discarded part of it is not
 * a proof — the coverage scan is what closes that hole, on the rewrite *and* on
 * the original.
 */
describe('a parse that discarded tokens is not a proof', () => {
  it('confirms cel-js really does drop what it cannot lex', () => {
    // The premise, asserted rather than assumed: each of these reaches cel-js's
    // parser with characters missing and is reported as a success. When this
    // starts failing, cel-js has gained lexer-error reporting and the coverage
    // scan can be re-derived from it.
    for (const dropped of ['a === b', 'a.b $', 'a.b ☃', 'a.b @ ']) {
      expect(parse(dropped).isSuccess).toBe(true);
      expect(celDialectLexicalGap(dropped)).toBeGreaterThanOrEqual(0);
    }
  });

  const discarded: Record<string, string> = {
    'a stray dollar sign': '"x".size() $',
    'a JavaScript strict-equality operator': '"x".size() === a',
    'a stray unicode character': '"x".size() ☃',
  };

  for (const [name, expression] of Object.entries(discarded)) {
    it(`refuses to prove a divergence for ${name}`, () => {
      // Each carries a genuine, correctly identified cel-js shortfall — the
      // string-literal receiver — and each *did* prove under a bare `parse()`:
      // the rewrite parses, but only because the lexer threw the offending
      // character away first, so the parse was never about this text.
      const rewritten = expression.replace('"x"', '__typekro_recv0');
      expect(parse(rewritten).isSuccess).toBe(true);
      expect(celDialectLexicalGap(rewritten)).toBeGreaterThanOrEqual(0);

      expect(celDialectLexicalGap(expression)).toBeGreaterThanOrEqual(0);
      expect(celDialectParseProof(expression)).toBeUndefined();

      const findings = check(expression);
      expect(hasCelDialectDivergence(findings)).toBe(false);
      // Bucket one: a character the *spec's* lexical grammar has no token for is
      // a fact about CEL rather than about cel-js, so it is reported as one.
      expect(findings.map((found) => found.rule)).not.toContain('cel-js-rejects-spec-cel');
      expect(findings[0]?.rule).toBe('not-valid-cel');
      expect(findings[0]?.kind).toBe('note');
    });
  }

  it('reports a gap that cel-js would also have refused as not-valid-cel', () => {
    // Where dropping the character leaves text cel-js cannot parse either, the
    // old code already avoided the false divergence — by luck rather than by
    // argument. The verdict is now reached from the grammar instead.
    for (const expression of ['"x".size() @ a', '"x".size() + "oops']) {
      expect(parse(expression).isSuccess).toBe(false);
      expect(celDialectParseProof(expression)).toBeUndefined();

      const findings = check(expression);
      expect(findings[0]?.rule).toBe('not-valid-cel');
      expect(hasCelDialectDivergence(findings)).toBe(false);
    }
  });

  it('reports the character the grammar has no token for, not a later one', () => {
    const findings = check('"x".size() ☃');
    expect(findings[0]?.message).toContain('☃');
    expect(findings[0]?.message).toContain('no token for');
  });

  it('lets an unterminated literal name itself rather than a stray quote', () => {
    expect(check('a.b + "oops')[0]?.message).toContain('unterminated string literal');
  });

  it('covers every lexical form the spec has, so a valid literal is never a gap', () => {
    // The scan is written from the spec's lexical grammar, which is a superset
    // of cel-js's lexer: the raw, bytes and triple-quoted string forms and the
    // exponent float are all tokens here even though cel-js has none of them.
    // Were that not so, the four shortfalls the rewriter exists to remove would
    // be reported as invalid CEL instead of as divergences.
    for (const expression of [
      'a.b == r"x"',
      'a.b == R"x"',
      'a.b == b"x"',
      'a.b == br"x"',
      'a.b == rb"x"',
      'a.b == """x"""',
      "a.b == '''x'''",
      'a.b == 1e3',
      'a.b == 1.5e-3',
      'a.b == 0x1F',
      'a.b == 0xFFu',
      'a.b == 12u',
      'a.b == 0.5',
      'a.b == "a\\"b"',
      'a.b == r"a\\"b"',
      "a.b == 'x' // trailing comment",
      'a.b == bar"x"',
      'a.b <= 1 && a.c >= 2 || !a.d != 3',
      '{"k": [1, 2]}["k"][0] % 3',
    ]) {
      expect(celDialectLexicalGap(expression)).toBe(-1);
    }
  });

  it('calls a character with no CEL token a gap', () => {
    for (const expression of ['a $ b', 'a ☃ b', 'a @ b', 'a # b', 'a ; b', 'a = b', 'a & b', 'a | b', 'a ~ b', 'a ^ b', 'a \\ b']) {
      expect(celDialectLexicalGap(expression)).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps every real emitted status expression fully covered', () => {
    // The scan runs on every expression the serializer emits, so a false gap
    // would turn working CEL into a `not-valid-cel` note. These are the shapes
    // TypeKro actually emits.
    for (const expression of [
      'has(webService.status.loadBalancer.ingress) ? webService.status.loadBalancer.ingress[0].ip : ""',
      'webService.status.readyReplicas > 0 && webService.status.replicas > 0',
      '"https://" + webService.status.loadBalancer.ingress[0].hostname + "/health"',
      'deployment.status.conditions.exists(c, c.type == "Available" && c.status == "True")',
      'size(deployment.status.conditions) > 0 ? deployment.status.conditions[0].message : "pending"',
      '{"name": "http", "port": 80}',
    ]) {
      expect(celDialectLexicalGap(expression)).toBe(-1);
    }
  });
});

/** Everything else cel-js cannot parse, reported without a cel-go claim. */
describe('an unexplained cel-js parse failure', () => {
  for (const expression of ['!!!(((', 'a b c', 'a + + * b', '((((']) {
    it(`reports ${JSON.stringify(expression)} against cel-js only`, () => {
      expect(parse(expression).isSuccess).toBe(false);

      const findings = check(expression);
      expect(findings.map((found) => found.rule)).toEqual(['cel-js-parse-failure']);
      expect(findings[0]?.kind).toBe('note');
      expect(findings[0]?.dialect).toBe('cel-js');
      expect(hasCelDialectDivergence(findings)).toBe(false);

      // The whole point of the bucket: no claim about the other engine.
      const message = findings[0]?.message ?? '';
      expect(message).not.toContain('cel-go');
      expect(message).not.toContain('KRO will refuse');
      expect(message).toContain('direct mode cannot evaluate this field');
      expect(message).toContain('may still permit it');
    });
  }

  it('reads as a cel-js-only verdict in the formatted report', () => {
    expect(formatCelDialectFindings(check('a b c'))).toContain(
      'not parseable by cel-js, cel-go unknown'
    );
  });
});

/**
 * The denylist rules are regex- and bracket-mask-based, so none of them needs a
 * parse tree — and an expression cel-js merely cannot parse is exactly the one
 * that most needs them, since it is served by KRO alone.
 */
/**
 * The denylist rules read structure off the text — a `has(` argument list, a
 * `{`…`}` map literal, the top-level `&&`/`||` chain — and on ungrammatical text
 * none of that structure is established. So they run only once the expression is
 * grammatical: cel-js accepted the whole of it, or the rewrite proof did. A
 * cel-js parse failure on its own is not a reason to skip them, because cel-js
 * is not a conformant grammar; the proof is what fills that gap.
 */
describe('denylist rules under a proof, on text cel-js cannot parse', () => {
  it('still finds a has() index argument', () => {
    const expression = 'has(a.list[0].f) && [1,2].size() > 0';
    expect(parse(expression).isSuccess).toBe(false);
    // Both findings: the rules ran because the proof established the text.
    expect(celDialectParseProof(expression)).toBeDefined();
    expect(check(expression).map((found) => found.rule).sort()).toEqual([
      'cel-js-rejects-spec-cel',
      'has-index-argument',
    ]);
  });

  it('still finds a heterogeneous map literal', () => {
    const expression = '{"name": "http", "port": 80}.size() > (a).b';
    expect(parse(expression).isSuccess).toBe(false);
    expect(check(expression).map((found) => found.rule)).toContain('heterogeneous-map-literal');
  });

  it('still finds a late has() guard', () => {
    const expression = '[1,2].size() > 0 && a.p.f != "" && has(a.p)';
    expect(parse(expression).isSuccess).toBe(false);
    expect(check(expression).map((found) => found.rule)).toContain(
      'guard-after-use-in-logical-chain'
    );
  });

  it('still finds `in` on a possible list entry', () => {
    const expression = '"k" in a.list[0] && [1,2].size() > 0';
    expect(parse(expression).isSuccess).toBe(false);
    expect(check(expression).map((found) => found.rule)).toContain('in-on-list-entry');
  });

  it('reads inside a rewritten span, which the proof text no longer has', () => {
    // `has(a.list[0].f)` is itself the swallowed receiver here, so the proof
    // text is `__typekro_recv0.x` and the `has()` survives only in the original.
    // Running the rules on the original is what keeps this finding.
    const expression = 'has(a.list[0].f).x';
    expect(celDialectParseProof(expression)).toBe('__typekro_recv0.x');
    expect(check(expression).map((found) => found.rule).sort()).toEqual([
      'cel-js-rejects-spec-cel',
      'has-index-argument',
    ]);
  });

  it('leaves the bracket and chain structure outside a rewritten span alone', () => {
    // The property the previous test relies on: a rewrite replaces a balanced
    // bracket pair (or one literal token) with an identifier, so no bracket pair
    // outside the span is re-paired and no top-level `&&`/`||` is added or
    // removed. Every operator a rewrite takes away was inside a bracket pair.
    const expression = 'has(a.p) && (b || c).d != "" && has(a.q)';
    const proof = celDialectParseProof(expression);
    expect(proof).toBe('has(a.p) && __typekro_recv0.d != "" && has(a.q)');
    // Three top-level `&&` operands before and after, and the `||` that vanished
    // was inside the parens, never part of the top-level chain.
    expect((proof as string).split('&&')).toHaveLength(3);
    expect(expression.split('&&')).toHaveLength(3);
  });
});

/**
 * Half two may not run on text that is neither parsed nor proven. The mask and
 * bracket structure the rules read is not established there, so a `divergence`
 * finding would fail strict mode on text cel-go rejects outright — the exact
 * false positive this check exists to avoid.
 */
describe('denylist rules do not run on unparsed, unproven text', () => {
  const ungrammatical: Record<string, string> = {
    'JavaScript optional chaining': 'a?.b && has(list[0].f)',
    'an unbalanced call': 'foo(((( && has(list[0].f)',
    'a dangling operator': 'has(list[0].f) &&',
    'adjacent primaries': 'a b has(list[0].f)',
    'a swallowed ungrammatical span': '(a &&).b && has(list[0].f)',
    'a stray character': 'has(list[0].f) && a.b $',
  };

  for (const [name, expression] of Object.entries(ungrammatical)) {
    it(`reports no divergence for ${name}`, () => {
      // The fragment really is in there, and really is what the rule matches.
      expect(expression).toContain('has(list[0].f)');
      expect(celDialectParseProof(expression)).toBeUndefined();

      const findings = check(expression);
      expect(findings.map((found) => found.rule)).not.toContain('has-index-argument');
      expect(hasCelDialectDivergence(findings)).toBe(false);
      // Half one still reports the expression, so the leaf is never silent.
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((found) => found.kind === 'note')).toBe(true);
    });
  }

  it('finds the same fragment as a divergence once the text is grammatical', () => {
    // The control: the rule itself has not changed, only when it is allowed to
    // speak. cel-js parses this one outright.
    const expression = 'a.b != "" && has(list[0].f)';
    expect(parse(expression).isSuccess).toBe(true);
    expect(celDialectLexicalGap(expression)).toBe(-1);

    const findings = check(expression);
    expect(findings.map((found) => found.rule)).toContain('has-index-argument');
    expect(hasCelDialectDivergence(findings)).toBe(true);
  });

  it('finds both a proven divergence and a denylisted form in one expression', () => {
    // The rules ran under the proof, so the expression carries both findings.
    const expression = '[1,2].size() > 0 && has(list[0].f)';
    expect(parse(expression).isSuccess).toBe(false);
    expect(celDialectParseProof(expression)).toBeDefined();

    const findings = check(expression);
    expect(findings.map((found) => found.rule).sort()).toEqual([
      'cel-js-rejects-spec-cel',
      'has-index-argument',
    ]);
    expect(hasCelDialectDivergence(findings)).toBe(true);
  });

  it('skips the note-kind rules on unproven text too', () => {
    // A note about `in` on a list entry describes a structure the text does not
    // have. Half one already reports the leaf, so nothing is lost by silence.
    const expression = '"k" in a.list[0] && foo((((';
    expect(celDialectParseProof(expression)).toBeUndefined();
    expect(check(expression).map((found) => found.rule)).toEqual(['cel-js-parse-failure']);
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

  it('classifies only a whole literal, never a value that merely opens with one', () => {
    // The type of a value is not the type of the token it starts with.
    // `"x".size()` and `[1, 2].size()` are ints, `"s".startsWith("t")` is a
    // bool, and `"x" + y` is a string only by luck — every one of these maps is
    // homogeneous, so classifying any value by its first character would fail
    // strict mode on valid CEL.
    for (const expression of [
      '{"a": "x".size(), "b": 3}',
      '{"a": [1, 2].size(), "b": 3}',
      '{"a": "s".startsWith("t"), "b": true}',
      '{"a": "x" + y, "b": 3}',
      '{"a": {"k": 1}.size(), "b": 3}',
    ]) {
      expect(check(expression).map((found) => found.rule)).not.toContain(
        'heterogeneous-map-literal'
      );
    }

    // The two cel-js does parse carry no finding at all. The other three are
    // the literal-primary receiver that cel-js cannot parse and the spec
    // permits, so they are a `cel-js-rejects-spec-cel` divergence — a verdict
    // about the *receiver*, never about the map's value types.
    for (const expression of ['{"a": "x" + y, "b": 3}', '{"a": {"k": 1}.size(), "b": 3}']) {
      expect(parse(expression).isSuccess).toBe(true);
      expect(check(expression)).toEqual([]);
    }
    for (const expression of [
      '{"a": "x".size(), "b": 3}',
      '{"a": [1, 2].size(), "b": 3}',
      '{"a": "s".startsWith("t"), "b": true}',
    ]) {
      expect(check(expression).map((found) => found.rule)).toEqual(['cel-js-rejects-spec-cel']);
    }
  });

  it('leaves a concatenation unclassified rather than calling it a string', () => {
    // `"x" + "y"` is in fact a string, but it is not a *literal*, and the rule
    // buys its certainty by refusing to reason past a whole token. Only the
    // `"z"` entry is classified, so there is nothing to compare it against.
    expect(check('{"a": "x" + "y", "b": "z"}')).toEqual([]);
  });

  it('still flags a map whose string value carries separator characters', () => {
    // Structure comes from the mask, so the `,`, `:` and `}` inside the quotes
    // are data; the class comes from the whole literal, which is a string. Both
    // halves have to hold for this to be reported as the mixed map it is.
    expect(check('{"a": "x, y: }", "b": 1}').map((found) => found.rule)).toEqual([
      'heterogeneous-map-literal',
    ]);
    expect(check('{"a": ["}"], "b": 1}').map((found) => found.rule)).toEqual([
      'heterogeneous-map-literal',
    ]);
  });

  it('says nothing about a nested map whose value is a call', () => {
    for (const expression of [
      '{"a": {"x": size(l)}, "b": {"y": 2}}',
      '{"a": {"x": size(l)}.size(), "b": 3}',
    ]) {
      expect(check(expression)).toEqual([]);
    }
  });

  it('keeps flagging the genuinely mixed literals', () => {
    for (const expression of [
      '{"a": "x", "b": 1}',
      '{"a": [1], "b": {"c": 1}}',
      '{"a": 1, "b": 2.5}',
      '{"protocol": "TCP", "port": 8080}',
      // A whole literal stays whole across surrounding whitespace.
      '{"a":  "x"  , "b": 1}',
    ]) {
      expect(check(expression).map((found) => found.rule)).toEqual(['heterogeneous-map-literal']);
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

/**
 * `COMMENT ::= '//' ~NEWLINE*` (cel-spec doc/langdef.md, "Syntax").
 *
 * A comment is text, not code, so nothing inside one may reach a rule: every
 * scan in the module runs over a mask that blanks comments and string literals
 * together, in one pass driven by the same tokenizer the lexical-coverage scan
 * walks with. The two orderings a string-only mask gets wrong are pinned here in
 * both directions — a `//` inside a literal is not a comment, and a quote inside
 * a comment is not a literal.
 */
describe('comments are text, not code', () => {
  it('does not read a has() written in a comment', () => {
    // The `has(list[0].f)` here is commented out. Reading it as code reported a
    // has-index-argument divergence against an expression that has none.
    expect(check('has(a.b) // has(list[0].f)')).toEqual([]);
    expect(check('size(l) > 0 && l[0].f != "" // has(l[0].f)')).toEqual([]);
  });

  it('does not read a map literal written in a comment', () => {
    expect(check('a.b == {"k": 1} // {"k": 1, "j": "x"}')).toEqual([]);
  });

  it('still reports the map literal that is actually there', () => {
    expect(check('a.b == {"k": 1, "j": "x"} // a comment').map((found) => found.rule)).toEqual([
      'heterogeneous-map-literal',
    ]);
  });

  it('does not let an operator in a comment split the operator chain', () => {
    // The `||` is commented out, so this is one `&&` chain of two operands with
    // the guard written after the access it covers. Reading the comment as code
    // split the chain into two disjuncts and lost the finding.
    expect(check('p.q.r != "" // || z\n && has(p.q)').map((found) => found.rule)).toEqual([
      'guard-after-use-in-logical-chain',
    ]);
    expect(check('p.q.r != "" && has(p.q) // || z').map((found) => found.rule)).toEqual([
      'guard-after-use-in-logical-chain',
    ]);
  });

  it('does not report a converter leak written in a comment', () => {
    // `===`, `${` and `?.` are all non-CEL — in code. In a comment they are
    // characters the COMMENT production carries, on any conformant lexer.
    expect(check('a.b // a === b')).toEqual([]);
    expect(check('a.b // ${x}')).toEqual([]);
    expect(check('a.b // a?.c')).toEqual([]);
    expect(celDialectLexicalGap('a.b // a === b')).toBe(-1);
  });

  it('still reports a converter leak written as code alongside a comment', () => {
    expect(check('a === b // a comment').map((found) => found.rule)).toEqual(['not-valid-cel']);
  });

  it('reads a // inside a string literal as string content', () => {
    // `"a // b"` is one STRING_LIT used as the receiver of `.size()`, which is
    // the cel-js shortfall. If the `//` opened a comment the literal would be
    // unterminated and the expression would not be CEL at all.
    expect(check('"a // b".size() != ""').map((found) => found.rule)).toEqual([
      'cel-js-rejects-spec-cel',
    ]);
    expect(celDialectParseProof('"a // b".size() != ""')).toBe('__typekro_recv0.size() != ""');
  });

  it('reads a quote inside a comment as comment content', () => {
    // The apostrophe in `it's` opened a string literal under a string-only mask
    // and flipped the masking of everything after it.
    expect(check('a.b // it\'s "quoted"')).toEqual([]);
    expect(check('has(a.b) // don\'t read "this"')).toEqual([]);
  });

  it('keeps the newline, so a comment ends at its own line', () => {
    // `COMMENT` stops before the newline, so the `&& has(e.f)` on the next line
    // is code and the whole thing is one chain rather than one commented-out
    // operand.
    expect(check('a.b &&\n  c.d // mid-way\n  && has(e.f)')).toEqual([]);
    expect(
      check('e.f.g != "" &&\n  c.d // mid-way\n  && has(e.f)').map((found) => found.rule)
    ).toEqual(['guard-after-use-in-logical-chain']);
  });

  it('quotes the expression as it was written, comment included', () => {
    const [found] = check('a.b == {"k": 1, "j": "x"} // a comment');
    expect(found?.expression).toBe('a.b == {"k": 1, "j": "x"} // a comment');
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

    expect(check(under).map((found) => found.rule)).toEqual(['cel-js-parse-failure']);
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

  /**
   * Wall-clock is the wrong instrument for the property that matters, because a
   * slow CI box and a quadratic regression look alike from the outside. The work
   * counters are not: `indexedCharacters` is the text scanned to resolve bracket
   * pairs and `lookups` the number of "where does this close?" questions asked,
   * and both are machine-independent. Doubling the expression must roughly
   * double them — the old walks, which rescanned forward from every opener,
   * quadrupled instead.
   */
  describe('work is linear in the expression, not quadratic in its nesting', () => {
    function work(expression: string): number {
      resetCelDialectWorkStats();
      checkCelDialectCompatibility(expression, 'endpoint');
      const stats = celDialectWorkStats();
      // At most one index for the expression itself plus one per rewrite round.
      expect(stats.indexBuilds).toBeLessThanOrEqual(9);
      return stats.indexedCharacters + stats.lookups;
    }

    for (const [name, build] of Object.entries(shapes)) {
      it(`does not grow faster than the input on ${name}`, () => {
        // Both halves of the budget, so neither trips the size gate.
        const half = build(CEL_DIALECT_MAX_EXPRESSION_LENGTH / 4).slice(
          0,
          CEL_DIALECT_MAX_EXPRESSION_LENGTH / 2
        );
        const whole = build(CEL_DIALECT_MAX_EXPRESSION_LENGTH / 2).slice(
          0,
          CEL_DIALECT_MAX_EXPRESSION_LENGTH
        );
        expect(whole.length).toBeGreaterThan(half.length * 1.8);

        const halfWork = work(half);
        const wholeWork = work(whole);

        // Linear doubles, quadratic quadruples. 2.6 leaves room for the constant
        // factors either side of the doubling without admitting a quadratic.
        expect(wholeWork).toBeGreaterThan(0);
        expect(wholeWork / halfWork).toBeLessThan(2.6);
        // And an absolute ceiling, so "linear" cannot mean linear with a large
        // multiplier: the whole check reads the expression a small fixed number
        // of times over.
        expect(wholeWork).toBeLessThan(whole.length * 6);
      });
    }
  });
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
