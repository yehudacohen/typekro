/**
 * Public API snapshot: every symbol each `package.json` export exposes, with
 * its kind and a hash of its type shape. Namespace re-exports
 * (`export * as traefik`) list their members too.
 *
 *   bun run check:public-api            # compare dist/ with scripts/public-api-snapshot.txt
 *   bun run check:public-api --update   # rewrite the snapshot
 *   bun run check:public-api --out <file>   # write the current snapshot elsewhere
 *
 * Run after `bun run build:lib`.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { compareText } from './graph.js';
import { measurePackage, packageRoot, scriptsDir } from './package.js';
import { TypeShapeHasher } from './type-shape.js';

/**
 * Builds the snapshot lines for the package at `root`: one
 * `<export>\t<symbol>\t<kind>\t<type hash>` line per exposed symbol.
 *
 * The hash is structural and follows every type the symbol's signature depends
 * on, recursively; see type-shape.ts. It contains no absolute paths, so the
 * snapshot does not depend on where the package or its dependencies are
 * installed.
 */
export function buildApiSnapshot(root: string = packageRoot): string[] {
  const { entries } = measurePackage(root);
  const entryFiles = Object.entries(entries)
    .flatMap(([name, paths]) =>
      paths.map(
        (path) => [paths.length > 1 ? `${name} (${path})` : name, join(root, path)] as const
      )
    )
    .sort(([a], [b]) => compareText(a, b));

  const program = ts.createProgram(
    entryFiles.map(([, file]) => file),
    {
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      exactOptionalPropertyTypes: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    }
  );
  const checker = program.getTypeChecker();

  const rootPrefixes = [...new Set([root, realpathSync(root)])]
    .map((prefix) => `${prefix.replace(/\\/g, '/').replace(/\/$/, '')}/`)
    .sort((a, b) => b.length - a.length);
  const normalize = (fileName: string) => fileName.replace(/\\/g, '/');
  const isPackageFile = (fileName: string) =>
    !normalize(fileName).includes('/node_modules/') &&
    rootPrefixes.some((prefix) => normalize(fileName).startsWith(prefix));
  // A dependency path is cut back to its last node_modules segment, wherever
  // node_modules lives; anything else keeps only its file name.
  const externalModuleName = (fileName: string) => {
    const normalized = normalize(fileName);
    const cut = normalized.lastIndexOf('/node_modules/');
    return cut >= 0
      ? normalized.slice(cut + '/node_modules/'.length)
      : normalized.slice(normalized.lastIndexOf('/') + 1);
  };

  const kinds = (symbol: ts.Symbol): string => {
    if (symbol.flags & ts.SymbolFlags.Module) return 'namespace';
    const result: string[] = [];
    if (symbol.flags & ts.SymbolFlags.Value) result.push('value');
    if (symbol.flags & ts.SymbolFlags.Type) result.push('type');
    return result.length > 0 ? result.join('+') : 'unresolved';
  };

  const resolveAlias = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

  // Pass 1: every public symbol, including namespace members at any depth.
  const rows: { entryName: string; name: string; target: ts.Symbol }[] = [];
  const unloaded: string[] = [];
  for (const [entryName, file] of entryFiles) {
    const sourceFile = program.getSourceFile(file);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      unloaded.push(`${entryName}\t(module did not load)`);
      continue;
    }
    const visit = (symbols: ts.Symbol[], prefix: string, path: ReadonlySet<ts.Symbol>): void => {
      for (const exported of [...symbols].sort((a, b) => compareText(a.name, b.name))) {
        const target = resolveAlias(exported);
        const name = `${prefix}${exported.name}`;
        rows.push({ entryName, name, target });
        if (target.flags & ts.SymbolFlags.Module && !path.has(target)) {
          visit(checker.getExportsOfModule(target), `${name}.`, new Set([...path, target]));
        }
      }
    };
    visit(checker.getExportsOfModule(moduleSymbol), '', new Set([moduleSymbol]));
  }

  // Each public symbol is referenced by the first line that names it.
  const publicNames = new Map<ts.Symbol, string>();
  for (const row of rows) {
    if (!publicNames.has(row.target)) publicNames.set(row.target, `${row.entryName}:${row.name}`);
  }

  // Pass 2: structural hashes.
  const hasher = new TypeShapeHasher({ checker, publicNames, isPackageFile, externalModuleName });
  const hashes = new Map<ts.Symbol, string>();
  const lines = rows.map(({ entryName, name, target }) => {
    let hash = hashes.get(target);
    if (hash === undefined) {
      hash = hasher.hashSymbol(target);
      hashes.set(target, hash);
    }
    return [entryName, name, kinds(target), hash].join('\t');
  });
  return [...unloaded, ...lines];
}

/** Lines only in `expected` (removed) and only in `actual` (added). */
export function diffSnapshots(
  expected: readonly string[],
  actual: readonly string[]
): { removed: string[]; added: string[] } {
  const before = new Set(expected);
  const after = new Set(actual);
  return {
    removed: expected.filter((line) => !after.has(line)),
    added: actual.filter((line) => !before.has(line)),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const snapshotPath = join(scriptsDir, 'public-api-snapshot.txt');
  const lines = buildApiSnapshot();
  const snapshot = `${lines.join('\n')}\n`;

  if (outIndex >= 0) {
    const out = argv[outIndex + 1];
    if (!out) throw new Error('--out needs a path');
    writeFileSync(out, snapshot);
    console.log(`Wrote ${lines.length} symbols to ${out}.`);
  } else if (argv.includes('--update')) {
    writeFileSync(snapshotPath, snapshot);
    console.log(`Wrote ${lines.length} symbols to scripts/public-api-snapshot.txt.`);
  } else {
    const expected = existsSync(snapshotPath) ? readFileSync(snapshotPath, 'utf8') : '';
    if (expected === snapshot) {
      console.log(`Public API snapshot matches (${lines.length} symbols).`);
    } else {
      const { removed, added } = diffSnapshots(expected.split('\n').filter(Boolean), lines);
      console.error(
        'The public API changed: a symbol was added, removed, or its type shape changed.\n' +
          'Review the diff, then run `bun run check:public-api --update` and commit the snapshot.'
      );
      for (const line of removed) console.error(`- ${line}`);
      for (const line of added) console.error(`+ ${line}`);
      process.exit(1);
    }
  }
}
