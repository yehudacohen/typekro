/**
 * The strict `trustedIPs` format, in every place it is enforced (no cluster).
 *
 * - Direct mode: the bootstrap spec (ArkType) and the proxy-trust guard over
 *   typed values, raw `ports`, `env` and `additionalArguments`.
 * - KRO mode: the CRD admission rule and the render-time filter, both read out
 *   of the generated RGD and evaluated here, so a weakened rule fails a test.
 *   The filter's regexes run under RE2, the engine CEL `matches()` uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type } from 'arktype';
import { loadAll } from 'js-yaml';
import { RE2JS } from 're2js';

import {
  makeTraefikBootstrap,
  traefikBootstrap,
} from '../../../src/factories/traefik/compositions/traefik-bootstrap.js';
import { TraefikBootstrapConfigSchema } from '../../../src/factories/traefik/types.js';
import {
  mapTraefikConfigToHelmValues,
  validateTraefikHelmValues,
} from '../../../src/factories/traefik/utils/helm-values-mapper.js';
import { traefikProxyTrustIssues } from '../../../src/factories/traefik/utils/proxy-trust.js';
import {
  parseTraefikTrustedRange,
  TRAEFIK_IPV4_MAPPED_PATTERN,
  TRAEFIK_TRUSTED_RANGE_PATTERN,
} from '../../../src/factories/traefik/utils/trusted-range.js';

const ORIGINAL_KUBECONFIG = process.env.KUBECONFIG;
let kubeconfigDir: string | undefined;

beforeAll(() => {
  kubeconfigDir = mkdtempSync(join(tmpdir(), 'typekro-traefik-trusted-range-'));
  const kubeconfigPath = join(kubeconfigDir, 'kubeconfig');
  writeFileSync(
    kubeconfigPath,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- cluster: { server: "https://127.0.0.1:1" }',
      '  name: hermetic',
      'contexts:',
      '- context: { cluster: hermetic, user: hermetic }',
      '  name: hermetic',
      'current-context: hermetic',
      'users:',
      '- name: hermetic',
      '  user: {}',
      '',
    ].join('\n')
  );
  process.env.KUBECONFIG = kubeconfigPath;
});

afterAll(() => {
  if (ORIGINAL_KUBECONFIG === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = ORIGINAL_KUBECONFIG;
  if (kubeconfigDir) rmSync(kubeconfigDir, { recursive: true, force: true });
});

const VALID = [
  '10.0.1.0/24',
  '192.168.0.0/16',
  '203.0.113.7',
  '2001:db8::/32',
  'fd00::/8',
  '::1',
  'fe80::1/64',
  '1:2:3:4:5:6:7:8/128',
];

// Each renders as trust-all in Traefik, through Go's lenient parsing or the
// chart's comma join.
const TRUSTS_ALL = [
  '0.0.0.0/0',
  '::/0',
  '0.0.0.0/00',
  '::/00',
  '0.0.0.0/0 ',
  '0.0.0.0/0,10.0.0.0/8',
  '0.0.0.0/0, 10.0.0.0/8',
  '::ffff:0.0.0.0/96',
  '::ffff:0:0/96',
  '0:0:0:0:0:ffff:0:0/96',
  '::FFFF:0:0/96',
  '8.8.8.8/0',
];

// Not trust-all, but not in the strict format either.
const MALFORMED = [
  ' 10.0.0.0/8',
  '10.0.0.0/8,10.1.0.0/16',
  '10.0.0.0/33',
  '2001:db8::/129',
  '010.0.0.0/8',
  '10.0.0.0/08',
  '1::2::3',
  'fe80::1%eth0',
  '::ffff:10.0.0.0/104',
  '',
  'abc',
];

describe('the strict trusted-range format', () => {
  it('accepts one valid address or range and nothing else', () => {
    for (const range of VALID) expect(parseTraefikTrustedRange(range)).toBeDefined();
    for (const range of [...TRUSTS_ALL, ...MALFORMED]) {
      if (range === '0.0.0.0/0' || range === '::/0' || range === '8.8.8.8/0') {
        // `/0` is well formed; refusing it is the guard's job.
        expect(parseTraefikTrustedRange(range)?.prefix).toBe(0);
      } else {
        expect(parseTraefikTrustedRange(range)).toBeUndefined();
      }
    }
  });

  it('means the same under RE2, which CEL matches() uses', () => {
    const range = RE2JS.compile(TRAEFIK_TRUSTED_RANGE_PATTERN);
    const mapped = RE2JS.compile(TRAEFIK_IPV4_MAPPED_PATTERN);
    for (const value of [...VALID, ...TRUSTS_ALL, ...MALFORMED]) {
      const re2 = range.matches(value) && !mapped.matcher(value).find();
      expect(re2).toBe(parseTraefikTrustedRange(value) !== undefined);
    }
  });
});

describe('direct mode', () => {
  it('refuses trust-all and malformed entries in the typed spec', () => {
    for (const range of [...TRUSTS_ALL, ...MALFORMED]) {
      expect(() =>
        mapTraefikConfigToHelmValues({
          name: 'traefik',
          entrypoints: { web: { proxyProtocol: { trustedIPs: ['10.0.1.0/24', range] } } },
        })
      ).toThrow(/trusts every source|strict format/);
    }
    expect(() =>
      mapTraefikConfigToHelmValues({
        name: 'traefik',
        entrypoints: { websecure: { forwardedHeaders: { trustedIPs: VALID } } },
      })
    ).not.toThrow();
  });

  it('refuses them in the bootstrap spec schema', () => {
    for (const range of MALFORMED) {
      const result = TraefikBootstrapConfigSchema({
        name: 'traefik',
        entrypoints: { web: { proxyProtocol: { trustedIPs: [range] } } },
      });
      expect(String(result)).toContain('IP addresses or CIDR ranges');
    }
    const tooMany = Array.from({ length: 65 }, (_, index) => `10.0.${index}.0/24`);
    expect(
      String(
        TraefikBootstrapConfigSchema({
          name: 'traefik',
          entrypoints: { web: { proxyProtocol: { trustedIPs: tooMany } } },
        })
      )
    ).toContain('64');
    expect(
      TraefikBootstrapConfigSchema({
        name: 'traefik',
        entrypoints: { web: { proxyProtocol: { trustedIPs: VALID } } },
      })
    ).not.toBeInstanceOf(type.errors);
  });

  it('refuses them in raw ports, env values and arguments', () => {
    for (const range of [...TRUSTS_ALL, ...MALFORMED].filter((value) => !value.includes(','))) {
      expect(
        traefikProxyTrustIssues({ ports: { metrics: { proxyProtocol: { trustedIPs: [range] } } } })
      ).toHaveLength(1);
    }
    for (const range of ['0.0.0.0/00', '::ffff:0:0/96', '10.0.0.0/8, 0.0.0.0/0', '10.0.0.0/08']) {
      expect(
        traefikProxyTrustIssues({
          env: [{ name: 'TRAEFIK_ENTRYPOINTS_WEB_PROXYPROTOCOL_TRUSTEDIPS', value: range }],
        })
      ).not.toEqual([]);
      for (const args of [
        [`--entryPoints.web.forwardedHeaders.trustedIPs=${range}`],
        ['--entrypoints.web.forwardedheaders.trustedips', range],
        [`--entrypoints.web.proxyprotocol.trustedips[0]=${range}`],
      ]) {
        expect(traefikProxyTrustIssues({ additionalArguments: args })).not.toEqual([]);
      }
    }
  });

  it('reads env and argument lists the way Traefik does: split on "," and trimmed', () => {
    expect(
      traefikProxyTrustIssues({
        env: [
          {
            name: 'TRAEFIK_ENTRYPOINTS_WEB_PROXYPROTOCOL_TRUSTEDIPS',
            value: '10.0.1.0/24, 10.0.2.0/24',
          },
        ],
        additionalArguments: ['--entrypoints.web.proxyprotocol.trustedips=10.0.1.0/24, fd00::/8'],
      })
    ).toEqual([]);
  });

  it('matches insecure env names in any case, as Traefik does', () => {
    expect(
      traefikProxyTrustIssues({
        env: [{ name: 'traefik_entrypoints_web_forwardedheaders_insecure', value: 'true' }],
      })
    ).toEqual([expect.stringContaining('trusts every source')]);
  });

  it('refuses $(VAR) references, which Kubernetes expands', () => {
    for (const values of [
      { env: [{ name: 'TRAEFIK_ENTRYPOINTS_WEB_PROXYPROTOCOL_TRUSTEDIPS', value: '$(RANGES)' }] },
      { env: [{ name: 'TRAEFIK_ENTRYPOINTS_WEB_PROXYPROTOCOL_INSECURE', value: '$(FLAG)' }] },
      { env: [{ name: 'HOME', value: '$(FOO)' }] },
      { env: [{ name: 'XDG_CONFIG_HOME', value: '/x/$(FOO)' }] },
      { additionalArguments: ['--entrypoints.web.proxyprotocol.insecure=$(FLAG)'] },
      { additionalArguments: ['--entrypoints.web.proxyprotocol.trustedips', '$(RANGES)'] },
      { additionalArguments: ['$(FLAG)'] },
    ]) {
      const issues = traefikProxyTrustIssues(values);
      expect(issues).not.toEqual([]);
      expect(issues.every((issue) => issue.includes('$('))).toBe(true);
    }
    // Unrelated flags may still use one.
    expect(
      traefikProxyTrustIssues({
        additionalArguments: ['--providers.kubernetescrd.namespaces=$(POD_NAMESPACE)'],
      })
    ).toEqual([]);
  });

  it('warns about trust-all and very broad ranges the way Go reads them', () => {
    const values = mapTraefikConfigToHelmValues(
      {
        name: 'traefik',
        entrypoints: { web: { proxyProtocol: { trustedIPs: ['0.0.0.0/1', '10.0.0.0/8'] } } },
      },
      {
        baseValues: { ports: { metrics: { proxyProtocol: { trustedIPs: ['::ffff:0:0/96'] } } } },
        dangerouslyTrustAnySource: true,
      }
    );
    const warnings = validateTraefikHelmValues(values).filter((w) => w.includes('trustedIPs'));
    expect(warnings).toHaveLength(2);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('0.0.0.0/1, which trusts a very large address range'),
        expect.stringContaining('::ffff:0:0/96, which trusts every source'),
      ])
    );
  });
});

// A tiny evaluator for the CEL TypeKro emits over one string variable: terms
// joined by `&&`, each a size bound, `startsWith`, `endsWith` or `matches`,
// optionally negated. Anything else throws, so a changed rule can't slip by.
function evaluatePredicate(predicate: string, variable: string, value: string): boolean {
  return predicate.split(' && ').every((term) => {
    const negated = term.startsWith('!');
    const body = negated ? term.slice(1) : term;
    const size = new RegExp(`^${variable}\\.size\\(\\) <= (\\d+)$`).exec(body);
    if (size) return value.length <= Number(size[1]);
    const call = new RegExp(`^${variable}\\.(startsWith|endsWith|matches)\\('([^']*)'\\)$`).exec(
      body
    );
    if (!call) throw new Error(`unexpected CEL term: ${term}`);
    const [, fn, argument = ''] = call;
    const result =
      fn === 'startsWith'
        ? value.startsWith(argument)
        : fn === 'endsWith'
          ? value.endsWith(argument)
          : RE2JS.compile(argument).matcher(value).find();
    return negated ? !result : result;
  });
}

interface RgdDocument {
  spec?: {
    schema?: { spec?: unknown };
    resources?: Array<{ template?: unknown }>;
  };
}

/** The RGD that carries the trusted-range fields (the output also holds the CRDs' RGD). */
function rgd(bootstrap: typeof traefikBootstrap): RgdDocument {
  const document = loadAll(bootstrap.toYaml()).find(
    (doc): doc is RgdDocument =>
      typeof doc === 'object' &&
      doc !== null &&
      trustedIpsStrings((doc as RgdDocument).spec?.schema?.spec).length > 0
  );
  if (!document) throw new Error('no RGD with trustedIPs in the output');
  return document;
}

/** Every string under `node` whose key is `trustedIPs`. */
function trustedIpsStrings(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) trustedIpsStrings(item, found);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'trustedIPs' && typeof value === 'string') found.push(value);
      else trustedIpsStrings(value, found);
    }
  }
  return found;
}

describe('KRO mode', () => {
  it('puts a cost-bounded admission rule on all four trusted-range fields', () => {
    const fields = trustedIpsStrings(rgd(traefikBootstrap).spec?.schema?.spec);
    expect(fields).toHaveLength(4);
    for (const field of fields) {
      expect(field).toContain('maxItems=64');
      const rule = /validation="self\.all\(range, (.*)\)"$/.exec(field)?.[1];
      if (!rule) throw new Error(`no admission rule in ${field}`);
      const admits = (value: string) => evaluatePredicate(rule, 'range', value);
      for (const range of VALID) expect(admits(range)).toBe(true);
      for (const range of [
        '0.0.0.0/0',
        '::/0',
        '0.0.0.0/00',
        '::/00',
        '0.0.0.0/0 ',
        ' 0.0.0.0/0',
        '::ffff:0:0/96',
        '::FFFF:0.0.0.0/96',
        '0.0.0.0/0,',
        'x'.repeat(44),
      ]) {
        expect(admits(range)).toBe(false);
      }
    }
  });

  it('renders only the entries in the strict format, so the rest never reach Traefik', () => {
    const templates = rgd(traefikBootstrap).spec?.resources?.map((resource) => resource.template);
    const expressions = trustedIpsStrings(templates);
    expect(expressions).toHaveLength(4);
    for (const expression of expressions) {
      const predicate = /\.filter\(range, (.*)\) : omit\(\)\}$/.exec(expression)?.[1];
      if (!predicate) throw new Error(`no strict filter in ${expression}`);
      const kept = (value: string) => evaluatePredicate(predicate, 'range', value);
      for (const range of VALID) expect(kept(range)).toBe(true);
      for (const range of [...TRUSTS_ALL, ...MALFORMED]) expect(kept(range)).toBe(false);
    }
  });

  it('keeps /0, and drops only malformed entries, behind dangerouslyTrustAnySource', () => {
    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-any-source-kro',
      kind: 'TraefikAnySourceKro',
      dangerouslyTrustAnySource: true,
    });
    const document = rgd(bootstrap);
    for (const field of trustedIpsStrings(document.spec?.schema?.spec)) {
      expect(field).not.toContain('validation=');
    }
    for (const expression of trustedIpsStrings(
      document.spec?.resources?.map((resource) => resource.template)
    )) {
      const predicate = /\.filter\(range, (.*)\) : omit\(\)\}$/.exec(expression)?.[1] ?? 'none';
      expect(evaluatePredicate(predicate, 'range', '0.0.0.0/0')).toBe(true);
      expect(evaluatePredicate(predicate, 'range', '::ffff:0:0/96')).toBe(false);
      expect(evaluatePredicate(predicate, 'range', '0.0.0.0/00')).toBe(false);
    }
  });
});
