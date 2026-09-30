/**
 * Per-owner declaration budget check.
 *
 * Run after `bun run build:lib`:
 *
 *   bun run check:declaration-budgets                 # report, fail on structural problems
 *   bun run check:declaration-budgets --write-baseline
 *   bun run check:declaration-budgets --suggest-budgets
 *   bun run check:declaration-budgets --why dist/factories/ory/index.d.ts
 *   bun run check:declaration-budgets --list-unreachable
 *
 * See scripts/declaration-budgets/README.md.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  type Baseline,
  type BudgetsConfig,
  evaluateBudgets,
  suggestBudget,
  toBaseline,
} from './budgets.js';
import {
  attribute,
  classifyEdges,
  type DeclarationHost,
  importChain,
  type OwnersConfig,
  walkDeclarationGraph,
} from './graph.js';
import { renderReport } from './report.js';

const argv = process.argv.slice(2);
const args = new Set(argv);
const packageRoot = resolve(import.meta.dirname, '..', '..');
const scriptsDir = join(packageRoot, 'scripts');
const ownersPath = join(scriptsDir, 'declaration-owners.json');
const budgetsPath = join(scriptsDir, 'declaration-budgets.json');
const baselinePath = join(scriptsDir, 'declaration-baseline.json');

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const packageJson = readJson<{
  version: string;
  exports: Record<string, { types?: string }>;
}>(join(packageRoot, 'package.json'));
const owners = readJson<OwnersConfig>(ownersPath);
const budgets = readJson<BudgetsConfig>(budgetsPath);
const baseline = existsSync(baselinePath) ? readJson<Baseline>(baselinePath) : undefined;

const toPackagePath = (absolute: string): string =>
  relative(packageRoot, absolute).split(sep).join('/');

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
  console.error(`${owners.declarationRoot}/ does not exist. Run \`bun run build:lib\` first.`);
  process.exit(1);
}

const emitted = [...new Bun.Glob('**/*.d.ts').scanSync({ cwd: declarationRoot, absolute: true })]
  .map((absolute) => ({
    path: toPackagePath(absolute),
    rawBytes: Buffer.byteLength(host.readFile(toPackagePath(absolute)) ?? '', 'utf8'),
  }))
  .sort((a, b) => a.path.localeCompare(b.path));

const entries: Record<string, string> = {};
const failures: string[] = [];
for (const [name, target] of Object.entries(packageJson.exports)) {
  if (typeof target.types !== 'string') {
    failures.push(`package.json exports[${JSON.stringify(name)}] has no types entry.`);
    continue;
  }
  entries[name] = target.types.replace(/^\.\//, '');
}

const graph = walkDeclarationGraph(entries, host);
const attribution = attribute(graph, emitted, owners);
const edges = classifyEdges(attribution.edges, owners.allowedEdges);

const whyIndex = argv.indexOf('--why');
if (whyIndex >= 0) {
  const target = argv[whyIndex + 1] ?? '';
  const chain = importChain(graph, target);
  console.log(chain ? chain.join('\n  -> ') : `${target} is not reachable from any public entry.`);
  process.exit(0);
}

if (args.has('--list-unreachable')) {
  for (const file of attribution.unreachable) console.log(file.path);
  process.exit(0);
}

if (args.has('--write-baseline')) {
  writeJson(baselinePath, toBaseline(attribution, packageJson.version));
  console.log(`Wrote ${toPackagePath(baselinePath)}.`);
}

if (args.has('--suggest-budgets')) {
  const suggested: Record<string, number> = {};
  for (const [owner, usage] of [...attribution.owners.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    suggested[owner] = suggestBudget(usage.rawBytes, budgets.headroom);
  }
  writeJson(budgetsPath, { ...budgets, owners: suggested });
  console.log(`Wrote ${toPackagePath(budgetsPath)} with budgets set from current usage.`);
}

const evaluation = evaluateBudgets(
  attribution,
  args.has('--suggest-budgets') ? readJson<BudgetsConfig>(budgetsPath) : budgets,
  baseline
);

// Structural checks: always fatal, even while budgets are report-only.
const ownerNames = owners.owners.map((rule) => rule.owner);
const duplicateOwners = ownerNames.filter((name, index) => ownerNames.indexOf(name) !== index);
if (duplicateOwners.length > 0) failures.push(`Duplicate owners: ${duplicateOwners.join(', ')}.`);
for (const path of attribution.unowned) {
  failures.push(`Reachable declaration \`${path}\` has no owner in declaration-owners.json.`);
}
for (const missing of graph.missing) {
  failures.push(
    `\`${missing.from}\` imports \`${missing.specifier}\`, which has no emitted declaration.`
  );
}
for (const edge of edges.added) {
  failures.push(
    `New cross-owner declaration edge ${edge.from} -> ${edge.to} (${edge.imports[0]}). ` +
      'Move the shared types into core, or add a reviewed entry to allowedEdges.'
  );
}
for (const violation of attribution.rootEntryViolations) {
  failures.push(
    `The root entry reaches ${violation.owner} declarations (${violation.files[0]}). ` +
      'New integrations must ship as their own subpath export, not through src/factories/index.ts.'
  );
}
failures.push(...evaluation.configErrors);

const mode = args.has('--enforce') ? 'enforce' : budgets.mode;
if (mode === 'enforce') failures.push(...evaluation.overruns);

const report = renderReport({
  attribution,
  evaluation,
  budgets: { ...budgets, mode },
  owners,
  baseline,
  edges,
  emitted: {
    files: emitted.length,
    rawBytes: emitted.reduce((sum, file) => sum + file.rawBytes, 0),
  },
  missing: graph.missing,
  failures,
});

console.log(report);
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) appendFileSync(summaryPath, `${report}\n`);

if (failures.length > 0) {
  console.error(`\nDeclaration budget check failed with ${failures.length} problem(s).`);
  process.exit(1);
}
