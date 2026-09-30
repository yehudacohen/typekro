/**
 * Declaration graph walker and attribution for per-owner declaration budgets.
 *
 * Everything in this module is pure: file access goes through a
 * {@link DeclarationHost}, so tests can run it against small in-memory trees.
 */
import { posix } from 'node:path';
import ts from 'typescript';

/** Read-only view of an emitted declaration tree. Paths are POSIX, relative to the package root. */
export interface DeclarationHost {
  readFile(path: string): string | undefined;
}

export interface ByteStats {
  /** Bytes on disk (UTF-8). */
  rawBytes: number;
  /** Raw bytes minus every comment. */
  surfaceBytes: number;
  /** Bytes inside `/** ... *\/` comments. */
  docBytes: number;
  /** Bytes inside any comment (JSDoc, block, or line). */
  commentBytes: number;
}

export interface InternalSymbol {
  file: string;
  name: string;
  line: number;
}

export interface DeclarationFile {
  path: string;
  stats: ByteStats;
  /** Resolved relative imports, re-exports, `import()` types, and `/// <reference path>` targets. */
  imports: string[];
  /** Declarations in this file that carry an `@internal` JSDoc tag. */
  internal: InternalSymbol[];
}

export interface MissingImport {
  from: string;
  specifier: string;
}

export interface DeclarationGraph {
  /** Every file reachable from at least one entry, keyed by path. */
  files: Map<string, DeclarationFile>;
  /** Declaration path of each public entry. */
  roots: Map<string, string>;
  /** Reachable file set for each public entry. */
  entries: Map<string, Set<string>>;
  /** Relative specifiers that did not resolve to an emitted declaration file. */
  missing: MissingImport[];
}

/** Code-point order, so output is identical on every machine and locale. */
export const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Splits a declaration file into surface, JSDoc, and other comment bytes.
 *
 * Uses the TypeScript scanner so string literals and template literal types
 * that contain `//` or `/*` are never mistaken for comments.
 */
export function analyzeComments(text: string): ByteStats {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text
  );
  const templateBraceDepths: number[] = [];
  let braceDepth = 0;
  let docBytes = 0;
  let commentBytes = 0;

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const comment = scanner.getTokenText();
      const bytes = utf8Bytes(comment);
      commentBytes += bytes;
      if (comment.startsWith('/**') && comment !== '/**/') docBytes += bytes;
    } else if (token === ts.SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (token === ts.SyntaxKind.TemplateHead) {
      templateBraceDepths.push(braceDepth);
    } else if (token === ts.SyntaxKind.CloseBraceToken) {
      if (templateBraceDepths.at(-1) === braceDepth) {
        if (scanner.reScanTemplateToken(false) === ts.SyntaxKind.TemplateTail) {
          templateBraceDepths.pop();
        }
      } else {
        braceDepth -= 1;
      }
    }
  }

  const rawBytes = utf8Bytes(text);
  return { rawBytes, surfaceBytes: rawBytes - commentBytes, docBytes, commentBytes };
}

function declarationName(node: ts.Node, sourceFile: ts.SourceFile): string {
  const named = node as { name?: ts.Node };
  if (named.name) return named.name.getText(sourceFile);
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.map((d) => d.name.getText(sourceFile)).join(', ');
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  return ts.SyntaxKind[node.kind];
}

function isInternalTagged(node: ts.Node): boolean {
  const jsDoc = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  return jsDoc?.some((doc) => doc.tags?.some((tag) => tag.tagName.text === 'internal')) ?? false;
}

/** Parses one declaration file and returns its module specifiers and `@internal` declarations. */
export function parseDeclaration(
  path: string,
  text: string
): { specifiers: string[]; internal: InternalSymbol[] } {
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const specifiers: string[] = sourceFile.referencedFiles.map((ref) =>
    ref.fileName.startsWith('.') ? ref.fileName : `./${ref.fileName}`
  );
  const internal: InternalSymbol[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      specifiers.push(node.name.text);
    }

    if (isInternalTagged(node)) {
      internal.push({
        file: path,
        name: declarationName(node, sourceFile),
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { specifiers, internal };
}

export type Resolution =
  | { kind: 'external' }
  | { kind: 'resolved'; path: string }
  | { kind: 'missing' };

/** Resolves a specifier found in `fromFile` to an emitted declaration file. */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  host: DeclarationHost
): Resolution {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return { kind: 'external' };
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const candidates: string[] = [];
  if (/\.d\.[mc]?ts$/.test(base)) candidates.push(base);
  else if (/\.[mc]?js$/.test(base)) candidates.push(base.replace(/\.([mc]?)js$/, '.d.$1ts'));
  else if (/\.[mc]?ts$/.test(base)) candidates.push(base.replace(/\.([mc]?)ts$/, '.d.$1ts'));
  else candidates.push(`${base}.d.ts`, `${base}/index.d.ts`);

  for (const candidate of candidates) {
    if (host.readFile(candidate) !== undefined) return { kind: 'resolved', path: candidate };
  }
  return { kind: 'missing' };
}

/**
 * Walks the declaration import graph from every public entry.
 *
 * @param entries - map of export name (for example `"."` or `"./traefik"`) to its
 *   declaration path relative to the package root (for example `"dist/index.d.ts"`).
 */
export function walkDeclarationGraph(
  entries: Record<string, string>,
  host: DeclarationHost
): DeclarationGraph {
  const files = new Map<string, DeclarationFile>();
  const missing: MissingImport[] = [];

  const load = (path: string): DeclarationFile | undefined => {
    const cached = files.get(path);
    if (cached) return cached;
    const text = host.readFile(path);
    if (text === undefined) return undefined;
    const { specifiers, internal } = parseDeclaration(path, text);
    const imports = new Set<string>();
    for (const specifier of specifiers) {
      const resolution = resolveSpecifier(path, specifier, host);
      if (resolution.kind === 'resolved') imports.add(resolution.path);
      else if (resolution.kind === 'missing') missing.push({ from: path, specifier });
    }
    const file: DeclarationFile = {
      path,
      stats: analyzeComments(text),
      imports: [...imports].sort(),
      internal,
    };
    files.set(path, file);
    return file;
  };

  const entrySets = new Map<string, Set<string>>();
  const roots = new Map<string, string>();
  for (const [entryName, entryPath] of Object.entries(entries)) {
    const seen = new Set<string>();
    const root = posix.normalize(entryPath);
    roots.set(entryName, root);
    const queue = [root];
    while (queue.length > 0) {
      const path = queue.pop() as string;
      if (seen.has(path)) continue;
      const file = load(path);
      if (!file) {
        missing.push({ from: `exports[${JSON.stringify(entryName)}]`, specifier: path });
        continue;
      }
      seen.add(path);
      queue.push(...file.imports);
    }
    entrySets.set(entryName, seen);
  }

  return { files, roots, entries: entrySets, missing };
}

/** Shortest import chain from a public entry to `target`, for explaining why a file is reachable. */
export function importChain(graph: DeclarationGraph, target: string): string[] | undefined {
  const previous = new Map<string, string | null>();
  const queue: string[] = [];
  for (const root of new Set(graph.roots.values())) {
    if (!graph.files.has(root)) continue;
    previous.set(root, null);
    queue.push(root);
  }
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (path === target) {
      const chain: string[] = [];
      for (let step: string | null | undefined = path; step; step = previous.get(step)) {
        chain.unshift(step);
      }
      return chain;
    }
    for (const next of graph.files.get(path)?.imports ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, path);
      queue.push(next);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

export interface OwnerRule {
  owner: string;
  /** Why these paths belong to this owner. Not used by the tool. */
  $comment?: string;
  /** Glob patterns relative to the declaration root (`**` spans directories). */
  paths: string[];
}

export interface OwnersConfig {
  /** Directory the owner globs are relative to, for example `"dist"`. */
  declarationRoot: string;
  /** Owner that shared types are charged to. Edges into it are never reported. */
  coreOwner: string;
  /** Ordered rules; the first matching rule wins. */
  owners: OwnerRule[];
  /** Root barrel files (relative to the declaration root); their re-export edges are governed by `rootEntry`. */
  rootBarrels: string[];
  rootEntry: {
    /** Export name of the root entry, normally `"."`. */
    export: string;
    /** Owners whose declarations the root entry may reach. */
    allowedOwners: string[];
  };
  /** Reviewed cross-owner declaration edges. */
  allowedEdges: { from: string; to: string; reason?: string }[];
}

function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

export type OwnerMatcher = (packagePath: string) => string | undefined;

/** Builds a first-match-wins owner lookup for package-root-relative declaration paths. */
export function createOwnerMatcher(
  config: Pick<OwnersConfig, 'declarationRoot' | 'owners'>
): OwnerMatcher {
  const prefix = `${posix.normalize(config.declarationRoot).replace(/\/$/, '')}/`;
  const rules = config.owners.map((rule) => ({
    owner: rule.owner,
    patterns: rule.paths.map(globToRegExp),
  }));
  return (packagePath) => {
    if (!packagePath.startsWith(prefix)) return undefined;
    const relative = packagePath.slice(prefix.length);
    return rules.find((rule) => rule.patterns.some((pattern) => pattern.test(relative)))?.owner;
  };
}

export interface OwnerUsage extends ByteStats {
  files: number;
  internalSymbols: number;
}

export interface OwnerEdge {
  from: string;
  to: string;
  /** Example file-level imports (`from-file -> to-file`), sorted. */
  imports: string[];
}

export interface EntryUsage {
  export: string;
  files: number;
  rawBytes: number;
  owners: string[];
}

export interface Attribution {
  owners: Map<string, OwnerUsage>;
  /** Reachable files that match no owner rule. */
  unowned: string[];
  /** Emitted declaration files that no public entry reaches. */
  unreachable: { path: string; rawBytes: number; owner: string | undefined }[];
  edges: OwnerEdge[];
  entries: EntryUsage[];
  internal: (InternalSymbol & { owner: string })[];
  /** Owners reachable from the root entry that it is not allowed to reach. */
  rootEntryViolations: { owner: string; files: string[] }[];
  /**
   * Non-barrel files that import a root barrel. Declaration emit writes
   * `import("../../index.js")` for inferred types, which makes the importing
   * entry reach every declaration the root barrel reaches.
   */
  barrelImports: { owner: string; file: string; barrel: string }[];
}

const emptyUsage = (): OwnerUsage => ({
  files: 0,
  rawBytes: 0,
  surfaceBytes: 0,
  docBytes: 0,
  commentBytes: 0,
  internalSymbols: 0,
});

/**
 * Charges every reachable declaration file to exactly one owner and derives
 * cross-owner edges, unreachable files, and root-entry violations.
 *
 * @param emitted - every emitted declaration file with its size, reachable or not.
 */
export function attribute(
  graph: DeclarationGraph,
  emitted: { path: string; rawBytes: number }[],
  config: OwnersConfig
): Attribution {
  const ownerOf = createOwnerMatcher(config);
  const owners = new Map<string, OwnerUsage>(
    config.owners.map((rule) => [rule.owner, emptyUsage()])
  );
  const unowned: string[] = [];
  const internal: Attribution['internal'] = [];
  const rootPrefix = `${posix.normalize(config.declarationRoot).replace(/\/$/, '')}/`;
  const barrels = new Set(config.rootBarrels.map((barrel) => `${rootPrefix}${barrel}`));
  const edgeImports = new Map<string, OwnerEdge>();
  const barrelImports: Attribution['barrelImports'] = [];

  for (const file of [...graph.files.values()].sort((a, b) => compareText(a.path, b.path))) {
    const owner = ownerOf(file.path);
    if (owner === undefined) {
      unowned.push(file.path);
      continue;
    }
    const usage = owners.get(owner) ?? emptyUsage();
    usage.files += 1;
    usage.rawBytes += file.stats.rawBytes;
    usage.surfaceBytes += file.stats.surfaceBytes;
    usage.docBytes += file.stats.docBytes;
    usage.commentBytes += file.stats.commentBytes;
    usage.internalSymbols += file.internal.length;
    owners.set(owner, usage);
    internal.push(...file.internal.map((symbol) => ({ ...symbol, owner })));

    if (barrels.has(file.path)) continue;
    for (const target of file.imports) {
      if (barrels.has(target)) barrelImports.push({ owner, file: file.path, barrel: target });
      const targetOwner = ownerOf(target);
      if (targetOwner === undefined || targetOwner === owner || targetOwner === config.coreOwner) {
        continue;
      }
      const key = `${owner}\u0000${targetOwner}`;
      const edge = edgeImports.get(key) ?? { from: owner, to: targetOwner, imports: [] };
      edge.imports.push(`${file.path} -> ${target}`);
      edgeImports.set(key, edge);
    }
  }

  const reachable = new Set(graph.files.keys());
  const unreachable = emitted
    .filter((file) => !reachable.has(file.path))
    .map((file) => ({ ...file, owner: ownerOf(file.path) }))
    .sort((a, b) => b.rawBytes - a.rawBytes || compareText(a.path, b.path));

  const entries: EntryUsage[] = [...graph.entries.entries()]
    .map(([name, set]) => {
      let rawBytes = 0;
      const entryOwners = new Set<string>();
      for (const path of set) {
        rawBytes += graph.files.get(path)?.stats.rawBytes ?? 0;
        entryOwners.add(ownerOf(path) ?? '(unowned)');
      }
      return { export: name, files: set.size, rawBytes, owners: [...entryOwners].sort() };
    })
    .sort((a, b) => compareText(a.export, b.export));

  const rootEntryViolations: Attribution['rootEntryViolations'] = [];
  const rootSet = graph.entries.get(config.rootEntry.export);
  if (rootSet) {
    const allowed = new Set(config.rootEntry.allowedOwners);
    const byOwner = new Map<string, string[]>();
    for (const path of rootSet) {
      const owner = ownerOf(path) ?? '(unowned)';
      if (allowed.has(owner)) continue;
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), path]);
    }
    for (const [owner, files] of [...byOwner.entries()].sort(([a], [b]) => compareText(a, b))) {
      rootEntryViolations.push({ owner, files: files.sort() });
    }
  }

  const edges = [...edgeImports.values()]
    .map((edge) => ({ ...edge, imports: edge.imports.sort() }))
    .sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to));

  return {
    owners,
    unowned,
    unreachable,
    edges,
    entries,
    internal,
    rootEntryViolations,
    barrelImports,
  };
}

/**
 * Owner globs that match no reachable declaration file. The owners map should
 * stay minimal, so a rule left behind by a refactor is reported.
 */
export function deadOwnerPatterns(
  graph: DeclarationGraph,
  config: Pick<OwnersConfig, 'declarationRoot' | 'owners'>
): { owner: string; pattern: string }[] {
  const reachable = [...graph.files.keys()];
  const dead: { owner: string; pattern: string }[] = [];
  for (const rule of config.owners) {
    for (const pattern of rule.paths) {
      const matches = createOwnerMatcher({
        declarationRoot: config.declarationRoot,
        owners: [{ owner: rule.owner, paths: [pattern] }],
      });
      if (!reachable.some((path) => matches(path) !== undefined)) {
        dead.push({ owner: rule.owner, pattern });
      }
    }
  }
  return dead;
}

/** Splits observed edges into allowed, new (not allowlisted), and stale allowlist entries. */
export function classifyEdges(
  edges: OwnerEdge[],
  allowedEdges: OwnersConfig['allowedEdges']
): { allowed: OwnerEdge[]; added: OwnerEdge[]; stale: OwnersConfig['allowedEdges'] } {
  const allowKeys = new Set(allowedEdges.map((edge) => `${edge.from}\u0000${edge.to}`));
  const seenKeys = new Set(edges.map((edge) => `${edge.from}\u0000${edge.to}`));
  return {
    allowed: edges.filter((edge) => allowKeys.has(`${edge.from}\u0000${edge.to}`)),
    added: edges.filter((edge) => !allowKeys.has(`${edge.from}\u0000${edge.to}`)),
    stale: allowedEdges.filter((edge) => !seenKeys.has(`${edge.from}\u0000${edge.to}`)),
  };
}
