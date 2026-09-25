import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Budget, Stats } from '../types.js';

/**
 * The ratchet. CI fails on an *increase*, never on an absolute number.
 *
 * A repo with 4,100 dead lines today is not a repo anyone will clean up before
 * adopting a tool. Baselining the mess and refusing to let it grow is the only
 * version of this that lands in a real codebase.
 */

export function budgetPath(root: string): string {
  return join(root, '.instantiate', 'budget.json');
}

export function readBudget(root: string): Budget | undefined {
  const path = budgetPath(root);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Budget;
  } catch {
    return undefined;
  }
}

export function writeBudget(root: string, stats: Stats): Budget {
  const budget: Budget = {
    dead: stats.deadLoc,
    duplicate: stats.duplicateLoc,
    drift: stats.driftCount,
    contradiction: stats.contradictionCount,
    unfinished: stats.unfinishedCount,
    ignored: stats.ignoredCount,
    createdAt: Date.now(),
  };
  mkdirSync(join(root, '.instantiate'), { recursive: true });
  writeFileSync(budgetPath(root), `${JSON.stringify(budget, null, 2)}\n`);
  return budget;
}

export interface BudgetCheck {
  ok: boolean;
  lines: string[];
}

export function checkBudget(budget: Budget, stats: Stats): BudgetCheck {
  const rows: Array<[string, number, number]> = [
    ['dead lines', stats.deadLoc, budget.dead],
    ['duplicated lines', stats.duplicateLoc, budget.duplicate],
    ['drifting conventions', stats.driftCount, budget.drift],
    // An older budget file predates this metric; treat it as "none allowed"
    // only once it has been recorded, never as an accidental instant failure.
    ['contradictions', stats.contradictionCount, budget.contradiction ?? stats.contradictionCount],
    ['unfinished', stats.unfinishedCount, budget.unfinished ?? stats.unfinishedCount],
    // Each new exception is a decision someone has to lock in on purpose.
    ['ignored in code', stats.ignoredCount, budget.ignored ?? stats.ignoredCount],
  ];

  const lines: string[] = [];
  let ok = true;

  for (const [label, actual, allowed] of rows) {
    const delta = actual - allowed;
    if (delta > 0) {
      ok = false;
      lines.push(`  ✗ ${label}: ${actual} (budget ${allowed}, +${delta})`);
    } else if (delta < 0) {
      // Improvement is worth saying out loud, and worth tightening the budget to.
      lines.push(`  ✓ ${label}: ${actual} (budget ${allowed}, ${delta} — run \`instantiate budget\` to lock this in)`);
    } else {
      lines.push(`  ✓ ${label}: ${actual} (at budget)`);
    }
  }

  return { ok, lines };
}
