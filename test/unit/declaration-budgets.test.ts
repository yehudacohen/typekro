import { describe, expect, it } from 'bun:test';
import {
  type Baseline,
  type BudgetsConfig,
  evaluateBudgets,
  suggestBudget,
} from '../../scripts/declaration-budgets/budgets.js';
import {
  analyzeComments,
  attribute,
  classifyEdges,
  createOwnerMatcher,
  type DeclarationHost,
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

  it('reports overruns, ratchet candidates, and missing budgets', () => {
    const evaluation = evaluateBudgets(
      attribution,
      config({ owners: { core: 1, alpha: 100_000 } }),
      undefined
    );
    const status = Object.fromEntries(evaluation.rows.map((row) => [row.owner, row.status]));
    expect(status).toEqual({ core: 'over', alpha: 'ratchet', beta: 'unbudgeted' });
    expect(evaluation.overruns).toHaveLength(1);
    expect(evaluation.configErrors).toEqual([
      'Owner "beta" has no budget in declaration-budgets.json.',
    ]);
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
