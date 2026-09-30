/**
 * Guards against declaration fan-out: a subpath export such as `typekro/traefik`
 * must not make TypeScript load the declarations of the whole library.
 *
 * Declaration emit writes `import("../../../index.js").X` for an inferred type
 * that the root barrel re-exports. One such reference makes the subpath reach
 * every file the root entry reaches. Exported compositions and factories
 * therefore carry explicit type annotations that import from core modules.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..', '..');
const dist = join(workspace, 'dist');
/** The factories barrel, which the root entry re-exports. The root entry itself comes from package.json. */
const FACTORIES_BARREL = 'factories/index.d.ts';
/** Base factory directories under `dist/factories/` that belong to core, not to an integration. */
const CORE_FACTORY_DIRS = new Set(['flux', 'helm', 'kro', 'kubernetes', 'simple']);

function ensureBuiltDist(): void {
  if (existsSync(join(dist, 'index.d.ts'))) return;
  const result = spawnSync('bun', ['run', 'build:lib'], { cwd: workspace, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`bun run build:lib failed.\n${result.stdout}${result.stderr}`);
  }
}

function resolveDeclaration(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, '.d.ts'),
    `${base}.d.ts`,
    join(base, 'index.d.ts'),
    base,
  ];
  return candidates.find(
    (candidate) =>
      candidate.endsWith('.d.ts') && existsSync(candidate) && statSync(candidate).isFile()
  );
}

const REFERENCE =
  /(?:from\s+|import\s*\(\s*|import\s+|<reference\s+path=)["'](\.{1,2}\/[^"']+)["']/g;
const importsCache = new Map<string, string[]>();

function importsOf(file: string): string[] {
  let imports = importsCache.get(file);
  if (imports === undefined) {
    imports = [];
    for (const match of readFileSync(file, 'utf8').matchAll(REFERENCE)) {
      const target = match[1] === undefined ? undefined : resolveDeclaration(file, match[1]);
      if (target !== undefined) imports.push(target);
    }
    importsCache.set(file, imports);
  }
  return imports;
}

/** Every declaration file reachable from `entry` through relative imports, re-exports and import types. */
function reachableDeclarations(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const target of importsOf(file)) {
      if (!seen.has(target)) pending.push(target);
    }
  }
  return new Set([...seen].map((file) => relative(dist, file).split('\\').join('/')));
}

function packageEntries(): { root: string; subpaths: Map<string, string> } {
  const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
    exports: Record<string, { types?: string }>;
  };
  const rootTypes = packageJson.exports['.']?.types;
  if (typeof rootTypes !== 'string') throw new Error('package.json exports["."] has no types');
  const subpaths = new Map<string, string>();
  for (const [name, target] of Object.entries(packageJson.exports)) {
    if (name !== '.' && typeof target.types === 'string') {
      subpaths.set(name, join(workspace, target.types));
    }
  }
  return { root: relative(dist, join(workspace, rootTypes)).split('\\').join('/'), subpaths };
}

describe('declaration fan-out', () => {
  ensureBuiltDist();
  const { root, subpaths: entries } = packageEntries();
  const rootBarrels = [root, FACTORIES_BARREL];

  it('keeps every subpath export away from the root barrels', () => {
    const offenders: string[] = [];
    for (const [name, entry] of entries) {
      const reached = reachableDeclarations(entry);
      for (const barrel of rootBarrels) {
        if (reached.has(barrel)) offenders.push(`${name} reaches dist/${barrel}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('loads no unrelated integration declarations for typekro/traefik', () => {
    const entry = entries.get('./traefik');
    if (entry === undefined) throw new Error('package.json has no ./traefik export');
    const integrations = new Set<string>();
    for (const file of reachableDeclarations(entry)) {
      const match = /^factories\/([^/]+)\//.exec(file);
      if (match?.[1] && !CORE_FACTORY_DIRS.has(match[1])) integrations.add(match[1]);
    }
    // Traefik borrows helper types from cert-manager and Gateway API route types.
    expect([...integrations].sort()).toEqual(['cert-manager', 'gateway-api', 'traefik']);
  });
});
