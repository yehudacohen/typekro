/**
 * Budget evaluation for per-owner declaration usage. Pure functions only.
 */
import { type Attribution, type ByteStats, compareText, type OwnerUsage } from './graph.js';

export interface BudgetsConfig {
  /** `report` never fails on budget overruns; `enforce` does. */
  mode: 'report' | 'enforce';
  /** Cap on the bytes of every reachable declaration file. Owner budgets must sum to at most this. */
  globalCapBytes: number;
  headroom: { minBytes: number; fraction: number };
  /** Flag an owner whose JSDoc bytes drop by more than this fraction versus the baseline. */
  docDropFraction: number;
  /** Per-owner raw-byte budgets. */
  owners: Record<string, number>;
}

export interface BaselineOwner extends ByteStats {
  files: number;
}

export interface Baseline {
  schemaVersion: 1;
  packageVersion: string;
  owners: Record<string, BaselineOwner>;
  reachable: { files: number; rawBytes: number };
  unreachable: { files: number; rawBytes: number };
  edges: string[];
}

export type OwnerStatus = 'ok' | 'over' | 'ratchet' | 'unbudgeted';

export interface OwnerRow {
  owner: string;
  usage: OwnerUsage;
  budget: number | undefined;
  headroom: number | undefined;
  deltaRawBytes: number | undefined;
  deltaDocBytes: number | undefined;
  status: OwnerStatus;
  /** Budget this owner would get if it were set from current usage. */
  suggestedBudget: number;
  docDrop: number | undefined;
}

export interface BudgetEvaluation {
  rows: OwnerRow[];
  reachableRawBytes: number;
  budgetSum: number;
  /** Structural configuration problems; always fatal. */
  configErrors: string[];
  /** Budget overruns; fatal only in `enforce` mode. */
  overruns: string[];
  docDrops: string[];
}

/** Budget for a given usage: usage plus max(minBytes, fraction × usage), rounded up to 256 bytes. */
export function suggestBudget(usage: number, headroom: BudgetsConfig['headroom']): number {
  const withHeadroom = usage + Math.max(headroom.minBytes, Math.ceil(usage * headroom.fraction));
  return Math.ceil(withHeadroom / 256) * 256;
}

export function evaluateBudgets(
  attribution: Attribution,
  budgets: BudgetsConfig,
  baseline: Baseline | undefined
): BudgetEvaluation {
  const configErrors: string[] = [];
  const overruns: string[] = [];
  const docDrops: string[] = [];
  const rows: OwnerRow[] = [];

  const budgetSum = Object.values(budgets.owners).reduce((sum, value) => sum + value, 0);
  if (budgetSum > budgets.globalCapBytes) {
    configErrors.push(
      `Owner budgets sum to ${budgetSum} bytes, above the global cap of ${budgets.globalCapBytes}.`
    );
  }
  for (const owner of Object.keys(budgets.owners)) {
    if (!attribution.owners.has(owner)) {
      configErrors.push(`Budget for "${owner}" has no matching owner in the owners map.`);
    }
  }

  let reachableRawBytes = 0;
  for (const [owner, usage] of attribution.owners) {
    reachableRawBytes += usage.rawBytes;
    const budget = budgets.owners[owner];
    const suggestedBudget = suggestBudget(usage.rawBytes, budgets.headroom);
    const before = baseline?.owners[owner];
    const docDrop =
      before && before.docBytes > 0
        ? (before.docBytes - usage.docBytes) / before.docBytes
        : undefined;

    let status: OwnerStatus;
    if (budget === undefined) {
      status = 'unbudgeted';
      configErrors.push(`Owner "${owner}" has no budget in declaration-budgets.json.`);
    } else if (usage.rawBytes > budget) {
      status = 'over';
      overruns.push(`${owner} uses ${usage.rawBytes} bytes, over its budget of ${budget}.`);
    } else if (
      budget - suggestedBudget >
      Math.max(budgets.headroom.minBytes, suggestedBudget * budgets.headroom.fraction)
    ) {
      // Headroom is more than twice the standard allowance: the budget can come down.
      status = 'ratchet';
    } else {
      status = 'ok';
    }

    if (docDrop !== undefined && docDrop > budgets.docDropFraction) {
      docDrops.push(
        `${owner} JSDoc dropped ${(docDrop * 100).toFixed(1)}% (${before?.docBytes} -> ${usage.docBytes} bytes). Confirm the prose moved to docs/ or source comments.`
      );
    }

    rows.push({
      owner,
      usage,
      budget,
      headroom: budget === undefined ? undefined : budget - usage.rawBytes,
      deltaRawBytes: before ? usage.rawBytes - before.rawBytes : undefined,
      deltaDocBytes: before ? usage.docBytes - before.docBytes : undefined,
      status,
      suggestedBudget,
      docDrop,
    });
  }

  if (reachableRawBytes > budgets.globalCapBytes) {
    overruns.push(
      `Reachable declarations total ${reachableRawBytes} bytes, over the global cap of ${budgets.globalCapBytes}.`
    );
  }

  rows.sort((a, b) => b.usage.rawBytes - a.usage.rawBytes || compareText(a.owner, b.owner));
  return { rows, reachableRawBytes, budgetSum, configErrors, overruns, docDrops };
}

export function toBaseline(attribution: Attribution, packageVersion: string): Baseline {
  const owners: Record<string, BaselineOwner> = {};
  let files = 0;
  let rawBytes = 0;
  for (const [owner, usage] of [...attribution.owners.entries()].sort(([a], [b]) =>
    compareText(a, b)
  )) {
    owners[owner] = {
      files: usage.files,
      rawBytes: usage.rawBytes,
      surfaceBytes: usage.surfaceBytes,
      docBytes: usage.docBytes,
      commentBytes: usage.commentBytes,
    };
    files += usage.files;
    rawBytes += usage.rawBytes;
  }
  return {
    schemaVersion: 1,
    packageVersion,
    owners,
    reachable: { files, rawBytes },
    unreachable: {
      files: attribution.unreachable.length,
      rawBytes: attribution.unreachable.reduce((sum, file) => sum + file.rawBytes, 0),
    },
    edges: attribution.edges.map((edge) => `${edge.from} -> ${edge.to}`),
  };
}
