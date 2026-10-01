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
const TYPESCRIPT_SOURCE = /\.[mc]?tsx?$/;
const RUNTIME = /\.([mc]?)js$/;

/**
 * Collects every declaration target one export value can resolve to.
 *
 * TypeScript picks the first condition key, in object order, that is in its
 * active set (`types`, `import` or `require`, `node`, `default`, plus any
 * `customConditions` the consumer configures), and takes the first usable entry
 * of a fallback array. Which branch wins therefore depends on the consumer's
 * resolution mode and settings, which this package cannot know. So this
 * returns the union over every condition branch and every fallback entry.
 * That is a superset of what any single resolver mode loads: the budget tool
 * never under-counts, and the prune step never deletes a declaration some
 * consumer could load. The cost is occasionally keeping a file only a
 * shadowed branch names.
 *
 * A JavaScript target contributes the declaration TypeScript loads next to it
 * (`x.js` -> `x.d.ts`, `x.mjs` -> `x.d.mts`, `x.cjs` -> `x.d.cts`).
 * Targets may contain `*`; those are patterns expanded by the caller.
 */
export function declarationTargets(value: unknown): string[] {
  return [...collectTargets(value).keys()];
}

/** Target path to whether it was inferred from a JavaScript target. */
function collectTargets(value: unknown): Map<string, boolean> {
  const targets = new Map<string, boolean>();
  const add = (target: string, inferred: boolean) => {
    const path = posix.normalize(target.replace(/^\.\//, ''));
    targets.set(path, inferred && (targets.get(path) ?? true));
  };
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      if (DECLARATION.test(node) || TYPESCRIPT_SOURCE.test(node)) add(node, false);
      else if (RUNTIME.test(node)) add(node.replace(RUNTIME, '.d.$1ts'), true);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const child of Object.values(node as Record<string, unknown>)) visit(child);
  };
  visit(value);
  return targets;
}

const isSubpathMap = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => key.startsWith('.'));

/** Node's PATTERN_KEY_COMPARE: negative when `a` is the more specific key. */
export function patternKeyCompare(a: string, b: string): number {
  const aPatternIndex = a.indexOf('*');
  const bPatternIndex = b.indexOf('*');
  const baseLengthA = aPatternIndex === -1 ? a.length : aPatternIndex + 1;
  const baseLengthB = bPatternIndex === -1 ? b.length : bPatternIndex + 1;
  if (baseLengthA > baseLengthB) return -1;
  if (baseLengthB > baseLengthA) return 1;
  if (aPatternIndex === -1) return 1;
  if (bPatternIndex === -1) return -1;
  if (a.length > b.length) return -1;
  if (b.length > a.length) return 1;
  return 0;
}

/**
 * The exports key Node uses for `subpath`, following PACKAGE_EXPORTS_RESOLVE:
 * an exact key wins; otherwise the most specific single-`*` pattern that
 * matches with a non-empty capture. The key's value may be `null` (blocked).
 */
export function matchExportKey(
  subpath: string,
  keys: readonly string[]
): { key: string; capture: string | undefined } | undefined {
  if (keys.includes(subpath) && !subpath.includes('*')) return { key: subpath, capture: undefined };
  let best: { key: string; capture: string } | undefined;
  for (const key of keys) {
    const patternIndex = key.indexOf('*');
    if (patternIndex === -1 || key.lastIndexOf('*') !== patternIndex) continue;
    const prefix = key.slice(0, patternIndex);
    const trailer = key.slice(patternIndex + 1);
    if (
      subpath.startsWith(prefix) &&
      subpath.length >= key.length &&
      subpath.endsWith(trailer) &&
      (best === undefined || patternKeyCompare(best.key, key) === 1)
    ) {
      best = { key, capture: subpath.slice(patternIndex, subpath.length - trailer.length) };
    }
  }
  return best;
}

/** Matches a target containing `*` (every `*` is the same capture). */
const targetPattern = (target: string): RegExp => {
  const parts = target.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(
    `^${parts[0]}${parts
      .slice(1)
      .map((part, index) => `${index === 0 ? '(.+)' : '\\1'}${part}`)
      .join('')}$`
  );
};

/**
 * Resolves `package.json` exports to the declaration files each public
 * subpath exposes. Exact keys, `*` patterns and `null` exclusions interact as
 * in Node's exports algorithm: an exact key beats any pattern, and the most
 * specific pattern wins (see {@link patternKeyCompare}), including against a
 * `null` pattern. Pattern keys are expanded against the emitted files.
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
  const keys = Object.keys(subpaths);

  for (const [subpath, value] of Object.entries(subpaths)) {
    if (value === null) continue;
    const collected = collectTargets(value);
    const targets = [...collected.keys()];
    if (targets.length === 0) {
      failures.push(`package.json exports[${JSON.stringify(subpath)}] has no types target.`);
      continue;
    }

    if (!subpath.includes('*')) {
      const present = targets.filter((target) => exists(target));
      // A declaration inferred next to a JavaScript target may legitimately not exist
      // (no resolver can load it then). A named declaration must exist, and so must
      // at least one declaration for the subpath.
      const missing = targets.filter((target) => !exists(target) && !collected.get(target));
      if (missing.length > 0 || present.length === 0) {
        failures.push(
          `package.json exports[${JSON.stringify(subpath)}] points at missing declarations: ${(missing.length > 0 ? missing : targets).join(', ')}.`
        );
      }
      entries[subpath] = present;
      continue;
    }

    // Pattern: each emitted declaration matching a target maps back to a concrete
    // subpath. It is public under this key only if Node would pick this key for it.
    const expanded = new Map<string, Set<string>>();
    for (const target of targets) {
      const pattern = targetPattern(target);
      for (const path of emitted) {
        const capture = pattern.exec(path)?.[1];
        if (capture === undefined) continue;
        const concrete = subpath.replace('*', capture);
        if (matchExportKey(concrete, keys)?.key !== subpath) continue;
        expanded.set(concrete, (expanded.get(concrete) ?? new Set()).add(path));
      }
    }
    if (expanded.size === 0) {
      failures.push(
        `package.json exports[${JSON.stringify(subpath)}] matches no emitted declarations.`
      );
    }
    for (const [concrete, paths] of expanded) entries[concrete] = [...paths].sort(compareText);
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
