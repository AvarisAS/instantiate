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
  // Every satellite file is a root: an MDX page or a single-file component is
  // rendered by its framework, so whatever it imports is live.
  for (const edge of graph.edges) {
    if (edge.from.endsWith('#<satellite>')) roots.add(edge.from);
  }
  for (const symbol of graph.symbols.values()) {
    // An ambient declaration merges into a type declared elsewhere. Nothing
    // names it, it cannot be deleted, and reporting it is always wrong.
    if (symbol.ambient) roots.add(symbol.id);
    // Everything in an entrypoint file is reachable: module-level code runs.
    else if (entryFiles.includes(symbol.file)) roots.add(symbol.id);
    // A published export is the package's contract; absent callers are the point.
    else if (apiFiles.includes(symbol.file) && symbol.exported) roots.add(symbol.id);
  }

  // A module nothing imports, which nevertheless runs code when loaded, is a
  // script: something executes it even though no file names it. Treating it as
  // an entrypoint is what stops every helper in a build script, a migration or
  // a benchmark being reported as dead.
  const imported = new Set(
    graph.edges.filter((e) => e.kind === 'imports').map((e) => e.to),
  );
  for (const symbol of graph.symbols.values()) {
    if (symbol.kind === 'module' && symbol.sideEffects && !imported.has(symbol.id)) {
      roots.add(symbol.id);
      for (const other of graph.symbols.values()) {
        // Everything the script declares is in scope while it runs.
        if (other.file === symbol.file) roots.add(other.id);
      }
    }
  }

  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }

  const walk = (seeds: Iterable<string>): Set<string> => {
    const seen = new Set<string>(seeds);
    const queue = [...seen];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const next of outgoing.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };

  // A class published as part of the API brings its public members with it.
  // `HTTPError.statusCode` has no caller inside the library precisely because
  // it exists for consumers, and the publicApi rule already says those exports
  // are the contract — it simply had not reached inside a class before.
  const apiRoots = new Set<string>();
  for (const symbol of graph.symbols.values()) {
    if (apiFiles.includes(symbol.file) && symbol.exported) apiRoots.add(symbol.id);
  }
  for (const id of walk(apiRoots)) {
    const owner = graph.symbols.get(id);
    if (!owner || owner.kind !== 'class') continue;
    for (const member of graph.symbols.values()) {
      if (member.kind !== 'method' || !member.id.startsWith(`${owner.file}#${owner.name}.`)) continue;
      // Private members are not a contract with anybody.
      if (member.name.startsWith('#') || member.name.startsWith('_')) continue;
      roots.add(member.id);
    }
  }

  const reachable = walk(roots);

  const noEntrypoints = entryFiles.length === 0 && apiFiles.length === 0;
  if (noEntrypoints) {
    return { findings: [], reachable, deadLoc: 0, noEntrypoints: true };
  }

  const dynamicNames = collectDynamicNames(graph);
  const findings: Finding[] = [];
  let deadLoc = 0;

  // A file with nothing reachable in it is one decision — delete the file —
  // not one row per symbol. zod's top twenty findings were two orphaned files
  // between them, which pushed every independent finding out of view.
  const orphanFiles = findOrphanFiles(graph, reachable);

  for (const file of orphanFiles) {
    const symbols = [...graph.symbols.values()].filter(
      (s) => s.file === file && s.kind !== 'module',
    );
    const loc = graph.files.get(file)?.loc ?? symbols.reduce((sum, s) => sum + s.loc, 0);
    deadLoc += loc;
    findings.push({
      id: `orphan-file:${file}`,
      kind: 'orphan-file',
      severity: 'high',
      title: `Nothing in ${file} is reachable`,
      detail:
        `All ${symbols.length} symbol${symbols.length === 1 ? '' : 's'} in this file are unreachable, ` +
        'and no file imports it. Deleting the file is one decision rather than one per symbol.',
      file,
      line: 1,
      symbols: symbols.map((s) => s.id),
      loc,
      score: 0.9,
      evidence: {
        symbols: symbols.map((s) => ({ name: s.name, line: s.line, kind: s.kind, loc: s.loc })),
      },
    });
  }

  for (const symbol of graph.symbols.values()) {
    if (reachable.has(symbol.id)) continue;
    if (symbol.kind === 'module') continue;
    if (orphanFiles.has(symbol.file)) continue; // Reported as one file above.

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
 * Files where nothing at all is reachable and nothing imports the file.
 *
 * Both conditions matter: a file whose exports are all unused but which is
 * imported for its side effects is not an orphan, and a file nobody imports
 * but whose symbols are reached some other way is not one either.
 */
function findOrphanFiles(graph: CodeGraph, reachable: Set<string>): Set<string> {
  const importedFiles = new Set(
    graph.edges
      .filter((e) => e.kind === 'imports')
      .map((e) => e.to.split('#')[0]),
  );

  const orphans = new Set<string>();
  for (const file of graph.files.keys()) {
    if (importedFiles.has(file)) continue;
    const symbols = [...graph.symbols.values()].filter(
      (s) => s.file === file && s.kind !== 'module',
    );
    // A file with one symbol is clearer reported as that symbol.
    if (symbols.length < 2) continue;
    if (symbols.every((s) => !reachable.has(s.id))) orphans.add(file);
  }
  return orphans;
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
