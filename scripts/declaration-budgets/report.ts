/**
 * Markdown rendering for the declaration budget report (GitHub step summary).
 */
import type { Baseline, BudgetEvaluation, BudgetsConfig, OwnerRow } from './budgets.js';
import type { Attribution, OwnerEdge, OwnersConfig } from './graph.js';

export interface ReportInput {
  attribution: Attribution;
  evaluation: BudgetEvaluation;
  budgets: BudgetsConfig;
  owners: OwnersConfig;
  baseline: Baseline | undefined;
  edges: { allowed: OwnerEdge[]; added: OwnerEdge[]; stale: OwnersConfig['allowedEdges'] };
  emitted: { files: number; rawBytes: number };
  missing: { from: string; specifier: string }[];
  failures: string[];
}

const kb = (bytes: number | undefined): string =>
  bytes === undefined ? '—' : `${(bytes / 1024).toFixed(1)} KiB`;

const signedKb = (bytes: number | undefined): string => {
  if (bytes === undefined) return 'new';
  if (bytes === 0) return '0';
  return `${bytes > 0 ? '+' : '−'}${(Math.abs(bytes) / 1024).toFixed(1)} KiB`;
};

const statusLabel = (row: OwnerRow, mode: BudgetsConfig['mode']): string => {
  switch (row.status) {
    case 'over':
      return mode === 'enforce' ? 'OVER' : 'over (report-only)';
    case 'ratchet':
      return `ratchet to ${kb(row.suggestedBudget)}`;
    case 'unbudgeted':
      return 'no budget';
    default:
      return 'ok';
  }
};

function details(summary: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  return ['', `<details><summary>${summary}</summary>`, '', ...lines, '', '</details>'];
}

export function renderReport(input: ReportInput): string {
  const { attribution, evaluation, budgets, baseline, edges } = input;
  const unreachableBytes = attribution.unreachable.reduce((sum, file) => sum + file.rawBytes, 0);
  const lines: string[] = [];

  lines.push(`## Declaration budgets (${budgets.mode === 'enforce' ? 'enforced' : 'report-only'})`);
  lines.push('');
  lines.push(
    `Emitted: ${input.emitted.files} files, ${kb(input.emitted.rawBytes)}. ` +
      `Reachable from public entries: ${kb(evaluation.reachableRawBytes)}. ` +
      `Unreachable: ${attribution.unreachable.length} files, ${kb(unreachableBytes)}.`
  );
  lines.push(
    `Global cap ${budgets.globalCapBytes} bytes; owner budgets sum to ${evaluation.budgetSum} bytes. ` +
      (baseline
        ? `Deltas are against the committed baseline (typekro ${baseline.packageVersion}).`
        : 'No baseline found; deltas are unavailable.')
  );

  if (input.failures.length > 0) {
    lines.push('', '### Failures', '', ...input.failures.map((failure) => `- ${failure}`));
  }

  lines.push('', '### Owners', '');
  lines.push(
    '| Owner | Files | Raw | Surface | Doc | Δ raw | Δ doc | Budget | Headroom | Status |'
  );
  lines.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|---|');
  for (const row of evaluation.rows) {
    lines.push(
      `| ${row.owner} | ${row.usage.files} | ${kb(row.usage.rawBytes)} | ${kb(row.usage.surfaceBytes)} | ` +
        `${kb(row.usage.docBytes)} | ${signedKb(row.deltaRawBytes)} | ${signedKb(row.deltaDocBytes)} | ` +
        `${kb(row.budget)} | ${kb(row.headroom)} | ${statusLabel(row, budgets.mode)} |`
    );
  }

  if (evaluation.overruns.length > 0) {
    lines.push('', `**Budget overruns${budgets.mode === 'report' ? ' (report-only)' : ''}:**`);
    lines.push(...evaluation.overruns.map((overrun) => `- ${overrun}`));
  }
  const ratchets = evaluation.rows.filter((row) => row.status === 'ratchet');
  if (ratchets.length > 0) {
    lines.push('', '**Ratchet candidates** (usage is well below budget; lower the budget):');
    lines.push(
      ...ratchets.map((row) => `- ${row.owner}: ${row.budget} -> ${row.suggestedBudget} bytes`)
    );
  }
  if (evaluation.docDrops.length > 0) {
    lines.push('', '**Doc-byte drops over threshold:**');
    lines.push(...evaluation.docDrops.map((drop) => `- ${drop}`));
  }

  lines.push('', '### Cross-owner edges', '');
  const baselineEdges = new Set(baseline?.edges ?? []);
  const currentEdges = new Set(attribution.edges.map((edge) => `${edge.from} -> ${edge.to}`));
  if (attribution.edges.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| From | To | Imports | Status |', '|---|---|--:|---|');
    for (const edge of attribution.edges) {
      const isNew = edges.added.includes(edge);
      const changed =
        baseline && !baselineEdges.has(`${edge.from} -> ${edge.to}`) ? ' (new since baseline)' : '';
      lines.push(
        `| ${edge.from} | ${edge.to} | ${edge.imports.length} | ${isNew ? 'NOT ALLOWLISTED' : 'allowlisted'}${changed} |`
      );
    }
  }
  const removed = [...baselineEdges].filter((edge) => !currentEdges.has(edge));
  if (removed.length > 0) lines.push('', `Removed since baseline: ${removed.join(', ')}.`);
  if (edges.stale.length > 0) {
    lines.push(
      '',
      `Stale allowlist entries (no longer observed; remove them): ${edges.stale
        .map((edge) => `${edge.from} -> ${edge.to}`)
        .join(', ')}.`
    );
  }
  lines.push(
    ...details(
      'Edge imports',
      attribution.edges.flatMap((edge) => edge.imports.map((line) => `- \`${line}\``))
    )
  );

  const barrelByOwner = new Map<string, number>();
  for (const entry of attribution.barrelImports) {
    barrelByOwner.set(entry.owner, (barrelByOwner.get(entry.owner) ?? 0) + 1);
  }
  lines.push('', '### Root barrel imports (report-only)', '');
  if (attribution.barrelImports.length === 0) {
    lines.push('None.');
  } else {
    lines.push(
      `${attribution.barrelImports.length} files import a root barrel, so their entry reaches everything the root reaches: ` +
        [...barrelByOwner.entries()]
          .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
          .map(([owner, count]) => `${owner} ${count}`)
          .join(', ') +
        '. Usually an inferred return type; annotate it with a type imported from core.'
    );
    lines.push(
      ...details(
        'Files',
        attribution.barrelImports.map((entry) => `- \`${entry.file}\` -> \`${entry.barrel}\``)
      )
    );
  }

  const internalByOwner = new Map<string, number>();
  for (const symbol of attribution.internal) {
    internalByOwner.set(symbol.owner, (internalByOwner.get(symbol.owner) ?? 0) + 1);
  }
  lines.push('', '### `@internal` declarations in reachable files (report-only)', '');
  if (attribution.internal.length === 0) {
    lines.push('None.');
  } else {
    lines.push(
      `${attribution.internal.length} declarations: ` +
        [...internalByOwner.entries()]
          .sort(([, a], [, b]) => b - a)
          .map(([owner, count]) => `${owner} ${count}`)
          .join(', ') +
        '.'
    );
    lines.push(
      ...details(
        'Declarations',
        attribution.internal.map((symbol) => `- \`${symbol.file}:${symbol.line}\` ${symbol.name}`)
      )
    );
  }

  lines.push('', '### Unreachable declaration files', '');
  lines.push(
    `${attribution.unreachable.length} files, ${kb(unreachableBytes)}. They ship in the package but no public entry reaches them.`
  );
  lines.push(
    ...details(
      'Files',
      attribution.unreachable.map(
        (file) => `- \`${file.path}\` ${kb(file.rawBytes)} (${file.owner ?? 'unowned'})`
      )
    )
  );

  lines.push(
    ...details('Per-entry reachable declarations', [
      '| Export | Files | Raw | Owners |',
      '|---|--:|--:|---|',
      ...attribution.entries.map(
        (entry) =>
          `| \`${entry.export}\` | ${entry.files} | ${kb(entry.rawBytes)} | ${entry.owners.join(', ')} |`
      ),
    ])
  );

  lines.push('');
  return lines.join('\n');
}
