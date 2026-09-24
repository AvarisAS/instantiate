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
import { UserError } from './errors.js';
import type { Coverage } from './analysis/coverage.js';
import { buildPythonGraph } from './index/python.js';
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
  await mergePython(graph, config);
  const indexMs = Date.now() - indexStart;

  const analyseStart = Date.now();
  const dead = findDeadCode(graph, config, options.coverage);
  const dupes = findDuplicates(graph, config);
  const drift = findDrift(graph);
  const contradictions = findContradictions(graph);
  const concepts = findConcepts(graph, config.concepts);
  const analyseMs = Date.now() - analyseStart;

  if (options.coverage) {
    warnings.push(
      `Merged a ${options.coverage.format} coverage report covering ${options.coverage.files} files. ` +
        'Anything the tests executed counts as reached, however it was reached.',
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
    indexMs,
    analyseMs,
  };

  const findings = rank([
    ...dead.findings,
    ...dupes.findings,
    ...drift.findings,
    ...contradictions.findings,
  ]);
  return { graph, findings, concepts, stats, config, warnings };
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
  const impact = finding.score * Math.log2(finding.loc + 2);
  return impact >= 3.5 ? 'high' : impact >= 1.8 ? 'medium' : 'low';
}

/**
 * Index Python alongside TypeScript and merge the two into one graph.
 *
 * A polyglot repository is one codebase, and a per-language report would hide
 * exactly the thing worth seeing. Loading the grammar costs real time, so it is
 * skipped entirely when there is no Python to read.
 */
async function mergePython(graph: CodeGraph, config: Config): Promise<void> {
  const files = discoverFiles(config, config.python);
  if (files.length === 0) return;

  const python = await buildPythonGraph(config, files);
  for (const [id, symbol] of python.symbols) graph.symbols.set(id, symbol);
  for (const [path, record] of python.files) graph.files.set(path, record);
  for (const [path, source] of python.sources) graph.sources.set(path, source);
  graph.edges.push(...python.edges);
  // A `__main__` guard is discovered by reading the file, not by its name, so
  // these arrive as exact paths rather than as globs.
  config.entrypoints = [...config.entrypoints, ...python.scripts];
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
  if (finding.kind === 'contradiction') return finding.score * 4;
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
