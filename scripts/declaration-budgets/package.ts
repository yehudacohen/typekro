/**
 * Loads the built package from disk and measures its declaration graph.
 * Shared by the budget check, the prune step, and the public API snapshot.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  type Attribution,
  attribute,
  compareText,
  type DeclarationGraph,
  type DeclarationHost,
  type OwnersConfig,
  walkDeclarationGraph,
} from './graph.js';

export const packageRoot = resolve(import.meta.dirname, '..', '..');
export const scriptsDir = join(packageRoot, 'scripts');
export const ownersPath = join(scriptsDir, 'declaration-owners.json');

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export interface PackageJson {
  version: string;
  exports: Record<string, { types?: string }>;
}

export interface MeasuredPackage {
  packageJson: PackageJson;
  owners: OwnersConfig;
  /** Export name to declaration path relative to the package root. */
  entries: Record<string, string>;
  /** Every emitted declaration file, reachable or not. */
  emitted: { path: string; rawBytes: number }[];
  graph: DeclarationGraph;
  attribution: Attribution;
  /** Exports without a `types` target. */
  entryFailures: string[];
}

export const toPackagePath = (absolute: string): string =>
  relative(packageRoot, absolute).split(sep).join('/');

export function measurePackage(): MeasuredPackage {
  const packageJson = readJson<PackageJson>(join(packageRoot, 'package.json'));
  const owners = readJson<OwnersConfig>(ownersPath);

  const textCache = new Map<string, string | undefined>();
  const host: DeclarationHost = {
    readFile(path) {
      if (!textCache.has(path)) {
        const absolute = join(packageRoot, path);
        textCache.set(path, existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined);
      }
      return textCache.get(path);
    },
  };

  const declarationRoot = join(packageRoot, owners.declarationRoot);
  if (!existsSync(declarationRoot)) {
    throw new Error(`${owners.declarationRoot}/ does not exist. Run \`bun run build:lib\` first.`);
  }

  const emitted = [...new Bun.Glob('**/*.d.ts').scanSync({ cwd: declarationRoot, absolute: true })]
    .map((absolute) => {
      const path = toPackagePath(absolute);
      return { path, rawBytes: Buffer.byteLength(host.readFile(path) ?? '', 'utf8') };
    })
    .sort((a, b) => compareText(a.path, b.path));

  const entries: Record<string, string> = {};
  const entryFailures: string[] = [];
  for (const [name, target] of Object.entries(packageJson.exports)) {
    if (typeof target.types !== 'string') {
      entryFailures.push(`package.json exports[${JSON.stringify(name)}] has no types entry.`);
      continue;
    }
    entries[name] = target.types.replace(/^\.\//, '');
  }

  const graph = walkDeclarationGraph(entries, host);
  const attribution = attribute(graph, emitted, owners);
  return { packageJson, owners, entries, emitted, graph, attribution, entryFailures };
}
