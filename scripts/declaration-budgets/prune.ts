/**
 * Post-build step: delete emitted declaration files (and their maps) that no
 * public `package.json` export reaches. Runtime `.js` files are untouched.
 *
 * Runs as part of `bun run build:lib`. See scripts/declaration-budgets/README.md.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { measurePackage, packageRoot } from './package.js';

const { graph, attribution } = measurePackage();

// A missing target means dist/ is stale or incomplete. Pruning on top of that
// could hide the problem, so stop and ask for a clean build.
if (graph.missing.length > 0) {
  console.error('Refusing to prune: some declaration imports do not resolve.');
  for (const missing of graph.missing) console.error(`- ${missing.from} -> ${missing.specifier}`);
  console.error('Run `bun run clean && bun run build:lib`.');
  process.exit(1);
}

let bytes = 0;
for (const file of attribution.unreachable) {
  for (const path of [file.path, `${file.path}.map`]) {
    const absolute = join(packageRoot, path);
    if (existsSync(absolute)) rmSync(absolute);
  }
  bytes += file.rawBytes;
}

console.log(
  `Pruned ${attribution.unreachable.length} declaration files (${(bytes / 1024).toFixed(1)} KiB) that no public export reaches.`
);
