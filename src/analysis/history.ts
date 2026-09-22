import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scan } from '../api.js';

/**
 * The numbers, over time.
 *
 * A single scan says a codebase is 4% dead. That is a fact nobody acts on. The
 * same number rising for six weeks is an argument, and a falling one is the
 * reward loop that keeps anybody using this. It is also the cheapest screen to
 * build, since the analysis already exists — it just has to be run at each
 * point in history.
 */

export interface HistoryPoint {
  sha: string;
  date: string;
  deadLoc: number;
  duplicateLoc: number;
  driftCount: number;
  loc: number;
  /** Share of lines that are neither dead nor duplicated. */
  loadBearing: number;
}

export interface HistoryOptions {
  /** How far back to go. */
  days: number;
  /** How many samples across that window. */
  points: number;
  onProgress?: (done: number, total: number, sha: string) => void;
}

export function historyPath(root: string): string {
  return join(root, '.instantiate', 'history.json');
}

export function readHistory(root: string): HistoryPoint[] {
  const path = historyPath(root);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HistoryPoint[];
  } catch {
    return [];
  }
}

function writeHistory(root: string, points: HistoryPoint[]): void {
  mkdirSync(join(root, '.instantiate'), { recursive: true });
  const sorted = points.slice().sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(historyPath(root), `${JSON.stringify(sorted, null, 2)}\n`);
}

export function isGitRepo(root: string): boolean {
  try {
    git(root, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Sample commits evenly across the window: the last commit on or before each
 * cut-off. Sampling by date rather than by commit count keeps the x-axis
 * honest, since a quiet fortnight should look quiet.
 */
function sampleCommits(root: string, days: number, points: number): Array<{ sha: string; date: string }> {
  const out: Array<{ sha: string; date: string }> = [];
  const seen = new Set<string>();
  const now = Date.now();
  const step = (days * 86_400_000) / Math.max(1, points - 1);

  for (let i = points - 1; i >= 0; i--) {
    const when = new Date(now - step * i).toISOString();
    let line: string;
    try {
      line = git(root, ['log', '-1', `--until=${when}`, '--format=%H %cI']);
    } catch {
      continue;
    }
    if (!line) continue;
    const [sha, date] = line.split(' ');
    // A quiet period samples the same commit repeatedly; one point is enough.
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    out.push({ sha, date: date?.slice(0, 10) ?? '' });
  }
  return out;
}

/**
 * Scan the codebase as it was at each sampled commit.
 *
 * Each point needs a real checkout, because the analysis reads files from disk.
 * A detached worktree is the cheap way to get one without disturbing whatever
 * the user has in progress — nothing in their working tree is touched.
 */
export function buildHistory(root: string, options: HistoryOptions): HistoryPoint[] {
  if (!isGitRepo(root)) {
    throw new Error('Not a git repository, so there is no history to walk.');
  }

  const existing = new Map(readHistory(root).map((p) => [p.sha, p]));
  const commits = sampleCommits(root, options.days, options.points);
  const results: HistoryPoint[] = [];

  commits.forEach((commit, i) => {
    options.onProgress?.(i + 1, commits.length, commit.sha);

    const cached = existing.get(commit.sha);
    if (cached) {
      // A commit's numbers cannot change, so never re-scan one we have.
      results.push(cached);
      return;
    }

    const worktree = join(tmpdir(), `instantiate-${commit.sha.slice(0, 12)}`);
    try {
      git(root, ['worktree', 'add', '--detach', '--quiet', worktree, commit.sha]);
      const result = scan({ root: worktree });
      const clean =
        result.stats.loc > 0
          ? 1 - (result.stats.deadLoc + result.stats.duplicateLoc) / result.stats.loc
          : 1;
      results.push({
        sha: commit.sha,
        date: commit.date,
        deadLoc: result.stats.deadLoc,
        duplicateLoc: result.stats.duplicateLoc,
        driftCount: result.stats.driftCount,
        loc: result.stats.loc,
        loadBearing: Number((clean * 100).toFixed(2)),
      });
    } catch {
      // A commit that will not check out or index is skipped rather than fatal:
      // a gap in the line is better than no line.
    } finally {
      try {
        git(root, ['worktree', 'remove', '--force', worktree]);
      } catch {
        rmSync(worktree, { recursive: true, force: true });
      }
    }
  });

  const merged = [...existing.values()];
  for (const point of results) {
    if (!existing.has(point.sha)) merged.push(point);
  }
  writeHistory(root, merged);
  return results;
}

/** Sparkline from a series, for the terminal. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const blocks = '▁▂▃▄▅▆▇█';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((value) => {
      // A flat series is flat, not noise: pin it to the middle rather than
      // amplifying floating-point dust into a mountain range.
      if (span < 1e-9) return blocks[3];
      const index = Math.round(((value - min) / span) * (blocks.length - 1));
      return blocks[index];
    })
    .join('');
}

export interface TrendSummary {
  label: string;
  values: number[];
  first: number;
  last: number;
  /** Positive means the number grew. */
  delta: number;
  /** True when growth is the bad direction for this metric. */
  growthIsBad: boolean;
}

export function summarise(points: HistoryPoint[]): TrendSummary[] {
  const series: Array<[string, (p: HistoryPoint) => number, boolean]> = [
    ['dead lines', (p) => p.deadLoc, true],
    ['duplicated lines', (p) => p.duplicateLoc, true],
    ['load-bearing %', (p) => p.loadBearing, false],
    ['total lines', (p) => p.loc, false],
  ];

  return series.map(([label, pick, growthIsBad]) => {
    const values = points.map(pick);
    const first = values[0] ?? 0;
    const last = values[values.length - 1] ?? 0;
    return { label, values, first, last, delta: last - first, growthIsBad };
  });
}
