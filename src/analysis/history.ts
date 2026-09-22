import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scan } from '../api.js';
import { UserError } from '../errors.js';

/**
 * The numbers, over time.
 *
 * A single scan says a codebase is 4% dead. That is a fact nobody acts on. The
 * same number rising for six weeks is an argument, and a falling one is the
 * reward loop that keeps anybody using this. It is also the cheapest screen to
 * build, since the analysis already exists — it just has to be run at each
 * point in history.
 */

/**
 * Bump whenever a change alters what the numbers mean.
 *
 * A cached point is never re-scanned, because a commit's content cannot change
 * — but the analysis can. Mixing points measured by different rules produces a
 * line that looks like a trend and is an artefact of the tool changing under
 * it, which is worse than having no line at all.
 */
export const ANALYSIS_VERSION = 3;

export interface HistoryPoint {
  sha: string;
  /** The analysis that produced this point; older ones are re-measured. */
  version?: number;
  date: string;
  /**
   * Full commit timestamp. Ordering on the date alone puts a day's worth of
   * commits in arbitrary order, which on a young repository is every commit
   * there is, and draws a line that goes backwards.
   */
  at?: string;
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
  const sorted = points
    .slice()
    .sort((a, b) => (a.at ?? a.date).localeCompare(b.at ?? b.date));
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
interface Sample {
  sha: string;
  date: string;
  at: string;
}

function sampleCommits(root: string, days: number, points: number): Sample[] {
  const out: Sample[] = [];
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
    out.push({ sha, date: date?.slice(0, 10) ?? '', at: date ?? '' });
  }

  // Sampling by date keeps the x-axis honest, but a young repository does all
  // its work in a few days and collapses to two points. Spread the commits
  // themselves instead, which is the case this tool most wants to serve.
  if (out.length < points) {
    const spread = sampleByCommitCount(root, points, seen);
    out.push(...spread);
    out.sort((a, b) => a.at.localeCompare(b.at));
  }
  return out;
}

function sampleByCommitCount(root: string, points: number, seen: Set<string>): Sample[] {
  let log: string[];
  try {
    log = git(root, ['log', '--format=%H %cI']).split('\n').filter(Boolean);
  } catch {
    return [];
  }
  if (log.length === 0) return [];

  const out: Sample[] = [];
  const step = Math.max(1, Math.floor(log.length / points));
  // `git log` is newest first; walk from the oldest so the line reads forwards.
  for (let i = log.length - 1; i >= 0 && seen.size < points + out.length; i -= step) {
    const [sha, date] = log[i].split(' ');
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    out.push({ sha, date: date?.slice(0, 10) ?? '', at: date ?? '' });
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
export async function buildHistory(root: string, options: HistoryOptions): Promise<HistoryPoint[]> {
  if (!isGitRepo(root)) {
    throw new UserError('Not a git repository, so there is no history to walk.');
  }

  const existing = new Map(readHistory(root).map((p) => [p.sha, p]));
  const commits = sampleCommits(root, options.days, options.points);
  const results: HistoryPoint[] = [];

  for (const [i, commit] of commits.entries()) {
    options.onProgress?.(i + 1, commits.length, commit.sha);

    const cached = existing.get(commit.sha);
    if (cached && cached.version === ANALYSIS_VERSION) {
      // A commit's content cannot change, so never re-scan one we have — as
      // long as it was measured by the rules in force now.
      results.push(cached);
      continue;
    }

    const worktree = join(tmpdir(), `instantiate-${commit.sha.slice(0, 12)}`);
    try {
      git(root, ['worktree', 'add', '--detach', '--quiet', worktree, commit.sha]);
      const result = await scan({ root: worktree });
      const clean =
        result.stats.loc > 0
          ? 1 - (result.stats.deadLoc + result.stats.duplicateLoc) / result.stats.loc
          : 1;
      results.push({
        sha: commit.sha,
        version: ANALYSIS_VERSION,
        date: commit.date,
        at: commit.at,
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
  }

  // Re-measured points replace their stale predecessors.
  const merged = new Map(existing);
  for (const point of results) merged.set(point.sha, point);
  writeHistory(root, [...merged.values()]);
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
