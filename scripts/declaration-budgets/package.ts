/**
 * Loads a built package from disk and measures its declaration graph.
 * Shared by the budget check, the prune step, and the public API snapshot.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
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

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export interface PackageJson {
  version: string;
  types?: string;
  exports?: unknown;
}

export interface MeasuredPackage {
  packageJson: PackageJson;
  owners: OwnersConfig;
  /** Export name to its declaration paths, relative to the package root. */
  entries: Record<string, string[]>;
  /** Every emitted declaration file, reachable or not. */
  emitted: { path: string; rawBytes: number }[];
  graph: DeclarationGraph;
  attribution: Attribution;
  /** Exports whose declarations could not be determined. Any entry here means the graph is incomplete. */
  entryFailures: string[];
}

const DECLARATION = /\.d\.[mc]?ts$/;
const RUNTIME = /\.([mc]?)js$/;

/**
 * Collects the declaration targets of one export value, following the whole
 * condition tree: strings, fallback arrays, and nested condition objects
 * (`types`, `import`, `require`, `default`, `node`, ...). A condition object
 * without a `types` key contributes the declaration TypeScript infers next to
 * its JavaScript targets (`x.js` -> `x.d.ts`).
 */
export function declarationTargets(value: unknown): string[] {
  const targets = new Set<string>();
  const visit = (node: unknown, underTypes: boolean): void => {
    if (typeof node === 'string') {
      if (DECLARATION.test(node) || underTypes) targets.add(node);
      else if (RUNTIME.test(node)) targets.add(node.replace(RUNTIME, '.d.$1ts'));
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, underTypes);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const conditions = node as Record<string, unknown>;
    if ('types' in conditions) {
      visit(conditions.types, true);
      // Sibling branches can still carry their own `types` (for example `require.types`).
      for (const [key, child] of Object.entries(conditions)) {
        if (key !== 'types' && child !== null && typeof child === 'object')
          visit(child, underTypes);
      }
      return;
    }
    for (const child of Object.values(conditions)) visit(child, underTypes);
  };
  visit(value, false);
  return [...targets].map((target) => posix.normalize(target.replace(/^\.\//, '')));
}

const isSubpathMap = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => key.startsWith('.'));

const patternRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('(.+)')}$`
  );

/**
 * Resolves `package.json` exports to the declaration files each public
 * subpath exposes. Wildcard subpaths (`"./x/*"`) are expanded against the
 * emitted files, and `null` subpaths exclude what they match.
 */
export function resolveExportEntries(
  packageJson: Pick<PackageJson, 'exports' | 'types'>,
  emitted: readonly string[],
  exists: (path: string) => boolean
): { entries: Record<string, string[]>; failures: string[] } {
  const entries: Record<string, string[]> = {};
  const failures: string[] = [];
  const exportsField = packageJson.exports;

  if (exportsField === undefined) {
    if (typeof packageJson.types === 'string') entries['.'] = declarationTargets(packageJson.types);
    else failures.push('package.json has neither exports nor types.');
    return { entries, failures };
  }

  const subpaths: Record<string, unknown> = isSubpathMap(exportsField)
    ? exportsField
    : { '.': exportsField };
  const blocked = Object.entries(subpaths)
    .filter(([, value]) => value === null)
    .map(([key]) => patternRegExp(key));
  const isBlocked = (subpath: string) => blocked.some((pattern) => pattern.test(subpath));

  for (const [subpath, value] of Object.entries(subpaths)) {
    if (value === null) continue;
    const targets = declarationTargets(value);
    if (targets.length === 0) {
      failures.push(`package.json exports[${JSON.stringify(subpath)}] has no types target.`);
      continue;
    }

    if (!subpath.includes('*')) {
      if (isBlocked(subpath)) continue;
      const missing = targets.filter((target) => !exists(target));
      if (missing.length > 0) {
        failures.push(
          `package.json exports[${JSON.stringify(subpath)}] points at missing declarations: ${missing.join(', ')}.`
        );
      }
      entries[subpath] = targets;
      continue;
    }

    // Wildcard: every emitted declaration that matches a target pattern is public,
    // under the subpath its capture maps back to.
    const expanded = new Map<string, string[]>();
    for (const target of targets) {
      const pattern = patternRegExp(target);
      for (const path of emitted) {
        const capture = pattern.exec(path)?.[1];
        if (capture === undefined) continue;
        const concrete = subpath.replace('*', capture);
        if (isBlocked(concrete)) continue;
        expanded.set(concrete, [...(expanded.get(concrete) ?? []), path]);
      }
    }
    if (expanded.size === 0) {
      failures.push(
        `package.json exports[${JSON.stringify(subpath)}] matches no emitted declarations.`
      );
    }
    for (const [concrete, paths] of expanded) entries[concrete] = paths.sort(compareText);
  }
  return { entries, failures };
}

export const toPackagePath = (root: string, absolute: string): string =>
  relative(root, absolute).split(sep).join('/');

/** Measures the built package rooted at `root` (default: this repository). */
export function measurePackage(root: string = packageRoot): MeasuredPackage {
  const packageJson = readJson<PackageJson>(join(root, 'package.json'));
  const owners = readJson<OwnersConfig>(join(root, 'scripts', 'declaration-owners.json'));

  const textCache = new Map<string, string | undefined>();
  const host: DeclarationHost = {
    readFile(path) {
      if (!textCache.has(path)) {
        const absolute = join(root, path);
        textCache.set(path, existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined);
      }
      return textCache.get(path);
    },
  };

  const declarationRoot = join(root, owners.declarationRoot);
  if (!existsSync(declarationRoot)) {
    throw new Error(`${owners.declarationRoot}/ does not exist. Run \`bun run build:lib\` first.`);
  }

  const emitted = [
    ...new Bun.Glob('**/*.d.{ts,mts,cts}').scanSync({ cwd: declarationRoot, absolute: true }),
  ]
    .map((absolute) => {
      const path = toPackagePath(root, absolute);
      return { path, rawBytes: Buffer.byteLength(host.readFile(path) ?? '', 'utf8') };
    })
    .sort((a, b) => compareText(a.path, b.path));

  const { entries, failures: entryFailures } = resolveExportEntries(
    packageJson,
    emitted.map((file) => file.path),
    (path) => host.readFile(path) !== undefined
  );

  const graph = walkDeclarationGraph(entries, host);
  const attribution = attribute(graph, emitted, owners);
  return { packageJson, owners, entries, emitted, graph, attribution, entryFailures };
}
