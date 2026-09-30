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
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Baseline,
  type BudgetsConfig,
  evaluateBudgets,
  suggestBudget,
  toBaseline,
} from './budgets.js';
import { classifyEdges, compareText, deadOwnerPatterns, importChain } from './graph.js';
import { measurePackage, readJson, scriptsDir, toPackagePath } from './package.js';
import { renderReport } from './report.js';

const argv = process.argv.slice(2);
const args = new Set(argv);
const budgetsPath = join(scriptsDir, 'declaration-budgets.json');
const baselinePath = join(scriptsDir, 'declaration-baseline.json');

const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const budgets = readJson<BudgetsConfig>(budgetsPath);
const baseline = existsSync(baselinePath) ? readJson<Baseline>(baselinePath) : undefined;

let measured: ReturnType<typeof measurePackage>;
try {
  measured = measurePackage();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const { packageJson, owners, emitted, graph, attribution } = measured;
const failures: string[] = [...measured.entryFailures];
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
    compareText(a, b)
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
for (const edge of edges.stale) {
  failures.push(
    `Allowlisted edge ${edge.from} -> ${edge.to} is no longer observed. Remove it from allowedEdges.`
  );
}
for (const dead of deadOwnerPatterns(graph, owners)) {
  failures.push(
    `Owner rule "${dead.pattern}" (${dead.owner}) matches no reachable declaration file. Remove it.`
  );
}
failures.push(...evaluation.configErrors);

const warnings: string[] = [];
if (baseline && baseline.packageVersion !== packageJson.version) {
  warnings.push(
    `The baseline was recorded at typekro ${baseline.packageVersion}, but package.json is ${packageJson.version}. ` +
      'Deltas include every change since then. Refresh it with `bun run check:declaration-budgets --write-baseline` in the release PR.'
  );
}

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
  warnings,
});
for (const warning of warnings) console.warn(`::warning title=Declaration baseline::${warning}`);

console.log(report);
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) appendFileSync(summaryPath, `${report}\n`);

if (failures.length > 0) {
  console.error(`\nDeclaration budget check failed with ${failures.length} problem(s).`);
  process.exit(1);
}
