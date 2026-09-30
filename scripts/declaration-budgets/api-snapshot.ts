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
import { missingTypeScriptInternal, symbolKinds, TypeShapeHasher } from './type-shape.js';

/**
 * Builds the snapshot lines for the package at `root`: one
 * `<export>\t<symbol>\t<kind>\t<type hash>` line per exposed symbol.
 *
 * The hash is structural and follows every type the symbol's signature depends
 * on, recursively; see type-shape.ts. It contains no absolute paths, so the
 * snapshot does not depend on where the package or its dependencies are
 * installed.
 */
export interface ApiSnapshotOptions {
  /**
   * Order to hash rows in, as a permutation of row indexes. Output order never
   * changes; tests use this to prove hashes do not depend on visiting order.
   */
  hashOrder?: (rowCount: number) => number[];
}

export function buildApiSnapshot(
  root: string = packageRoot,
  options: ApiSnapshotOptions = {}
): string[] {
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

  const resolveAlias = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

  // Pass 1: every public symbol, including namespace members at any depth.
  const rows: { entryName: string; name: string; target: ts.Symbol; typeOnly: boolean }[] = [];
  // `export type { X }` and `export type * from` expose no value, even for a class.
  const typeOnlyAlias = (
    checker as unknown as {
      getTypeOnlyAliasDeclaration?: (symbol: ts.Symbol) => ts.Declaration | undefined;
    }
  ).getTypeOnlyAliasDeclaration;
  if (typeof typeOnlyAlias !== 'function') {
    throw missingTypeScriptInternal('checker.getTypeOnlyAliasDeclaration');
  }
  const exposure = createExposure(checker, (symbol) => typeOnlyAlias.call(checker, symbol));
  const unloaded: string[] = [];
  for (const [entryName, file] of entryFiles) {
    const sourceFile = program.getSourceFile(file);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      unloaded.push(`${entryName}\t(module did not load)`);
      continue;
    }
    const visit = (
      owner: ts.Symbol,
      symbols: ts.Symbol[],
      prefix: string,
      path: ReadonlySet<ts.Symbol>,
      parentTypeOnly: boolean
    ): void => {
      for (const exported of [...symbols].sort((a, b) => compareText(a.name, b.name))) {
        const target = resolveAlias(exported);
        const name = `${prefix}${exported.name}`;
        const typeOnly = parentTypeOnly || exposure(owner, exported.escapedName) === 'type';
        rows.push({ entryName, name, target, typeOnly });
        if (target.flags & ts.SymbolFlags.Module && !path.has(target)) {
          visit(
            target,
            checker.getExportsOfModule(target),
            `${name}.`,
            new Set([...path, target]),
            typeOnly
          );
        }
      }
    };
    visit(
      moduleSymbol,
      checker.getExportsOfModule(moduleSymbol),
      '',
      new Set([moduleSymbol]),
      false
    );
  }

  // Each public symbol is referenced by the first line that names it.
  const publicNames = new Map<ts.Symbol, string>();
  for (const row of rows) {
    if (!publicNames.has(row.target)) publicNames.set(row.target, `${row.entryName}:${row.name}`);
  }

  // Pass 2: structural hashes.
  const hasher = new TypeShapeHasher({ checker, publicNames, isPackageFile, externalModuleName });
  const hashes = new Map<string, string>();
  const symbolKeys = new Map<ts.Symbol, number>();
  const keyOf = (target: ts.Symbol, typeOnly: boolean): string => {
    if (!symbolKeys.has(target)) symbolKeys.set(target, symbolKeys.size);
    return `${symbolKeys.get(target)}:${typeOnly}`;
  };
  const order = options.hashOrder?.(rows.length) ?? rows.map((_, index) => index);
  for (const index of order) {
    const row = rows[index];
    if (!row) continue;
    const key = keyOf(row.target, row.typeOnly);
    if (!hashes.has(key)) hashes.set(key, hasher.hashSymbol(row.target, row.typeOnly));
  }
  const lines = rows.map(({ entryName, name, target, typeOnly }) =>
    [
      entryName,
      name,
      symbolKinds(target, typeOnly),
      hashes.get(keyOf(target, typeOnly)) ?? hasher.hashSymbol(target, typeOnly),
    ].join('\t')
  );
  return [...unloaded, ...lines];
}

/**
 * How a module exposes an export name: `value` when some path can be used as a
 * value, `type` when every path is type-only, `none` when it is not exported.
 *
 * A name exported directly is type-only when its alias declaration is
 * (`export type { X }`, or a re-export of something exported that way). A name
 * that arrives through star exports is followed through every `export *` and
 * `export type *` chain, nested to any depth; a chain with any `export type *`
 * link is type-only. The checker does not record star re-exports as aliases,
 * so this walks the export declarations itself.
 */
export function createExposure(
  checker: ts.TypeChecker,
  typeOnlyAliasDeclaration: (symbol: ts.Symbol) => ts.Declaration | undefined
): (module: ts.Symbol, name: ts.__String) => 'value' | 'type' | 'none' {
  type Exposure = 'value' | 'type' | 'none';
  const cache = new Map<ts.Symbol, Map<ts.__String, Exposure>>();
  // Returns the exposure and whether a star-export cycle cut the search short;
  // only complete results are cached.
  const exposure = (
    module: ts.Symbol,
    name: ts.__String,
    visiting: ReadonlySet<ts.Symbol>
  ): { result: Exposure; partial: boolean } => {
    const cached = cache.get(module)?.get(name);
    if (cached !== undefined) return { result: cached, partial: false };
    if (visiting.has(module)) return { result: 'none', partial: true };

    let result: Exposure = 'none';
    let partial = false;
    const direct = module.exports?.get(name);
    if (direct) {
      result =
        direct.flags & ts.SymbolFlags.Alias && typeOnlyAliasDeclaration(direct) !== undefined
          ? 'type'
          : 'value';
    } else {
      const nextVisiting = new Set([...visiting, module]);
      for (const declaration of module.declarations ?? []) {
        const statements = ts.isSourceFile(declaration)
          ? declaration.statements
          : ts.isModuleDeclaration(declaration) &&
              declaration.body &&
              ts.isModuleBlock(declaration.body)
            ? declaration.body.statements
            : [];
        for (const statement of statements) {
          if (
            !ts.isExportDeclaration(statement) ||
            statement.exportClause ||
            !statement.moduleSpecifier
          ) {
            continue;
          }
          const target = checker.getSymbolAtLocation(statement.moduleSpecifier);
          if (!target) continue;
          const through = exposure(target, name, nextVisiting);
          partial ||= through.partial;
          if (through.result === 'none') continue;
          const viaThisStar = statement.isTypeOnly ? 'type' : through.result;
          if (viaThisStar === 'value') result = 'value';
          else if (result === 'none') result = 'type';
        }
      }
    }
    if (!partial) {
      if (!cache.has(module)) cache.set(module, new Map());
      cache.get(module)?.set(name, result);
    }
    return { result, partial };
  };
  return (module, name) => exposure(module, name, new Set()).result;
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
