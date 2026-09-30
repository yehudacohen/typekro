/**
 * Public API snapshot: every symbol each `package.json` export exposes, with
 * its kind. Namespace re-exports (`export * as traefik`) list their members too.
 *
 *   bun run check:public-api            # compare dist/ with scripts/public-api-snapshot.txt
 *   bun run check:public-api --update   # rewrite the snapshot
 *   bun run check:public-api --with-types --out <file>
 *                                       # also hash each symbol's type text (slow; for audits)
 *
 * Run after `bun run build:lib`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { compareText } from './graph.js';
import { measurePackage, packageRoot, scriptsDir } from './package.js';

const argv = process.argv.slice(2);
const withTypes = argv.includes('--with-types');
const outIndex = argv.indexOf('--out');
const snapshotPath = join(scriptsDir, 'public-api-snapshot.txt');

const { entries } = measurePackage();
const entryFiles = Object.entries(entries)
  .map(([name, path]) => [name, join(packageRoot, path)] as const)
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

function kinds(symbol: ts.Symbol): string {
  const result: string[] = [];
  if (symbol.flags & ts.SymbolFlags.Module) result.push('namespace');
  else {
    if (symbol.flags & ts.SymbolFlags.Value) result.push('value');
    if (symbol.flags & ts.SymbolFlags.Type) result.push('type');
  }
  return result.length > 0 ? result.join('+') : 'unresolved';
}

function typeHash(symbol: ts.Symbol): string {
  const parts: string[] = [];
  if (symbol.flags & ts.SymbolFlags.Value && !(symbol.flags & ts.SymbolFlags.Module)) {
    parts.push(checker.typeToString(checker.getTypeOfSymbol(symbol), undefined, flags));
  }
  if (symbol.flags & ts.SymbolFlags.Type) {
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    parts.push(checker.typeToString(declared, undefined, flags | ts.TypeFormatFlags.InTypeAlias));
    for (const property of checker.getPropertiesOfType(declared)) {
      parts.push(
        `${property.name}: ${checker.typeToString(checker.getTypeOfSymbol(property), undefined, flags)}`
      );
    }
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

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
      lines.push(
        [entryName, name, kinds(target), ...(withTypes ? [typeHash(target)] : [])].join('\t')
      );
      if (target.flags & ts.SymbolFlags.Module && depth === 0) {
        visit(checker.getExportsOfModule(target), `${name}.`, depth + 1);
      }
    }
  };
  visit(checker.getExportsOfModule(moduleSymbol), '', 0);
}
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
    const before = new Set(expected.split('\n').filter(Boolean));
    const after = new Set(lines);
    const removed = [...before].filter((line) => !after.has(line));
    const added = [...after].filter((line) => !before.has(line));
    console.error(
      'The public API changed. Review the diff, then run `bun run check:public-api --update`.'
    );
    for (const line of removed) console.error(`- ${line}`);
    for (const line of added) console.error(`+ ${line}`);
    process.exit(1);
  }
}
