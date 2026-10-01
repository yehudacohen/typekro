import { describe, expect, it } from 'bun:test';
import {
  type Baseline,
  type BudgetsConfig,
  evaluateBudgets,
  suggestBudget,
  suggestOwnerBudgets,
} from '../../scripts/declaration-budgets/budgets.js';
import {
  analyzeComments,
  attribute,
  classifyEdges,
  createOwnerMatcher,
  type DeclarationHost,
  deadOwnerPatterns,
  importChain,
  type OwnersConfig,
  parseDeclaration,
  resolveSpecifier,
  walkDeclarationGraph,
} from '../../scripts/declaration-budgets/graph.js';

const hostOf = (files: Record<string, string>): DeclarationHost => ({
  readFile: (path) => files[path],
});

/**
 * A small package: core types, two integrations, a root barrel, and one
 * file nothing public reaches.
 */
const fixture: Record<string, string> = {
  'dist/index.d.ts': [
    "export * from './core/types.js';",
    "export * as alpha from './factories/alpha/index.js';",
  ].join('\n'),
  'dist/core/types.d.ts': [
    '/** A resource. */',
    'export interface Resource { name: string }',
    "export type { Helper } from './helper.js';",
  ].join('\n'),
  'dist/core/helper.d.ts': 'export type Helper = string;\n',
  'dist/core/unused.d.ts':
    '/** Never imported from a declaration. */\nexport declare const x: 1;\n',
  'dist/factories/alpha/index.d.ts': [
    "export type { Resource } from '../../core/types.js';",
    "import type { BetaConfig } from '../beta/types.js';",
    'export interface AlphaConfig { beta: BetaConfig }',
  ].join('\n'),
  'dist/factories/beta/index.d.ts': [
    "export * from './types.js';",
    "export declare const make: () => import('../../index.js').Resource;",
  ].join('\n'),
  'dist/factories/beta/types.d.ts': 'export interface BetaConfig { size: number }\n',
};

const owners: OwnersConfig = {
  declarationRoot: 'dist',
  coreOwner: 'core',
  owners: [
    { owner: 'core', paths: ['index.d.ts', 'core/**'] },
    { owner: 'alpha', paths: ['factories/alpha/**'] },
    { owner: 'beta', paths: ['factories/beta/**'] },
  ],
  rootBarrels: ['index.d.ts'],
  rootEntry: { export: '.', allowedOwners: ['core', 'alpha'] },
  allowedEdges: [],
};

const entries = {
  '.': 'dist/index.d.ts',
  './alpha': 'dist/factories/alpha/index.d.ts',
  './beta': 'dist/factories/beta/index.d.ts',
};

const emittedOf = (files: Record<string, string>) =>
  Object.entries(files).map(([path, text]) => ({ path, rawBytes: Buffer.byteLength(text) }));

describe('analyzeComments', () => {
  it('separates JSDoc, other comments, and surface bytes', () => {
    const text = '/** doc */\n// line\n/* block */\nexport type A = 1;\n';
    const stats = analyzeComments(text);
    expect(stats.rawBytes).toBe(text.length);
    expect(stats.docBytes).toBe('/** doc */'.length);
    expect(stats.commentBytes).toBe('/** doc */'.length + '// line'.length + '/* block */'.length);
    expect(stats.surfaceBytes).toBe(stats.rawBytes - stats.commentBytes);
  });

  it('ignores comment markers inside string and template literal types', () => {
    const text = [
      "export type Url = 'https://example.com/*not a comment*/';",
      'export type Path<A extends string> = `${A}://${A}//x`;',
      'export type Nested = { a: `${string}//` };',
      '// real',
    ].join('\n');
    const stats = analyzeComments(text);
    expect(stats.commentBytes).toBe('// real'.length);
    expect(stats.docBytes).toBe(0);
  });

  it('counts multi-byte characters as UTF-8 bytes', () => {
    expect(analyzeComments('/** é */').docBytes).toBe(9);
  });
});

describe('parseDeclaration', () => {
  it('collects every kind of module reference', () => {
    const { specifiers } = parseDeclaration(
      'dist/a.d.ts',
      [
        '/// <reference path="./globals.d.ts" />',
        "import type { A } from './a.js';",
        "import './side-effect.js';",
        "export * from './star.js';",
        "export * as ns from './ns.js';",
        "export { B } from './b.js';",
        "export declare const c: import('./c.js').C;",
        "import D = require('./d.js');",
        "declare module './augmented.js' { interface X {} }",
        "import type { External } from 'arktype';",
      ].join('\n')
    );
    expect(specifiers.sort()).toEqual(
      [
        './a.js',
        './augmented.js',
        './b.js',
        './c.js',
        './d.js',
        './globals.d.ts',
        './ns.js',
        './side-effect.js',
        './star.js',
        'arktype',
      ].sort()
    );
  });

  it('finds declarations tagged @internal', () => {
    const { internal } = parseDeclaration(
      'dist/a.d.ts',
      [
        '/** Public. */',
        'export interface Visible { a: string }',
        '/** @internal */',
        'export declare function hidden(): void;',
        'export interface Options {',
        '  /** @internal test hook */',
        '  hook?: () => void;',
        '}',
      ].join('\n')
    );
    expect(internal.map((symbol) => [symbol.name, symbol.line])).toEqual([
      ['hidden', 4],
      ['hook', 7],
    ]);
  });
});

describe('resolveSpecifier', () => {
  const host = hostOf({
    'dist/a/b.d.ts': '',
    'dist/a/dir/index.d.ts': '',
  });

  it('maps emitted .js specifiers to .d.ts files', () => {
    expect(resolveSpecifier('dist/a/x.d.ts', './b.js', host)).toEqual({
      kind: 'resolved',
      path: 'dist/a/b.d.ts',
    });
    expect(resolveSpecifier('dist/c.d.ts', './a/b.js', host)).toEqual({
      kind: 'resolved',
      path: 'dist/a/b.d.ts',
    });
  });

  it('resolves extensionless and directory specifiers', () => {
    expect(resolveSpecifier('dist/a/x.d.ts', './b', host)).toEqual({
      kind: 'resolved',
      path: 'dist/a/b.d.ts',
    });
    expect(resolveSpecifier('dist/a/x.d.ts', './dir', host)).toEqual({
      kind: 'resolved',
      path: 'dist/a/dir/index.d.ts',
    });
  });

  it('distinguishes external packages from missing relative files', () => {
    expect(resolveSpecifier('dist/a/x.d.ts', 'arktype', host)).toEqual({ kind: 'external' });
    expect(resolveSpecifier('dist/a/x.d.ts', '../gone.js', host)).toEqual({ kind: 'missing' });
  });
});

describe('walkDeclarationGraph', () => {
  const graph = walkDeclarationGraph(entries, hostOf(fixture));

  it('reaches files through re-exports, imports, and import() types', () => {
    expect([...graph.files.keys()].sort()).toEqual([
      'dist/core/helper.d.ts',
      'dist/core/types.d.ts',
      'dist/factories/alpha/index.d.ts',
      'dist/factories/beta/index.d.ts',
      'dist/factories/beta/types.d.ts',
      'dist/index.d.ts',
    ]);
    expect(graph.missing).toEqual([]);
  });

  it('keeps a reachable set per entry, following cycles', () => {
    expect([...(graph.entries.get('./alpha') ?? [])].sort()).toEqual([
      'dist/core/helper.d.ts',
      'dist/core/types.d.ts',
      'dist/factories/alpha/index.d.ts',
      'dist/factories/beta/types.d.ts',
    ]);
    // beta -> index (import() type) -> alpha -> beta/types: the whole root.
    expect(graph.entries.get('./beta')?.size).toBe(6);
  });

  it('reports unresolved relative imports and missing entries', () => {
    const broken = walkDeclarationGraph(
      { '.': 'dist/index.d.ts', './gone': 'dist/gone.d.ts' },
      hostOf({ 'dist/index.d.ts': "export * from './nowhere.js';" })
    );
    expect(broken.missing).toEqual([
      { from: 'dist/index.d.ts', specifier: './nowhere.js' },
      { from: 'exports["./gone"]', specifier: 'dist/gone.d.ts' },
    ]);
  });

  it('explains why a file is reachable', () => {
    expect(importChain(graph, 'dist/core/helper.d.ts')).toEqual([
      'dist/index.d.ts',
      'dist/core/types.d.ts',
      'dist/core/helper.d.ts',
    ]);
    expect(importChain(graph, 'dist/core/unused.d.ts')).toBeUndefined();
  });
});

describe('createOwnerMatcher', () => {
  it('uses the first matching rule and anchors globs to the declaration root', () => {
    const ownerOf = createOwnerMatcher({
      declarationRoot: 'dist',
      owners: [
        { owner: 'special', paths: ['factories/alpha/special.d.ts'] },
        { owner: 'alpha', paths: ['factories/alpha/**'] },
        { owner: 'top', paths: ['*.d.ts'] },
      ],
    });
    expect(ownerOf('dist/factories/alpha/special.d.ts')).toBe('special');
    expect(ownerOf('dist/factories/alpha/deep/x.d.ts')).toBe('alpha');
    expect(ownerOf('dist/index.d.ts')).toBe('top');
    expect(ownerOf('dist/factories/index.d.ts')).toBeUndefined();
    expect(ownerOf('other/index.d.ts')).toBeUndefined();
  });
});

describe('attribute', () => {
  const graph = walkDeclarationGraph(entries, hostOf(fixture));
  const attribution = attribute(graph, emittedOf(fixture), owners);

  it('charges each reachable file to exactly one owner', () => {
    const bytes = (path: string) => Buffer.byteLength(fixture[path] ?? '');
    expect(attribution.owners.get('core')?.rawBytes).toBe(
      bytes('dist/index.d.ts') + bytes('dist/core/types.d.ts') + bytes('dist/core/helper.d.ts')
    );
    // alpha re-exports a core type: only its own file counts against alpha.
    expect(attribution.owners.get('alpha')?.rawBytes).toBe(
      bytes('dist/factories/alpha/index.d.ts')
    );
    expect(attribution.owners.get('alpha')?.files).toBe(1);
    const total = [...attribution.owners.values()].reduce((sum, usage) => sum + usage.rawBytes, 0);
    const reachable = [...graph.files.values()].reduce((sum, file) => sum + file.stats.rawBytes, 0);
    expect(total).toBe(reachable);
  });

  it('lists unreachable files with their owner', () => {
    expect(attribution.unreachable).toEqual([
      {
        path: 'dist/core/unused.d.ts',
        rawBytes: Buffer.byteLength(fixture['dist/core/unused.d.ts'] ?? ''),
        owner: 'core',
      },
    ]);
  });

  it('reports cross-integration edges but not edges into core or out of root barrels', () => {
    expect(attribution.edges).toEqual([
      {
        from: 'alpha',
        to: 'beta',
        imports: ['dist/factories/alpha/index.d.ts -> dist/factories/beta/types.d.ts'],
      },
    ]);
  });

  it('flags non-barrel files that import a root barrel', () => {
    expect(attribution.barrelImports).toEqual([
      { owner: 'beta', file: 'dist/factories/beta/index.d.ts', barrel: 'dist/index.d.ts' },
    ]);
  });

  it('flags owners the root entry may not reach', () => {
    expect(attribution.rootEntryViolations).toEqual([
      { owner: 'beta', files: ['dist/factories/beta/types.d.ts'] },
    ]);
  });

  it('reports reachable files without an owner', () => {
    const partial = attribute(graph, emittedOf(fixture), {
      ...owners,
      owners: owners.owners.filter((rule) => rule.owner !== 'beta'),
    });
    expect(partial.unowned).toEqual([
      'dist/factories/beta/index.d.ts',
      'dist/factories/beta/types.d.ts',
    ]);
  });

  it('summarizes per-entry reachable bytes', () => {
    const alpha = attribution.entries.find((entry) => entry.export === './alpha');
    expect(alpha?.files).toBe(4);
    expect(alpha?.owners).toEqual(['alpha', 'beta', 'core']);
  });
});

describe('deadOwnerPatterns', () => {
  it('lists owner globs that match no reachable file', () => {
    const graph = walkDeclarationGraph(entries, hostOf(fixture));
    expect(
      deadOwnerPatterns(graph, {
        declarationRoot: 'dist',
        owners: [
          ...owners.owners,
          // Matches only an unreachable file.
          { owner: 'extra', paths: ['core/unused.d.ts', 'factories/gamma/**'] },
        ],
      })
    ).toEqual([
      { owner: 'extra', pattern: 'core/unused.d.ts' },
      { owner: 'extra', pattern: 'factories/gamma/**' },
    ]);
    expect(deadOwnerPatterns(graph, owners)).toEqual([]);
  });
});

describe('classifyEdges', () => {
  it('splits allowlisted, new, and stale edges', () => {
    const edges = [
      { from: 'a', to: 'b', imports: [] },
      { from: 'a', to: 'c', imports: [] },
    ];
    const result = classifyEdges(edges, [
      { from: 'a', to: 'b' },
      { from: 'x', to: 'y' },
    ]);
    expect(result.allowed.map((edge) => edge.to)).toEqual(['b']);
    expect(result.added.map((edge) => edge.to)).toEqual(['c']);
    expect(result.stale).toEqual([{ from: 'x', to: 'y' }]);
  });
});

describe('evaluateBudgets', () => {
  const graph = walkDeclarationGraph(entries, hostOf(fixture));
  const attribution = attribute(graph, emittedOf(fixture), owners);
  const usage = (owner: string) => attribution.owners.get(owner)?.rawBytes ?? 0;
  const config = (overrides: Partial<BudgetsConfig> = {}): BudgetsConfig => ({
    mode: 'report',
    globalCapBytes: 1_000_000,
    headroom: { minBytes: 100, fraction: 0.05 },
    sharedPoolBytes: 10_000,
    pooledOwners: [],
    docDropFraction: 0.2,
    owners: {
      core: suggestBudget(usage('core'), { minBytes: 100, fraction: 0.05 }),
      alpha: suggestBudget(usage('alpha'), { minBytes: 100, fraction: 0.05 }),
      beta: suggestBudget(usage('beta'), { minBytes: 100, fraction: 0.05 }),
    },
    ...overrides,
  });

  it('suggests usage plus max(minimum, fraction), rounded up to 256 bytes', () => {
    expect(suggestBudget(1000, { minBytes: 8192, fraction: 0.05 })).toBe(9216);
    expect(suggestBudget(1_000_000, { minBytes: 8192, fraction: 0.05 })).toBe(1_050_112);
  });

  it('passes when every owner is within budget', () => {
    const evaluation = evaluateBudgets(attribution, config(), undefined);
    expect(evaluation.configErrors).toEqual([]);
    expect(evaluation.overruns).toEqual([]);
    expect(evaluation.rows.every((row) => row.status === 'ok')).toBe(true);
  });

  it('applies the 4 KiB minimum to tiny owners and 2% to large ones', () => {
    const headroom = { minBytes: 4096, fraction: 0.02 };
    // 100 + 4096, rounded up to 256.
    expect(suggestBudget(100, headroom)).toBe(4352);
    expect(suggestBudget(0, headroom)).toBe(4096);
    // At 200 KiB, 2% is exactly 4 KiB.
    expect(suggestBudget(204_800, headroom)).toBe(208_896);
    // 1,000,000 + 20,000, rounded up to 256.
    expect(suggestBudget(1_000_000, headroom)).toBe(1_020_160);
  });

  it('reports overruns and ratchet candidates; a pooled owner uses the pool', () => {
    const evaluation = evaluateBudgets(
      attribution,
      config({ owners: { core: 1, alpha: 100_000 }, pooledOwners: ['beta'] }),
      undefined
    );
    const status = Object.fromEntries(evaluation.rows.map((row) => [row.owner, row.status]));
    expect(status).toEqual({ core: 'over', alpha: 'ratchet', beta: 'pool' });
    expect(evaluation.overruns).toHaveLength(1);
    expect(evaluation.configErrors).toEqual([]);
  });

  it('charges pooled owners to the shared pool', () => {
    const { beta: _beta, ...listed } = config().owners;
    const evaluation = evaluateBudgets(
      attribution,
      config({ owners: listed, pooledOwners: ['beta'] }),
      undefined
    );
    expect(evaluation.pool).toEqual({ bytes: 10_000, usedBytes: usage('beta'), owners: ['beta'] });
    const beta = evaluation.rows.find((row) => row.owner === 'beta');
    expect(beta?.status).toBe('pool');
    expect(beta?.budget).toBeUndefined();
    expect(evaluation.configErrors).toEqual([]);
    expect(evaluation.overruns).toEqual([]);
  });

  it('reports shared pool overflow as an overrun', () => {
    const { alpha: _alpha, beta: _beta, ...listed } = config().owners;
    const sharedPoolBytes = usage('alpha') + usage('beta') - 1;
    const evaluation = evaluateBudgets(
      attribution,
      config({ owners: listed, pooledOwners: ['alpha', 'beta'], sharedPoolBytes }),
      undefined
    );
    expect(evaluation.pool.usedBytes).toBe(sharedPoolBytes + 1);
    expect(evaluation.pool.owners).toHaveLength(2);
    expect(evaluation.configErrors).toEqual([]);
    expect(evaluation.overruns).toEqual([
      `Pooled owners (${evaluation.pool.owners.join(', ')}) use ${sharedPoolBytes + 1} bytes, ` +
        `over the shared pool of ${sharedPoolBytes}. Give the largest one its own budget, remove ` +
        'it from pooledOwners and shrink the pool by the same amount, or make room elsewhere.',
    ]);
  });

  it('passes when pooled owners fill the pool exactly', () => {
    const { alpha: _alpha, ...listed } = config().owners;
    const evaluation = evaluateBudgets(
      attribution,
      config({ owners: listed, pooledOwners: ['alpha'], sharedPoolBytes: usage('alpha') }),
      undefined
    );
    expect(evaluation.pool.usedBytes).toBe(evaluation.pool.bytes);
    expect(evaluation.overruns).toEqual([]);
    expect(evaluation.configErrors).toEqual([]);
  });

  it('does not list an owner with no bytes as a pool user', () => {
    const empty = attribute(graph, emittedOf(fixture), owners);
    const alpha = empty.owners.get('alpha');
    if (!alpha) throw new Error('fixture has no alpha usage');
    empty.owners.set('alpha', { ...alpha, rawBytes: 0 });
    const { alpha: _alpha, ...listed } = config().owners;
    const evaluation = evaluateBudgets(
      empty,
      config({ owners: listed, pooledOwners: ['alpha'] }),
      undefined
    );
    expect(evaluation.rows.find((row) => row.owner === 'alpha')?.status).toBe('pool');
    expect(evaluation.pool).toEqual({ bytes: 10_000, usedBytes: 0, owners: [] });
  });

  it('rejects an owner with neither a budget nor a pool entry', () => {
    const { beta: _beta, ...listed } = config().owners;
    const evaluation = evaluateBudgets(attribution, config({ owners: listed }), undefined);
    expect(evaluation.rows.find((row) => row.owner === 'beta')?.status).toBe('unbudgeted');
    expect(evaluation.configErrors).toEqual([
      'Owner "beta" has no budget. Add one to owners, or, for a new integration, list it in pooledOwners.',
    ]);
    expect(evaluation.pool.owners).toEqual([]);
  });

  it('rejects an owner with both a budget and a pool entry', () => {
    const evaluation = evaluateBudgets(attribution, config({ pooledOwners: ['beta'] }), undefined);
    expect(evaluation.configErrors).toEqual([
      'Owner "beta" has its own budget and is also in pooledOwners. Keep only one.',
    ]);
    // The owner is still held to its own budget, not the pool.
    expect(evaluation.rows.find((row) => row.owner === 'beta')?.status).toBe('ok');
    expect(evaluation.pool.owners).toEqual([]);
  });

  it('rejects pool entries that name no owner, and a missing pooledOwners list', () => {
    expect(
      evaluateBudgets(attribution, config({ pooledOwners: ['ghost'] }), undefined).configErrors
    ).toEqual(['Pooled owner "ghost" has no matching owner in the owners map.']);
    const { pooledOwners: _pooled, ...withoutList } = config();
    expect(
      evaluateBudgets(attribution, withoutList as BudgetsConfig, undefined).configErrors
    ).toEqual(['pooledOwners must be a list of owner names (use [] for none).']);
  });

  it('rejects a missing, fractional or negative shared pool', () => {
    const { sharedPoolBytes: _pool, ...withoutPool } = config();
    for (const [sharedPoolBytes, shown] of [
      [undefined, 'undefined'],
      [Number.NaN, 'null'],
      [1.5, '1.5'],
      [-1, '-1'],
    ] as const) {
      const evaluation = evaluateBudgets(
        attribution,
        { ...withoutPool, sharedPoolBytes } as BudgetsConfig,
        undefined
      );
      expect(evaluation.configErrors).toContain(
        `sharedPoolBytes must be a whole number of bytes, 0 or more; got ${shown}.`
      );
      expect(evaluation.pool.bytes).toBe(0);
      expect(Number.isFinite(evaluation.committedBytes)).toBe(true);
    }
  });

  it('still reports budgets over the cap when the pool is invalid', () => {
    const { budgetSum } = evaluateBudgets(attribution, config(), undefined);
    const evaluation = evaluateBudgets(
      attribution,
      config({ globalCapBytes: budgetSum - 1, sharedPoolBytes: -5_000_000 }),
      undefined
    );
    expect(evaluation.configErrors.some((error) => error.includes('above the global cap'))).toBe(
      true
    );
  });

  it('suggests budgets only for owners that already have one', () => {
    const { beta: _beta, ...listed } = config().owners;
    const suggested = suggestOwnerBudgets(
      attribution,
      config({ owners: { ...listed, core: 1 }, pooledOwners: ['beta'] })
    );
    expect(Object.keys(suggested)).toEqual(['alpha', 'core']);
    expect(suggested.core).toBe(suggestBudget(usage('core'), config().headroom));
  });

  it('rejects owner budgets plus the shared pool above the global cap', () => {
    const { budgetSum } = evaluateBudgets(attribution, config(), undefined);
    const evaluation = evaluateBudgets(
      attribution,
      config({ globalCapBytes: budgetSum + 10_000 - 1 }),
      undefined
    );
    expect(evaluation.committedBytes).toBe(budgetSum + 10_000);
    expect(evaluation.configErrors).toEqual([
      `Owner budgets (${budgetSum} bytes) plus the shared pool (10000 bytes) sum to ` +
        `${budgetSum + 10_000} bytes, above the global cap of ${budgetSum + 10_000 - 1}.`,
    ]);
  });

  it('reports budgets that fit the cap only once unreachable files stop shipping', () => {
    const { committedBytes, unreachableRawBytes } = evaluateBudgets(
      attribution,
      config(),
      undefined
    );
    expect(unreachableRawBytes).toBe(Buffer.byteLength(fixture['dist/core/unused.d.ts'] ?? ''));
    const evaluation = evaluateBudgets(
      attribution,
      config({ globalCapBytes: committedBytes + unreachableRawBytes - 1 }),
      undefined
    );
    // Not a configuration error: the budgets fit once the unreachable files are pruned.
    expect(evaluation.configErrors).toEqual([]);
    expect(evaluation.overruns).toHaveLength(1);
    expect(evaluation.overruns[0]).toContain('only if the 1 unreachable declaration files');
    expect(evaluation.overruns[0]).toContain('overcommit the cap by 1 bytes');

    const fits = evaluateBudgets(
      attribution,
      config({ globalCapBytes: committedBytes + unreachableRawBytes }),
      undefined
    );
    expect(fits.overruns).toEqual([]);
  });

  it('rejects budgets that sum above the global cap or name unknown owners', () => {
    const evaluation = evaluateBudgets(
      attribution,
      config({ globalCapBytes: 10, owners: { ...config().owners, ghost: 1 } }),
      undefined
    );
    expect(evaluation.configErrors).toContain(
      'Budget for "ghost" has no matching owner in the owners map.'
    );
    expect(evaluation.configErrors.some((error) => error.includes('above the global cap'))).toBe(
      true
    );
    expect(evaluation.overruns.some((overrun) => overrun.includes('global cap'))).toBe(true);
  });

  it('computes deltas and flags doc drops against the baseline', () => {
    const core = attribution.owners.get('core');
    if (!core) throw new Error('fixture has no core usage');
    const baseline: Baseline = {
      schemaVersion: 1,
      packageVersion: '0.0.0',
      owners: {
        core: { ...core, rawBytes: core.rawBytes + 50, docBytes: core.docBytes * 2 },
      },
      reachable: { files: 0, rawBytes: 0 },
      unreachable: { files: 0, rawBytes: 0 },
      edges: [],
    };
    const evaluation = evaluateBudgets(attribution, config(), baseline);
    const row = evaluation.rows.find((candidate) => candidate.owner === 'core');
    expect(row?.deltaRawBytes).toBe(-50);
    expect(row?.docDrop).toBeCloseTo(0.5);
    expect(evaluation.docDrops).toHaveLength(1);
    expect(
      evaluation.rows.find((candidate) => candidate.owner === 'alpha')?.deltaRawBytes
    ).toBeUndefined();
  });
});
