import type { CodeGraph, Finding, CodeSymbol } from '../types.js';
import type { Config } from '../config.js';
import { matchesAny } from '../util/glob.js';

/** Findings below this confidence are shown, but do not count towards the budget. */
const METRIC_CONFIDENCE_FLOOR = 0.5;

export interface DeadResult {
  findings: Finding[];
  reachable: Set<string>;
  deadLoc: number;
  /** True when no entrypoint matched a real file, so the result means nothing. */
  noEntrypoints: boolean;
}

/**
 * Reachability from entrypoints. Everything a running program can get to is alive;
 * the rest is a deletion candidate.
 *
 * The result is only as trustworthy as the entrypoint set, so a run that resolves
 * no entrypoints reports that rather than declaring the whole repo dead.
 */
export function findDeadCode(graph: CodeGraph, config: Config): DeadResult {
  const entryFiles = [...graph.files.keys()].filter((f) => matchesAny(f, config.entrypoints));
  const apiFiles = [...graph.files.keys()].filter((f) => matchesAny(f, config.publicApi));
  graph.entrypoints = entryFiles;

  const roots = new Set<string>();
  for (const symbol of graph.symbols.values()) {
    // Everything in an entrypoint file is reachable: module-level code runs.
    if (entryFiles.includes(symbol.file)) roots.add(symbol.id);
    // A published export is the package's contract; absent callers are the point.
    else if (apiFiles.includes(symbol.file) && symbol.exported) roots.add(symbol.id);
  }

  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }

  const reachable = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const next of outgoing.get(current) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  const noEntrypoints = entryFiles.length === 0 && apiFiles.length === 0;
  if (noEntrypoints) {
    return { findings: [], reachable, deadLoc: 0, noEntrypoints: true };
  }

  const dynamicNames = collectDynamicNames(graph);
  const findings: Finding[] = [];
  let deadLoc = 0;

  for (const symbol of graph.symbols.values()) {
    if (reachable.has(symbol.id)) continue;
    if (symbol.kind === 'module') continue;

    const score = confidence(symbol, dynamicNames);
    // Same rule as duplicates: the headline number, and therefore the CI budget,
    // only counts what we would stand behind.
    if (score >= METRIC_CONFIDENCE_FLOOR) deadLoc += symbol.loc;
    findings.push({
      id: `dead:${symbol.id}`,
      kind: 'dead',
      severity: symbol.loc >= 40 ? 'high' : symbol.loc >= 10 ? 'medium' : 'low',
      title: `${symbol.name} is never reached`,
      detail: buildDetail(symbol, dynamicNames),
      file: symbol.file,
      line: symbol.line,
      symbols: [symbol.id],
      loc: symbol.loc,
      score,
      evidence: {
        kind: symbol.kind,
        exported: symbol.exported,
        nameAppearsInString: dynamicNames.has(symbol.name),
      },
    });
  }

  // Biggest and most certain first: that is the order a human should delete in.
  findings.sort((a, b) => b.score * b.loc - a.score * a.loc);
  return { findings, reachable, deadLoc, noEntrypoints: false };
}

/**
 * Names that appear inside string literals anywhere in the codebase. A static
 * graph cannot see `container.resolve('UserService')`, so any symbol whose name
 * shows up as a string is downgraded rather than reported as confidently dead.
 */
function collectDynamicNames(graph: CodeGraph): Set<string> {
  const names = new Set<string>();
  const stringLiteral = /['"`]([A-Za-z_$][\w$]*)['"`]/g;
  for (const symbol of graph.symbols.values()) {
    let match: RegExpExecArray | null;
    stringLiteral.lastIndex = 0;
    while ((match = stringLiteral.exec(symbol.body)) !== null) names.add(match[1]);
  }
  return names;
}

function confidence(symbol: CodeSymbol, dynamicNames: Set<string>): number {
  let score = 0.95;
  // An export may have a consumer this repo cannot see.
  if (symbol.exported) score -= 0.25;
  // A name that also appears as a string may be reached by dynamic lookup.
  if (dynamicNames.has(symbol.name)) score -= 0.35;
  // Types vanish at runtime, so an unused one is real but cheap; rank it below code.
  if (symbol.kind === 'interface' || symbol.kind === 'type') score -= 0.1;
  // One-liners are often re-exports or constants kept deliberately.
  if (symbol.loc <= 2) score -= 0.1;
  return Math.max(0.05, Math.round(score * 100) / 100);
}

function buildDetail(symbol: CodeSymbol, dynamicNames: Set<string>): string {
  const parts = [`No path reaches this ${symbol.kind} from any entrypoint.`];
  if (symbol.exported) {
    parts.push('It is exported, so a consumer outside this repo may still use it.');
  }
  if (dynamicNames.has(symbol.name)) {
    parts.push(`The name "${symbol.name}" also appears in a string literal, so it may be reached dynamically.`);
  }
  return parts.join(' ');
}
