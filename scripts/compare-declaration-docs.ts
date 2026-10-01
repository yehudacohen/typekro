/**
 * Compares the JSDoc that editors show for every public export between two builds.
 *
 * Declaration emit attaches a JSDoc block to whatever declaration follows it, so moving code
 * (for example adding a type alias or an import between a doc block and its export) can drop
 * hover docs without changing any type. Build both trees with `bun run build:lib`, then:
 *
 *   bun run scripts/compare-declaration-docs.ts <base-package-root> <head-package-root>
 *
 * Each root needs `package.json` and a built `dist/`. Exits non-zero if any public symbol's
 * documentation comment or JSDoc tags differ.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

type DocMap = Map<string, string>;

function collectDocs(packageRoot: string): DocMap {
  const root = resolve(packageRoot);
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports: Record<string, { types?: string }>;
  };
  const entries = Object.entries(packageJson.exports).flatMap(([name, target]) =>
    typeof target.types === 'string' ? [[name, join(root, target.types)] as const] : []
  );
  const program = ts.createProgram(
    entries.map(([, file]) => file),
    {
      noEmit: true,
      skipLibCheck: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
    }
  );
  const checker = program.getTypeChecker();
  const docs: DocMap = new Map();

  const describe = (symbol: ts.Symbol): string => {
    const comment = ts.displayPartsToString(symbol.getDocumentationComment(checker));
    const tags = symbol
      .getJsDocTags(checker)
      .map((tag) => `@${tag.name} ${ts.displayPartsToString(tag.text ?? [])}`.trim());
    return [comment, ...tags].join('\n');
  };

  const visit = (moduleSymbol: ts.Symbol, entry: string, prefix: string, depth: number): void => {
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const key = `${entry}\t${prefix}${exported.name}`;
      docs.set(key, describe(symbol));
      if (symbol.flags & ts.SymbolFlags.ValueModule && depth < 2) {
        visit(symbol, entry, `${prefix}${exported.name}.`, depth + 1);
      }
    }
  };

  for (const [name, file] of entries) {
    const sourceFile = program.getSourceFile(file);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol) visit(moduleSymbol, name, '', 0);
  }
  return docs;
}

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('Usage: bun run scripts/compare-declaration-docs.ts <base-root> <head-root>');
  process.exit(2);
}
const before = collectDocs(base);
const after = collectDocs(head);
const changed = [...new Set([...before.keys(), ...after.keys()])]
  .sort()
  .filter((key) => before.get(key) !== after.get(key));
for (const key of changed) {
  console.log(`${key}\n  base: ${JSON.stringify(before.get(key) ?? null).slice(0, 160)}`);
  console.log(`  head: ${JSON.stringify(after.get(key) ?? null).slice(0, 160)}`);
}
console.log(`Compared ${after.size} public symbols; ${changed.length} differ.`);
process.exit(changed.length > 0 ? 1 : 0);
