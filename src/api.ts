import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalysisResult, CodeGraph, Finding, Stats } from './types.js';
import { loadConfig, type Config } from './config.js';
import { buildGraph } from './index/extract.js';
import { findDeadCode } from './analysis/dead.js';
import { findDuplicates } from './analysis/dupes.js';
import { findConcepts } from './analysis/concepts.js';
import { findDrift } from './analysis/drift.js';

export interface ScanOptions {
  root?: string;
  config?: Config;
  /** Reuse a cached graph when no file has changed. */
  cache?: boolean;
}

export interface ScanResult extends AnalysisResult {
  config: Config;
  warnings: string[];
}

export function scan(options: ScanOptions = {}): ScanResult {
  const root = options.root ?? process.cwd();
  const config = options.config ?? loadConfig(root);
  const warnings: string[] = [];

  const indexStart = Date.now();
  const graph = buildGraph(config);
  const indexMs = Date.now() - indexStart;

  const analyseStart = Date.now();
  const dead = findDeadCode(graph, config);
  const dupes = findDuplicates(graph, config);
  const drift = findDrift(graph);
  const concepts = findConcepts(graph, config.concepts);
  const analyseMs = Date.now() - analyseStart;

  if (dead.noEntrypoints) {
    warnings.push(
      'No entrypoint matched a file, so dead-code detection was skipped. ' +
        'Set `entrypoints` in .instantiate.yml — without it the result would be meaningless, not empty.',
    );
  }
  if (graph.symbols.size === 0) {
    warnings.push('No symbols were indexed. Check `include` and `exclude` in .instantiate.yml.');
  }

  const stats: Stats = {
    files: graph.files.size,
    symbols: graph.symbols.size,
    edges: graph.edges.length,
    loc: [...graph.files.values()].reduce((sum, f) => sum + f.loc, 0),
    deadLoc: dead.deadLoc,
    duplicateLoc: dupes.duplicateLoc,
    driftCount: drift.count,
    indexMs,
    analyseMs,
  };

  const findings = rank([...dead.findings, ...dupes.findings, ...drift.findings]);
  return { graph, findings, concepts, stats, config, warnings };
}

/**
 * Severity has to carry confidence, not just size. A 158-line finding the
 * analysis is only 27% sure of is not "high" — labelling it so is how a tool
 * teaches people to ignore its own top line.
 */
function withSeverity(finding: Finding): Finding {
  const impact = finding.score * Math.log2(finding.loc + 2);
  const severity = impact >= 3.5 ? 'high' : impact >= 1.8 ? 'medium' : 'low';
  return finding.severity === severity ? finding : { ...finding, severity };
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
      const impact = b.score * Math.log2(b.loc + 2) - a.score * Math.log2(a.loc + 2);
      if (Math.abs(impact) > 0.001) return impact;
      return a.id.localeCompare(b.id);
    });
}

export interface DismissalStore {
  dismissed: string[];
  fixed: string[];
}

export function loadDismissals(root: string): DismissalStore {
  const path = join(root, '.instantiate', 'dismissed.json');
  if (!existsSync(path)) return { dismissed: [], fixed: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DismissalStore;
  } catch {
    return { dismissed: [], fixed: [] };
  }
}

export function saveDismissals(root: string, store: DismissalStore): void {
  mkdirSync(join(root, '.instantiate'), { recursive: true });
  writeFileSync(
    join(root, '.instantiate', 'dismissed.json'),
    `${JSON.stringify({ dismissed: [...new Set(store.dismissed)].sort(), fixed: [...new Set(store.fixed)].sort() }, null, 2)}\n`,
  );
}

/** Findings the human has already judged stay judged, across runs. */
export function applyDismissals(findings: Finding[], store: DismissalStore): Finding[] {
  const hidden = new Set([...store.dismissed, ...store.fixed]);
  return findings.filter((f) => !hidden.has(f.id));
}

export { loadConfig, buildGraph, findDeadCode, findDuplicates, findConcepts, findDrift };
export type { Config, CodeGraph, Finding, Stats, AnalysisResult };
