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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { compareText } from './graph.js';
import { measurePackage, packageRoot, scriptsDir } from './package.js';

/**
 * Builds the snapshot lines for the package at `root`: one
 * `<export>\t<symbol>\t<kind>\t<type hash>` line per exposed symbol.
 *
 * Type text is printed with fully qualified names, which embed absolute module
 * paths. Those paths are made relative before hashing, so the snapshot does not
 * depend on where the package or its dependencies are installed.
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
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType;

  const rootPrefixes = [...new Set([root, realpathSync(root)])]
    .map((prefix) => `${prefix.replace(/\\/g, '/').replace(/\/$/, '')}/`)
    .sort((a, b) => b.length - a.length);
  // Package paths become relative to the root, and any dependency path is cut
  // back to its node_modules segment, wherever node_modules lives.
  const relativize = (text: string): string =>
    rootPrefixes
      .reduce((result, prefix) => result.split(prefix).join(''), text)
      .replace(/"[^"]*\/node_modules\//g, '"node_modules/');
  const print = (type: ts.Type, extra = ts.TypeFormatFlags.None): string =>
    relativize(checker.typeToString(type, undefined, flags | extra));

  const kinds = (symbol: ts.Symbol): string => {
    if (symbol.flags & ts.SymbolFlags.Module) return 'namespace';
    const result: string[] = [];
    if (symbol.flags & ts.SymbolFlags.Value) result.push('value');
    if (symbol.flags & ts.SymbolFlags.Type) result.push('type');
    return result.length > 0 ? result.join('+') : 'unresolved';
  };

  const typeHash = (symbol: ts.Symbol): string => {
    const parts: string[] = [];
    if (symbol.flags & ts.SymbolFlags.Module) {
      parts.push('namespace');
    } else {
      if (symbol.flags & ts.SymbolFlags.Value) parts.push(print(checker.getTypeOfSymbol(symbol)));
      if (symbol.flags & ts.SymbolFlags.Type) {
        const declared = checker.getDeclaredTypeOfSymbol(symbol);
        parts.push(print(declared, ts.TypeFormatFlags.InTypeAlias));
        for (const property of checker.getPropertiesOfType(declared)) {
          const optional = property.flags & ts.SymbolFlags.Optional ? '?' : '';
          parts.push(`${property.name}${optional}: ${print(checker.getTypeOfSymbol(property))}`);
        }
      }
    }
    return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
  };

  const resolveAlias = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

  const lines: string[] = [];
  for (const [entryName, file] of entryFiles) {
    const sourceFile = program.getSourceFile(file);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      lines.push(`${entryName}\t(module did not load)`);
      continue;
    }
    const visit = (symbols: ts.Symbol[], prefix: string, depth: number): void => {
      for (const exported of [...symbols].sort((a, b) => compareText(a.name, b.name))) {
        const target = resolveAlias(exported);
        const name = `${prefix}${exported.name}`;
        lines.push([entryName, name, kinds(target), typeHash(target)].join('\t'));
        if (target.flags & ts.SymbolFlags.Module && depth === 0) {
          visit(checker.getExportsOfModule(target), `${name}.`, depth + 1);
        }
      }
    };
    visit(checker.getExportsOfModule(moduleSymbol), '', 0);
  }
  return lines;
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
