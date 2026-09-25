import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalysisResult, CodeGraph, Finding, Stats } from './types.js';
import { loadConfig, type Config } from './config.js';
import { buildGraph } from './index/extract.js';
import { findDeadCode } from './analysis/dead.js';
import { findDuplicates } from './analysis/dupes.js';
import { findConcepts } from './analysis/concepts.js';
import { findDrift } from './analysis/drift.js';
import { findContradictions } from './analysis/contradiction.js';
import { findUnfinished } from './analysis/unfinished.js';
import { applyIgnores } from './analysis/ignores.js';
import { UserError } from './errors.js';
import type { Coverage } from './analysis/coverage.js';
import type { RepoInfo } from './types.js';
import { detectRepo } from './util/repo.js';
import { BACKENDS } from './index/backends.js';
import { discoverFiles } from './index/extract.js';

export interface ScanOptions {
  root?: string;
  config?: Config;
  /** A coverage report, which turns guesses about dynamic dispatch into facts. */
  coverage?: Coverage;
  /** Reuse a cached graph when no file has changed. */
  cache?: boolean;
}

export interface ScanResult extends AnalysisResult {
  config: Config;
  warnings: string[];
  /** The remote this code lives on, when there is one. */
  repo?: RepoInfo;
}

export async function scan(options: ScanOptions = {}): Promise<ScanResult> {
  const root = options.root ?? process.cwd();
  // Reporting a clean scan of a directory that does not exist is worse than
  // failing: it looks like a verdict.
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new UserError(`No such directory: ${root}`);
  }
  const config = options.config ?? loadConfig(root);
  const warnings: string[] = [];

  const indexStart = Date.now();
  const graph = buildGraph(config);
  await mergeBackends(graph, config);
  const indexMs = Date.now() - indexStart;

  const analyseStart = Date.now();
  const dead = findDeadCode(graph, config, options.coverage);
  const dupes = findDuplicates(graph, config);
  const drift = findDrift(graph);
  const contradictions = findContradictions(graph);
  const unfinished = findUnfinished(graph, config);
  const concepts = findConcepts(graph, config.concepts);
  const analyseMs = Date.now() - analyseStart;

  if (options.coverage) {
    warnings.push(
      `Merged a ${options.coverage.format} coverage report covering ${options.coverage.files} files. ` +
        'Anything the tests executed counts as reached, however it was reached.',
    );
  }
  if (dead.pluginRoots.size > 0) {
    const applied = [...dead.pluginRoots].map(([name, count]) => `${name} (${count})`).join(', ');
    warnings.push(`Framework conventions kept symbols alive that nothing names: ${applied}.`);
  }
  const sites = graph.dynamicSites;
  if (sites.length > 0) {
    const first = sites.slice(0, 3).map((site) => `${site.file}:${site.line}`).join(', ');
    warnings.push(
      `${sites.length} place${sites.length === 1 ? '' : 's'} reach code by a name computed at run time (${first}` +
        `${sites.length > 3 ? ', …' : ''}), which static analysis cannot follow. ` +
        'A coverage report (--coverage) or a plugin rule in .instantiate.yml settles what they reach.',
    );
  }
  if (dead.noEntrypoints) {
    warnings.push(
      'No entrypoint matched a file, so dead-code detection was skipped. ' +
        'Set `entrypoints` in .instantiate.yml — without it the result would be meaningless, not empty.',
    );
  }
  if (graph.files.size === 0) {
    warnings.push(
      `No source files were found under ${root}. Check that this is the right directory, ` +
        'and that `include` and `exclude` in .instantiate.yml are not excluding everything.',
    );
  } else if (graph.symbols.size === 0) {
    warnings.push('Files were read but no symbols were indexed, which usually means a parse failure.');
  }

  const stats: Stats = {
    files: graph.files.size,
    symbols: graph.symbols.size,
    edges: graph.edges.length,
    loc: [...graph.files.values()].reduce((sum, f) => sum + f.loc, 0),
    deadLoc: dead.deadLoc,
    duplicateLoc: dupes.duplicateLoc,
    driftCount: drift.count,
    contradictionCount: contradictions.count,
    unfinishedCount: unfinished.count,
    ignoredCount: 0,
    indexMs,
    analyseMs,
  };

  const repo = detectRepo(root);

  const found = [
    ...dead.findings,
    ...dupes.findings,
    ...drift.findings,
    ...contradictions.findings,
    ...unfinished.findings,
  ];
  const ignores = applyIgnores(found, graph);
  // What was ignored was judged fine, so it leaves the headline numbers too.
  const before = headline(found);
  const after = headline(ignores.findings);
  stats.deadLoc -= before.dead - after.dead;
  stats.duplicateLoc -= before.duplicate - after.duplicate;
  stats.driftCount -= before.drift - after.drift;
  stats.contradictionCount -= before.contradiction - after.contradiction;
  stats.unfinishedCount -= before.unfinished - after.unfinished;
  stats.ignoredCount = ignores.applied.length;

  const where = (list: Array<{ file: string; line: number }>): string =>
    list.slice(0, 3).map((i) => `${i.file}:${i.line}`).join(', ') + (list.length > 3 ? ', …' : '');
  if (ignores.malformed.length > 0) {
    warnings.push(
      `${ignores.malformed.length} instantiate-ignore comment${ignores.malformed.length === 1 ? ' is' : 's are'} ` +
        `missing a kind or a reason, so ${ignores.malformed.length === 1 ? 'it hides' : 'they hide'} nothing ` +
        `(${where(ignores.malformed)}). Write it as \`instantiate-ignore dead: why this is fine\`.`,
    );
  }
  if (ignores.stale.length > 0) {
    warnings.push(
      `${ignores.stale.length} instantiate-ignore comment${ignores.stale.length === 1 ? ' no longer hides' : 's no longer hide'} ` +
        `anything (${where(ignores.stale)}). Delete ${ignores.stale.length === 1 ? 'it' : 'them'}.`,
    );
  }

  const findings = rank(ignores.findings);
  return { graph, findings, concepts, stats, config, warnings, repo };
}

/** The headline numbers as the findings imply them, used to take ignored findings out. */
function headline(findings: Finding[]) {
  const confident = (f: Finding): boolean => f.score >= 0.5;
  const sum = (kinds: string[]): number =>
    findings.filter((f) => kinds.includes(f.kind) && confident(f)).reduce((n, f) => n + f.loc, 0);
  return {
    dead: sum(['dead', 'orphan-file']),
    duplicate: sum(['duplicate']),
    drift: findings.filter((f) => f.kind === 'drift').length,
    contradiction: findings.filter((f) => f.kind === 'contradiction').length,
    unfinished: findings.filter((f) => f.kind === 'unfinished' && confident(f)).length,
  };
}

/**
 * Severity has to carry confidence, not just size. A 158-line finding the
 * analysis is only 27% sure of is not "high" — labelling it so is how a tool
 * teaches people to ignore its own top line.
 */
function withSeverity(finding: Finding): Finding {
  const severity = severityOf(finding);
  return finding.severity === severity ? finding : { ...finding, severity };
}

function severityOf(finding: Finding): Finding['severity'] {
  // A contradiction's `loc` counts sites, not lines, so the size term does not
  // apply: two call sites disagreeing about one value is serious at any size.
  if (finding.kind === 'contradiction') {
    return finding.score >= 0.8 ? 'high' : finding.score >= 0.5 ? 'medium' : 'low';
  }
  // A feature that silently does nothing matters however few lines it spans.
  if (finding.kind === 'unfinished') return finding.score >= 0.5 ? 'medium' : 'low';
  const impact = finding.score * Math.log2(finding.loc + 2);
  return impact >= 3.5 ? 'high' : impact >= 1.8 ? 'medium' : 'low';
}

/**
 * Index every other language alongside TypeScript and merge them into one graph.
 *
 * A polyglot repository is one codebase, and a per-language report would hide
 * exactly the thing worth seeing. Loading a grammar costs real time, so a
 * language with no files in the repository costs nothing.
 */
async function mergeBackends(graph: CodeGraph, config: Config): Promise<void> {
  for (const backend of BACKENDS) {
    const files = discoverFiles(config, backend.globs(config));
    if (files.length === 0) continue;

    const built = await backend.build(config, files);
    for (const [id, symbol] of built.symbols) graph.symbols.set(id, symbol);
    for (const [path, record] of built.files) graph.files.set(path, record);
    for (const [path, source] of built.sources) graph.sources.set(path, source);
    graph.edges.push(...built.edges);
    graph.dynamicSites.push(...built.dynamicSites);
    // Found by reading the file (a `__main__` guard, a `main` function), not by
    // its name, so these arrive as exact paths rather than as globs.
    config.entrypoints = [...config.entrypoints, ...built.scripts];
    config.publicApi = [...config.publicApi, ...(built.publicApi ?? [])];
    graph.roots = [...(graph.roots ?? []), ...(built.roots ?? [])];
  }
}

/**
 * The noise budget, applied here rather than in each analysis.
 *
 * A first run that opens with 400 findings is a linter nobody enables. Ranking
 * is the real engineering problem in this product: the top twenty must each be
 * obviously true, or the tool is uninstalled before the good findings are seen.
 */
export function rank(findings: Finding[]): Finding[] {
  return findings
    .map(withSeverity)
    .sort((a, b) => {
      // Impact is confidence times size; a confident 200-line deletion beats a
      // speculative one-liner every time.
      const impact = weight(b) - weight(a);
      if (Math.abs(impact) > 0.001) return impact;
      return a.id.localeCompare(b.id);
    });
}

/** Ranking weight: confidence times size, except where size does not mean lines. */
function weight(finding: Finding): number {
  if (finding.kind === 'contradiction' || finding.kind === 'unfinished') return finding.score * 4;
  return finding.score * Math.log2(finding.loc + 2);
}

export interface Dismissal {
  id: string;
  /**
   * Why this was judged not to matter.
   *
   * A dismissal without one is unreviewable: whoever reads the diff cannot tell
   * a considered decision from someone silencing a finding they did not
   * understand, and the record outlives everyone's memory of it.
   */
  reason: string;
  at: string;
}

export interface DismissalStore {
  dismissed: Dismissal[];
  fixed: string[];
}

export function loadDismissals(root: string): DismissalStore {
  const path = join(root, '.instantiate', 'dismissed.json');
  if (!existsSync(path)) return { dismissed: [], fixed: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      dismissed?: Array<string | Dismissal>;
      fixed?: string[];
    };
    return {
      // Tolerate the earlier shape, where a dismissal was just an id.
      dismissed: (raw.dismissed ?? []).map((entry) =>
        typeof entry === 'string' ? { id: entry, reason: '', at: '' } : entry,
      ),
      fixed: raw.fixed ?? [],
    };
  } catch {
    return { dismissed: [], fixed: [] };
  }
}

export function saveDismissals(root: string, store: DismissalStore): void {
  mkdirSync(join(root, '.instantiate'), { recursive: true });
  const byId = new Map(store.dismissed.map((d) => [d.id, d]));
  const dismissed = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(
    join(root, '.instantiate', 'dismissed.json'),
    `${JSON.stringify({ dismissed, fixed: [...new Set(store.fixed)].sort() }, null, 2)}\n`,
  );
}

/** Findings the human has already judged stay judged, across runs. */
export function applyDismissals(findings: Finding[], store: DismissalStore): Finding[] {
  const hidden = new Set([...store.dismissed.map((d) => d.id), ...store.fixed]);
  return findings.filter((f) => !hidden.has(f.id));
}

export {
  loadConfig,
  buildGraph,
  findDeadCode,
  findDuplicates,
  findConcepts,
  findDrift,
  findContradictions,
};
export type { Config, CodeGraph, Finding, Stats, AnalysisResult };
