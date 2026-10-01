/**
 * Post-build step: delete emitted declaration files (and their maps) that no
 * public `package.json` export reaches. Runtime `.js` files are untouched.
 *
 * Runs as part of `bun run build:lib`. See scripts/declaration-budgets/README.md.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { measurePackage, packageRoot } from './package.js';

export interface PruneResult {
  pruned: string[];
  bytes: number;
}

/**
 * Deletes unreachable declarations under `root`. Throws, without deleting
 * anything, when the export entries or the declaration graph are incomplete:
 * pruning against a partial graph could delete a public entry's declarations.
 */
export function pruneUnreachableDeclarations(root: string = packageRoot): PruneResult {
  const { graph, attribution, entries, entryFailures } = measurePackage(root);

  const problems = [
    ...entryFailures,
    ...graph.missing.map((missing) => `${missing.from} -> ${missing.specifier} does not resolve.`),
  ];
  if (Object.keys(entries).length === 0)
    problems.push('package.json exposes no declaration entries.');
  if (problems.length > 0) {
    throw new Error(
      `Refusing to prune declarations:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n` +
        'Fix package.json exports, or run `bun run clean && bun run build:lib` if dist/ is stale.'
    );
  }

  let bytes = 0;
  for (const file of attribution.unreachable) {
    for (const path of [file.path, `${file.path}.map`]) {
      const absolute = join(root, path);
      if (existsSync(absolute)) rmSync(absolute);
    }
    bytes += file.rawBytes;
  }
  return { pruned: attribution.unreachable.map((file) => file.path), bytes };
}

if (import.meta.main) {
  try {
    const { pruned, bytes } = pruneUnreachableDeclarations();
    console.log(
      `Pruned ${pruned.length} declaration files (${(bytes / 1024).toFixed(1)} KiB) that no public export reaches.`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
