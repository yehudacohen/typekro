/**
 * Budget evaluation for per-owner declaration usage. Pure functions only.
 */
import { type Attribution, type ByteStats, compareText, type OwnerUsage } from './graph.js';

export interface BudgetsConfig {
  /** `report` never fails on budget overruns; `enforce` does. */
  mode: 'report' | 'enforce';
  /**
   * Cap on the bytes of every reachable declaration file. Owner budgets plus the shared pool
   * must sum to at most this.
   */
  globalCapBytes: number;
  headroom: { minBytes: number; fraction: number };
  /** Bytes shared by the owners listed in `pooledOwners`. */
  sharedPoolBytes: number;
  /**
   * New integrations that draw from the shared pool instead of having their own budget. An
   * owner must appear in exactly one of `owners` and `pooledOwners`. Give a pooled owner its
   * own budget once it stabilises.
   */
  pooledOwners: string[];
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

/**
 * `pool`: the owner is listed in `pooledOwners` and draws from the shared pool.
 * `unbudgeted`: the owner has neither a budget nor a pool entry (a config error).
 */
export type OwnerStatus = 'ok' | 'over' | 'ratchet' | 'pool' | 'unbudgeted';

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

export interface SharedPoolUsage {
  bytes: number;
  usedBytes: number;
  /** Pooled owners with bytes, largest first. */
  owners: string[];
}

export interface BudgetEvaluation {
  rows: OwnerRow[];
  reachableRawBytes: number;
  budgetSum: number;
  pool: SharedPoolUsage;
  /** Owner budgets plus the shared pool. */
  committedBytes: number;
  /** Emitted declaration files no public entry reaches. They still ship and count toward the cap. */
  unreachableRawBytes: number;
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

/**
 * Budgets reset from current usage, for `--suggest-budgets`. Only owners that already have a
 * budget are included: owners without one stay in the shared pool.
 */
export function suggestOwnerBudgets(
  attribution: Attribution,
  budgets: BudgetsConfig
): Record<string, number> {
  const suggested: Record<string, number> = {};
  for (const [owner, usage] of [...attribution.owners.entries()].sort(([a], [b]) =>
    compareText(a, b)
  )) {
    if (budgets.owners[owner] === undefined) continue;
    suggested[owner] = suggestBudget(usage.rawBytes, budgets.headroom);
  }
  return suggested;
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
  // A missing, fractional or negative pool would make the totals below NaN or let owner
  // budgets exceed the cap unnoticed. Reject it and evaluate as if the pool were empty.
  const poolIsValid = Number.isSafeInteger(budgets.sharedPoolBytes) && budgets.sharedPoolBytes >= 0;
  if (!poolIsValid) {
    configErrors.push(
      `sharedPoolBytes must be a whole number of bytes, 0 or more; got ${JSON.stringify(budgets.sharedPoolBytes)}.`
    );
  }
  const poolBytes = poolIsValid ? budgets.sharedPoolBytes : 0;
  const committedBytes = budgetSum + poolBytes;
  const unreachableRawBytes = attribution.unreachable.reduce((sum, file) => sum + file.rawBytes, 0);
  if (committedBytes > budgets.globalCapBytes) {
    configErrors.push(
      `Owner budgets (${budgetSum} bytes) plus the shared pool (${poolBytes} bytes) ` +
        `sum to ${committedBytes} bytes, above the global cap of ${budgets.globalCapBytes}.`
    );
  } else if (committedBytes + unreachableRawBytes > budgets.globalCapBytes) {
    // The budgets fit the cap on paper, but unreachable files still ship in the package and
    // take up the same space. Say so rather than passing silently.
    overruns.push(
      `Owner budgets plus the shared pool (${committedBytes} bytes) fit the global cap of ` +
        `${budgets.globalCapBytes} only if the ${attribution.unreachable.length} unreachable ` +
        `declaration files (${unreachableRawBytes} bytes) stop shipping. Today they overcommit ` +
        `the cap by ${committedBytes + unreachableRawBytes - budgets.globalCapBytes} bytes.`
    );
  }
  for (const owner of Object.keys(budgets.owners)) {
    if (!attribution.owners.has(owner)) {
      configErrors.push(`Budget for "${owner}" has no matching owner in the owners map.`);
    }
  }
  const pooledOwners = new Set(Array.isArray(budgets.pooledOwners) ? budgets.pooledOwners : []);
  if (!Array.isArray(budgets.pooledOwners)) {
    configErrors.push('pooledOwners must be a list of owner names (use [] for none).');
  }
  for (const owner of pooledOwners) {
    if (!attribution.owners.has(owner)) {
      configErrors.push(`Pooled owner "${owner}" has no matching owner in the owners map.`);
    }
    if (budgets.owners[owner] !== undefined) {
      configErrors.push(
        `Owner "${owner}" has its own budget and is also in pooledOwners. Keep only one.`
      );
    }
  }

  let reachableRawBytes = 0;
  const pooled: { owner: string; rawBytes: number }[] = [];
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
    if (budget === undefined && pooledOwners.has(owner)) {
      status = 'pool';
      if (usage.rawBytes > 0) pooled.push({ owner, rawBytes: usage.rawBytes });
    } else if (budget === undefined) {
      status = 'unbudgeted';
      configErrors.push(
        `Owner "${owner}" has no budget. Add one to owners, or, for a new integration, list it in pooledOwners.`
      );
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

  pooled.sort((a, b) => b.rawBytes - a.rawBytes || compareText(a.owner, b.owner));
  const pool: SharedPoolUsage = {
    bytes: poolBytes,
    usedBytes: pooled.reduce((sum, entry) => sum + entry.rawBytes, 0),
    owners: pooled.map((entry) => entry.owner),
  };
  if (pool.usedBytes > pool.bytes) {
    overruns.push(
      `Pooled owners (${pool.owners.join(', ')}) use ${pool.usedBytes} bytes, ` +
        `over the shared pool of ${pool.bytes}. Give the largest one its own budget, remove it ` +
        'from pooledOwners and shrink the pool by the same amount, or make room elsewhere.'
    );
  }

  rows.sort((a, b) => b.usage.rawBytes - a.usage.rawBytes || compareText(a.owner, b.owner));
  return {
    rows,
    reachableRawBytes,
    budgetSum,
    pool,
    committedBytes,
    unreachableRawBytes,
    configErrors,
    overruns,
    docDrops,
  };
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
