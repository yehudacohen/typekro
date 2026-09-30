import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { buildApiSnapshot, diffSnapshots } from '../../scripts/declaration-budgets/api-snapshot.js';
import {
  declarationTargets,
  matchExportKey,
  measurePackage,
  patternKeyCompare,
  resolveExportEntries,
} from '../../scripts/declaration-budgets/package.js';
import { pruneUnreachableDeclarations } from '../../scripts/declaration-budgets/prune.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Writes a small built package: package.json, an owners map, and dist files. */
function writePackage(exportsField: unknown, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'typekro-declaration-budgets-'));
  temporaryRoots.push(root);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(
    'package.json',
    JSON.stringify({ name: 'fixture', version: '1.0.0', exports: exportsField })
  );
  write(
    'scripts/declaration-owners.json',
    JSON.stringify({
      declarationRoot: 'dist',
      coreOwner: 'core',
      owners: [
        { owner: 'core', paths: ['index.d.ts', 'core/**'] },
        { owner: 'nats', paths: ['nats/**'] },
      ],
      rootBarrels: ['index.d.ts'],
      rootEntry: { export: '.', allowedOwners: ['core'] },
      allowedEdges: [],
    })
  );
  for (const [path, text] of Object.entries(files)) write(path, text);
  return root;
}

const baseFiles: Record<string, string> = {
  'dist/index.d.ts': "export type { Resource } from './core/types.js';\n",
  'dist/index.js': 'export {};\n',
  'dist/core/types.d.ts': 'export interface Resource { name: string }\n',
  'dist/core/types.d.ts.map': '{}',
  'dist/core/internal.d.ts': 'export declare const internal: 1;\n',
  'dist/core/internal.d.ts.map': '{}',
  'dist/core/internal.js': 'export const internal = 1;\n',
  // Only the nats subpath reaches these; the root entry does not.
  'dist/nats/index.d.ts': "export * from './types.js';\n",
  'dist/nats/index.js': 'export {};\n',
  'dist/nats/types.d.ts':
    "import type { Resource } from '../core/types.js';\nexport interface NatsConfig { resource: Resource; replicas: number }\n",
};

/** `./nats` uses nested conditions, which a flat `exports[*].types` read misses. */
const nestedExports = {
  '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  './nats': { import: { types: './dist/nats/index.d.ts', default: './dist/nats/index.js' } },
};

describe('declarationTargets', () => {
  it('follows the whole condition tree', () => {
    expect(declarationTargets('./dist/a.d.ts')).toEqual(['dist/a.d.ts']);
    expect(declarationTargets({ types: './dist/a.d.ts', default: './dist/a.js' })).toEqual([
      'dist/a.d.ts',
    ]);
    expect(
      declarationTargets({
        import: { types: './dist/a.d.ts', default: './dist/a.js' },
        require: { types: './dist/a.d.cts', default: './dist/a.cjs' },
      })
    ).toEqual(['dist/a.d.ts', 'dist/a.d.cts']);
    expect(declarationTargets({ node: [{ types: './dist/n.d.ts' }, './dist/n.js'] })).toEqual([
      'dist/n.d.ts',
    ]);
  });

  it('infers the declaration next to a JavaScript target when no types condition is given', () => {
    expect(declarationTargets({ import: './dist/a.js', require: './dist/a.cjs' })).toEqual([
      'dist/a.d.ts',
      'dist/a.d.cts',
    ]);
    expect(declarationTargets({ default: './styles.css' })).toEqual([]);
  });
});

describe('resolveExportEntries', () => {
  const emitted = ['dist/index.d.ts', 'dist/f/a.d.ts', 'dist/f/b.d.ts', 'dist/f/internal/x.d.ts'];
  const exists = (path: string) => emitted.includes(path);

  it('resolves nested conditions, sugar, and fallbacks', () => {
    expect(resolveExportEntries({ exports: nestedExports }, emitted, () => true).entries).toEqual({
      '.': ['dist/index.d.ts'],
      './nats': ['dist/nats/index.d.ts'],
    });
    expect(resolveExportEntries({ exports: './dist/index.js' }, emitted, exists).entries).toEqual({
      '.': ['dist/index.d.ts'],
    });
    expect(resolveExportEntries({ types: './dist/index.d.ts' }, emitted, exists).entries).toEqual({
      '.': ['dist/index.d.ts'],
    });
  });

  it('expands wildcard subpaths and honours null exclusions', () => {
    const result = resolveExportEntries(
      {
        exports: {
          './f/*': { types: './dist/f/*.d.ts', default: './dist/f/*.js' },
          './f/internal/*': null,
        },
      },
      emitted,
      exists
    );
    expect(result.failures).toEqual([]);
    expect(result.entries).toEqual({ './f/a': ['dist/f/a.d.ts'], './f/b': ['dist/f/b.d.ts'] });
  });

  it('reports exports without declarations or with missing ones', () => {
    const result = resolveExportEntries(
      {
        exports: {
          './styles': { default: './styles.css' },
          './gone': { types: './dist/gone.d.ts' },
          './none/*': './dist/none/*.js',
        },
      },
      emitted,
      exists
    );
    expect(result.failures).toEqual([
      'package.json exports["./styles"] has no types target.',
      'package.json exports["./gone"] points at missing declarations: dist/gone.d.ts.',
      'package.json exports["./none/*"] matches no emitted declarations.',
    ]);
  });
});

describe('export key matching (Node PATTERN_KEY_COMPARE)', () => {
  it('prefers exact keys, then the most specific pattern', () => {
    expect(patternKeyCompare('./a/b/*', './a/*')).toBe(-1);
    expect(patternKeyCompare('./a/*', './a/b/*')).toBe(1);
    expect(patternKeyCompare('./a/*.js', './a/*')).toBe(-1);
    const keys = [
      './internal/*',
      './internal/public',
      './internal/public/*',
      './f/*',
      './f/hidden',
    ];
    expect(matchExportKey('./internal/public', keys)).toEqual({
      key: './internal/public',
      capture: undefined,
    });
    expect(matchExportKey('./internal/public/x', keys)).toEqual({
      key: './internal/public/*',
      capture: 'x',
    });
    expect(matchExportKey('./internal/secret', keys)?.key).toBe('./internal/*');
    expect(matchExportKey('./f/hidden', keys)?.key).toBe('./f/hidden');
    expect(matchExportKey('./other', keys)).toBeUndefined();
  });
});

/**
 * Exports maps that are easy to get wrong. For each subpath, the declarations
 * TypeScript resolves in any mode must be a subset of what the resolver
 * returns, and a subpath TypeScript cannot resolve in any mode must have no
 * entry.
 */
const trickyExports: { name: string; exports: Record<string, unknown>; subpaths: string[] }[] = [
  {
    name: 'import listed before types',
    exports: { './a': { import: './a.js', types: './b.d.ts' } },
    subpaths: ['./a'],
  },
  {
    name: 'types listed before import',
    exports: { './a': { types: './b.d.ts', import: './a.js' } },
    subpaths: ['./a'],
  },
  {
    name: 'nested import and require conditions',
    exports: {
      '.': {
        import: { types: './esm.d.ts', default: './esm.js' },
        require: { types: './cjs.d.cts', default: './cjs.cjs' },
      },
    },
    subpaths: ['.'],
  },
  {
    name: 'node condition before default, and a fallback array',
    exports: { './n': { node: './n-node.js', default: './n.js' }, './arr': ['./arr.js'] },
    subpaths: ['./n', './arr'],
  },
  {
    name: 'exact key beats a null pattern',
    exports: { './internal/*': null, './internal/public': './internal/public.js' },
    subpaths: ['./internal/public', './internal/secret'],
  },
  {
    name: 'more specific pattern beats a null pattern',
    exports: { './internal/*': null, './internal/public/*': './internal/public/*.js' },
    subpaths: ['./internal/public/x', './internal/secret'],
  },
  {
    name: 'null exact key beats a pattern',
    exports: { './f/*': './f/*.js', './f/hidden': null },
    subpaths: ['./f/a', './f/hidden'],
  },
];

const trickyFiles = [
  'a.d.ts',
  'b.d.ts',
  'esm.d.ts',
  'cjs.d.cts',
  'n-node.d.ts',
  'n.d.ts',
  'arr.d.ts',
  'internal/public.d.ts',
  'internal/secret.d.ts',
  'internal/public/x.d.ts',
  'f/a.d.ts',
  'f/hidden.d.ts',
];

describe('resolveExportEntries agrees with TypeScript', () => {
  for (const testCase of trickyExports) {
    it(testCase.name, () => {
      const root = mkdtempSync(join(tmpdir(), 'typekro-exports-'));
      temporaryRoots.push(root);
      const packageDir = join(root, 'node_modules', 'pkg');
      for (const file of trickyFiles) {
        mkdirSync(dirname(join(packageDir, file)), { recursive: true });
        writeFileSync(join(packageDir, file), 'export declare const x: 1;\n');
        const runtime = file.replace(/\.d\.ts$/, '.js').replace(/\.d\.cts$/, '.cjs');
        writeFileSync(join(packageDir, runtime), 'export const x = 1;\n');
      }
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: 'pkg', version: '1.0.0', type: 'module', exports: testCase.exports })
      );
      const importer = join(root, 'index.ts');
      writeFileSync(importer, '');

      const modes: [ts.CompilerOptions, ts.ResolutionMode][] = [
        [
          { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler },
          undefined,
        ],
        [
          { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 },
          ts.ModuleKind.ESNext,
        ],
        [
          { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 },
          ts.ModuleKind.CommonJS,
        ],
      ];
      const { entries } = resolveExportEntries({ exports: testCase.exports }, trickyFiles, (path) =>
        trickyFiles.includes(path)
      );

      for (const subpath of testCase.subpaths) {
        const specifier = subpath === '.' ? 'pkg' : `pkg/${subpath.slice(2)}`;
        const resolvedByTypeScript = new Set<string>();
        for (const [options, mode] of modes) {
          const resolved = ts.resolveModuleName(
            specifier,
            importer,
            options,
            ts.sys,
            undefined,
            undefined,
            mode
          ).resolvedModule?.resolvedFileName;
          if (resolved)
            resolvedByTypeScript.add(relative(realpathSync(packageDir), realpathSync(resolved)));
        }
        const ours = entries[subpath];
        if (resolvedByTypeScript.size === 0) {
          expect({ subpath, ours }).toEqual({ subpath, ours: undefined });
        } else {
          expect({
            subpath,
            missing: [...resolvedByTypeScript].filter((file) => !ours?.includes(file)),
          }).toEqual({
            subpath,
            missing: [],
          });
        }
      }
    });
  }

  it('resolves both orderings of import and types conservatively', () => {
    const emitted = ['a.d.ts', 'b.d.ts'];
    const exists = (path: string) => emitted.includes(path);
    for (const value of [
      { import: './a.js', types: './b.d.ts' },
      { types: './b.d.ts', import: './a.js' },
    ]) {
      // TypeScript picks a.d.ts for the first ordering and b.d.ts for the second;
      // both are kept whichever order the keys are in.
      const { entries } = resolveExportEntries({ exports: { './a': value } }, emitted, exists);
      expect(entries['./a']?.sort()).toEqual(['a.d.ts', 'b.d.ts']);
      expect(declarationTargets(value).sort()).toEqual(['a.d.ts', 'b.d.ts']);
    }
  });
});

describe('measurePackage', () => {
  it('walks entries declared through nested conditions', () => {
    const measured = measurePackage(writePackage(nestedExports, baseFiles));
    expect(measured.entryFailures).toEqual([]);
    expect([...(measured.graph.entries.get('./nats') ?? [])].sort()).toEqual([
      'dist/core/types.d.ts',
      'dist/nats/index.d.ts',
      'dist/nats/types.d.ts',
    ]);
    expect(measured.attribution.unreachable.map((file) => file.path)).toEqual([
      'dist/core/internal.d.ts',
    ]);
  });
});

describe('pruneUnreachableDeclarations', () => {
  it('deletes unreachable declarations and their maps, keeping runtime files', () => {
    const root = writePackage(nestedExports, baseFiles);
    const result = pruneUnreachableDeclarations(root);
    expect(result.pruned).toEqual(['dist/core/internal.d.ts']);
    expect(existsSync(join(root, 'dist/core/internal.d.ts'))).toBe(false);
    expect(existsSync(join(root, 'dist/core/internal.d.ts.map'))).toBe(false);
    expect(existsSync(join(root, 'dist/core/internal.js'))).toBe(true);
    // The nested-condition entry keeps its declarations.
    expect(existsSync(join(root, 'dist/nats/types.d.ts'))).toBe(true);
    expect(existsSync(join(root, 'dist/core/types.d.ts.map'))).toBe(true);
  });

  it('refuses to prune anything when an entry cannot be resolved', () => {
    const root = writePackage(
      { ...nestedExports, './styles': { default: './styles.css' } },
      baseFiles
    );
    expect(() => pruneUnreachableDeclarations(root)).toThrow(
      'package.json exports["./styles"] has no types target.'
    );
    expect(existsSync(join(root, 'dist/core/internal.d.ts'))).toBe(true);
  });

  it('refuses to prune when a reachable declaration import does not resolve', () => {
    const root = writePackage(nestedExports, {
      ...baseFiles,
      'dist/nats/index.d.ts': "export * from './types.js';\nexport * from './deleted.js';\n",
    });
    expect(() => pruneUnreachableDeclarations(root)).toThrow('./deleted.js does not resolve');
    expect(existsSync(join(root, 'dist/core/internal.d.ts'))).toBe(true);
  });
});

describe('buildApiSnapshot', () => {
  it('lists exported symbols with kinds and namespace members', () => {
    const root = writePackage(
      {
        '.': { types: './dist/index.d.ts' },
        './nats': { types: './dist/nats/index.d.ts' },
      },
      {
        ...baseFiles,
        'dist/index.d.ts':
          "export type { Resource } from './core/types.js';\nexport * as nats from './nats/index.js';\nexport declare function make(name: string): import('./core/types.js').Resource;\n",
      }
    );
    const names = buildApiSnapshot(root).map((line) => line.split('\t').slice(0, 3).join(' '));
    expect(names).toEqual([
      '. Resource type',
      '. make value',
      '. nats namespace',
      '. nats.NatsConfig type',
      './nats NatsConfig type',
    ]);
  });

  it('hashes type shapes independently of the checkout location', () => {
    const files = {
      ...baseFiles,
      'dist/index.d.ts':
        "import type { Resource } from './core/types.js';\nexport declare function make(name: string): Resource;\n",
    };
    const first = buildApiSnapshot(writePackage(nestedExports, files));
    const second = buildApiSnapshot(writePackage(nestedExports, files));
    expect(second).toEqual(first);
  });

  it('changes the hash when a type is widened', () => {
    const before = buildApiSnapshot(writePackage(nestedExports, baseFiles));
    const after = buildApiSnapshot(
      writePackage(nestedExports, {
        ...baseFiles,
        'dist/nats/types.d.ts':
          "import type { Resource } from '../core/types.js';\nexport interface NatsConfig { resource: Resource; replicas: number | string }\n",
      })
    );
    const { removed, added } = diffSnapshots(before, after);
    expect(removed.map((line) => line.split('\t')[1])).toEqual(['NatsConfig']);
    expect(added.map((line) => line.split('\t')[1])).toEqual(['NatsConfig']);
  });
});
