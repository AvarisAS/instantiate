import type { CodeGraph, CodeSymbol, Finding } from '../types.js';
import type { Config } from '../config.js';
import { structuralBag, vocabularyBag, cosine, splitIdentifier, type Bag } from './similarity.js';

interface Candidate {
  symbol: CodeSymbol;
  structure: Bag;
  vocabulary: Bag;
}

export interface DupeCluster {
  members: CodeSymbol[];
  /** Mean pairwise similarity inside the cluster. */
  similarity: number;
  crossFile: boolean;
  connected: boolean;
  /** The same name implemented once per file: translations, adapters, drivers. */
  parallelSet: boolean;
  /** Thin wrappers that all delegate to one shared target. */
  delegating: boolean;
}

export interface DupeResult {
  findings: Finding[];
  clusters: DupeCluster[];
  duplicateLoc: number;
  /** The cut-off actually used, after per-project calibration. */
  threshold: number;
}

const STRUCTURE_WEIGHT = 0.5;

/**
 * Both signals must clear a floor, not merely average well.
 *
 * Measured on real repositories, the two signals do different jobs than
 * expected. False positives are *vocabulary* matches: a tagged-template helper
 * against a child-node loop, an error boundary against a suspense wrapper —
 * same domain words, 0.74 to 0.93 on vocabulary, but only 0.58 to 0.74 on
 * structure, because they do different things with those words.
 *
 * Genuine re-implementations perform the same steps, so they agree on
 * structure: 1.00 for two copies of one function, and 1.00 for the same idea
 * rewritten with different names. Structure is what separates them, and
 * averaging let a moderate structure score hide behind a strong vocabulary one.
 */
const STRUCTURE_FLOOR = 0.85;
const VOCABULARY_FLOOR = 0.45;

/**
 * Headline numbers drive the CI budget, so only findings we would actually
 * stand behind count towards them. A cluster we are 27% sure of is still worth
 * showing as a question; it is not worth failing someone's build over.
 */
const METRIC_CONFIDENCE_FLOOR = 0.5;

/**
 * Find groups of symbols that do the same job. Not a clone detector: the target
 * is the third `formatDuration` written by a session that could not find the
 * first two, which shares no tokens with them but does share intent.
 */
export function findDuplicates(graph: CodeGraph, config: Config): DupeResult {
  const candidates: Candidate[] = [];
  for (const symbol of graph.symbols.values()) {
    if (symbol.kind !== 'function' && symbol.kind !== 'method') continue;
    if (symbol.loc < config.dupeMinLoc) continue;
    // A constructor, and Python's `__init__` and friends, are near-identical
    // because the language requires the shape, not because anyone
    // re-implemented anything. They are not candidates at all.
    if (symbol.name === 'constructor') continue;
    if (symbol.name.startsWith('__') && symbol.name.endsWith('__')) continue;
    // A stub declares an interface; it has no implementation to duplicate.
    if (isStub(symbol)) continue;
    candidates.push({
      symbol,
      structure: structuralBag(symbol.body),
      vocabulary: vocabularyBag(symbol.name, symbol.body),
    });
  }

  const threshold = calibrate(candidates, config);
  const parallelDirs = findParallelDirectories(graph);
  const pairs = scorePairs(candidates, threshold);
  const clusters = cluster(pairs, candidates, graph, parallelDirs);

  const findings: Finding[] = [];
  let duplicateLoc = 0;

  for (const group of clusters) {
    // The smallest member is what you would keep; the rest is what you would remove.
    const removable = group.members
      .slice()
      .sort((a, b) => a.loc - b.loc)
      .slice(1)
      .reduce((sum, s) => sum + s.loc, 0);

    const score = rankScore(group);
    if (score >= METRIC_CONFIDENCE_FLOOR) duplicateLoc += removable;
    findings.push({
      id: `duplicate:${group.members.map((m) => m.id).join('|')}`,
      kind: 'duplicate',
      severity: removable >= 40 ? 'high' : removable >= 12 ? 'medium' : 'low',
      title: titleOf(group),
      detail: describe(group),
      file: group.members[0].file,
      line: group.members[0].line,
      symbols: group.members.map((m) => m.id),
      loc: removable,
      score,
      evidence: {
        similarity: Number(group.similarity.toFixed(3)),
        crossFile: group.crossFile,
        connected: group.connected,
        members: group.members.map((m) => ({
          id: m.id,
          name: m.name,
          file: m.file,
          line: m.line,
          endLine: m.endLine,
          loc: m.loc,
          signature: m.signature,
        })),
      },
    });
  }

  findings.sort((a, b) => b.score * b.loc - a.score * a.loc);
  return { findings, clusters, duplicateLoc, threshold };
}

/**
 * A codebase of small adapters looks self-similar everywhere, so one global
 * cut-off cannot serve every project. Raise the threshold when the background
 * similarity is already high, otherwise the first run is all noise.
 */
function calibrate(candidates: Candidate[], config: Config): number {
  if (candidates.length < 30) return config.dupeThreshold;

  // Sample random pairs to estimate what "unrelated" looks like in this repo.
  const samples: number[] = [];
  let seed = 42;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < 400; i++) {
    const a = candidates[Math.floor(random() * candidates.length)];
    const b = candidates[Math.floor(random() * candidates.length)];
    if (a === b) continue;
    samples.push(similarity(a, b));
  }
  if (samples.length === 0) return config.dupeThreshold;

  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  // Sit above the background, but never below the configured floor.
  return Math.max(config.dupeThreshold, Math.min(0.95, p95 + 0.05));
}

function similarity(a: Candidate, b: Candidate): number {
  const structure = cosine(a.structure, b.structure);
  if (structure < STRUCTURE_FLOOR) return 0;
  const vocabulary = cosine(a.vocabulary, b.vocabulary);
  if (vocabulary < VOCABULARY_FLOOR) return 0;
  return STRUCTURE_WEIGHT * structure + (1 - STRUCTURE_WEIGHT) * vocabulary;
}

/**
 * One declaration inside another: a closure and the function that holds it.
 *
 * The parent's text contains the child's, so similarity is high by
 * construction and means nothing. This is containment, not duplication.
 */
function contains(a: CodeSymbol, b: CodeSymbol): boolean {
  if (a.file !== b.file) return false;
  return (
    (a.line <= b.line && b.endLine <= a.endLine) || (b.line <= a.line && a.endLine <= b.endLine)
  );
}

interface Pair {
  a: number;
  b: number;
  score: number;
}

/**
 * Candidate generation by inverted index on vocabulary, so we never score all
 * pairs. Two functions with no shared word cannot clear the threshold.
 */
function scorePairs(candidates: Candidate[], threshold: number): Pair[] {
  const postings = new Map<string, number[]>();
  for (let i = 0; i < candidates.length; i++) {
    for (const word of candidates[i].vocabulary.keys()) {
      const list = postings.get(word);
      if (list) list.push(i);
      else postings.set(word, [i]);
    }
  }

  const seen = new Set<number>();
  const pairs: Pair[] = [];
  for (const list of postings.values()) {
    // A word shared by half the codebase tells us nothing and costs the most.
    if (list.length > 60) continue;
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const a = list[x];
        const b = list[y];
        const key = a * candidates.length + b;
        if (seen.has(key)) continue;
        seen.add(key);
        if (contains(candidates[a].symbol, candidates[b].symbol)) continue;
        if (!comparableSize(candidates[a].symbol, candidates[b].symbol)) continue;
        const score = similarity(candidates[a], candidates[b]);
        if (score >= threshold) pairs.push({ a, b, score });
      }
    }
  }
  return pairs;
}

/** Union-find over the surviving pairs: a cluster is a connected component. */
function cluster(
  pairs: Pair[],
  candidates: Candidate[],
  graph: CodeGraph,
  parallelDirs: Set<string>,
): DupeCluster[] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (x: number, y: number): void => {
    const rx = find(parent.has(x) ? x : (parent.set(x, x), x));
    const ry = find(parent.has(y) ? y : (parent.set(y, y), y));
    if (rx !== ry) parent.set(rx, ry);
  };

  for (const pair of pairs) union(pair.a, pair.b);

  const groups = new Map<number, number[]>();
  for (const key of parent.keys()) {
    const root = find(key);
    const list = groups.get(root);
    if (list) list.push(key);
    else groups.set(root, [key]);
  }

  const edgeSet = new Set(graph.edges.map((e) => `${e.from}>${e.to}`));
  const out: DupeCluster[] = [];

  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    const members = indices.map((i) => candidates[i].symbol);
    const relevant = pairs.filter((p) => indices.includes(p.a) && indices.includes(p.b));
    const mean = relevant.reduce((sum, p) => sum + p.score, 0) / (relevant.length || 1);

    // A wrapper that calls the thing it resembles is delegation, not duplication.
    const connected = members.some((m) =>
      members.some((n) => m !== n && (edgeSet.has(`${m.id}>${n.id}`) || edgeSet.has(`${n.id}>${m.id}`))),
    );

    out.push({
      members: members.sort((a, b) => b.loc - a.loc),
      similarity: mean,
      crossFile: new Set(members.map((m) => m.file)).size > 1,
      connected,
      parallelSet: isParallelSet(members) || spansParallelSurfaces(members, parallelDirs),
      delegating: isDelegating(members, graph),
    });
  }

  return out;
}

/**
 * A body that only announces it is not implemented: an abstract base's method,
 * or a placeholder. Every stub resembles every other stub, and none of them is
 * code anyone would merge.
 */
function isStub(symbol: CodeSymbol): boolean {
  return /\b(raise\s+NotImplementedError|throw\s+new\s+Error\(\s*['"`](not implemented|unimplemented)|NotImplementedError\b)/i.test(
    symbol.body,
  );
}

/**
 * Duplicates are substitutable, and substitutable code is comparable in size.
 *
 * A 1078-character implementation and a 231-character declaration matched at
 * 0.86 because both open with a long typed parameter list, which dominates the
 * token skeleton. Neither could replace the other, so it was never a duplicate.
 */
const MAX_SIZE_RATIO = 2.5;

function comparableSize(a: CodeSymbol, b: CodeSymbol): boolean {
  const larger = Math.max(a.body.length, b.body.length);
  const smaller = Math.min(a.body.length, b.body.length);
  return smaller > 0 && larger / smaller <= MAX_SIZE_RATIO;
}

const NON_PRODUCTION =
  /(^|\/)(bench|benchmark|benchmarks|perf|perf-measures|examples?|fixtures?|__fixtures__|demo|playground)\//i;

function isProductionCode(file: string): boolean {
  return !NON_PRODUCTION.test(file);
}

/**
 * Directories that are parallel surfaces over one idea.
 *
 * zod ships `core`, `classic` and `mini`: three published APIs with the same
 * function names and deliberately different generics. A repository with a `v3`
 * beside a `v4`, or one driver directory per backend, has the same shape.
 * Two directories that share a large share of their symbol names are answering
 * the same questions on purpose, so resemblance between them is the design.
 */
function findParallelDirectories(graph: CodeGraph): Set<string> {
  const byDir = new Map<string, Set<string>>();
  for (const symbol of graph.symbols.values()) {
    if (symbol.kind === 'module') continue;
    const dir = symbol.file.slice(0, symbol.file.lastIndexOf('/'));
    const names = byDir.get(dir);
    if (names) names.add(symbol.name);
    else byDir.set(dir, new Set([symbol.name]));
  }

  const dirs = [...byDir.entries()].filter(([, names]) => names.size >= 8);
  const parallel = new Set<string>();

  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      const [dirA, namesA] = dirs[i];
      const [dirB, namesB] = dirs[j];
      const shared = [...namesA].filter((n) => namesB.has(n)).length;
      const smaller = Math.min(namesA.size, namesB.size);
      if (shared >= 8 && shared / smaller >= 0.4) {
        parallel.add(pairKey(dirA, dirB));
      }
    }
  }
  return parallel;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Does this cluster straddle two directories that mirror each other? */
function spansParallelSurfaces(members: CodeSymbol[], parallelDirs: Set<string>): boolean {
  const dirs = [...new Set(members.map((m) => m.file.slice(0, m.file.lastIndexOf('/'))))];
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      if (parallelDirs.has(pairKey(dirs[i], dirs[j]))) return true;
    }
  }
  return false;
}

/**
 * Thin wrappers over one shared implementation: `head`, `options`, `delete`,
 * each a line that forwards to `request`.
 *
 * They resemble each other because that is the entire design — a named door
 * onto one function — and merging them would delete the public API.
 */
function isDelegating(members: CodeSymbol[], graph: CodeGraph): boolean {
  if (members.length < 2) return false;
  // Only a thin wrapper qualifies, measured on the normalised body rather than
  // on line count: a well-documented one-line forwarder runs to twenty lines of
  // which nineteen are docstring.
  if (members.some((m) => m.body.length > 240)) return false;

  const ids = new Set(members.map((m) => m.id));
  // Match on the callee's *name*, not its identity: `api.head` forwards to
  // `api.request` while `Session.head` forwards to `Session.request`. Those are
  // two symbols and one idea, and requiring identity missed the whole family.
  const targets = members.map((m) => {
    const names = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.from !== m.id || ids.has(edge.to)) continue;
      const target = graph.symbols.get(edge.to);
      if (target && target.kind !== 'module') names.add(target.name);
    }
    return names;
  });
  if (targets.some((t) => t.size === 0)) return false;

  const [first, ...rest] = targets;
  return [...first].some((candidate) => rest.every((t) => t.has(candidate)));
}

/**
 * One name, implemented once per file: `error` in sixty `locales/*.ts`, or a
 * driver per backend.
 *
 * Identical structure is the entire point of such a set, and the differing
 * content is the payload. Reporting zod's sixty translations as "redundant
 * re-implementation" at 98% confidence is the single fastest way to lose a
 * user's trust, so this is treated as structure, not redundancy.
 */
function isParallelSet(members: CodeSymbol[]): boolean {
  if (members.length < 3) return false;

  const names = new Map<string, number>();
  for (const member of members) names.set(member.name, (names.get(member.name) ?? 0) + 1);
  const commonest = Math.max(...names.values());

  // One name implemented once per class is polymorphism: each subclass must
  // provide its own `_parse`, and that is the design rather than a repetition
  // anyone introduced by accident.
  const containers = new Set(members.map((m) => m.id.split('#')[1].split('.').slice(0, -1).join('.')));
  if (commonest >= 3 && containers.size >= 3) return true;

  const files = new Set(members.map((m) => m.file));
  // One implementation per file, or close to it.
  if (files.size < members.length * 0.7) return false;
  if (commonest >= 3) return true;

  // Sibling files under one directory implementing the same small vocabulary is
  // the same shape: `adapters/postgres.ts`, `adapters/mysql.ts`, and so on.
  const directories = new Set([...files].map((f) => f.slice(0, f.lastIndexOf('/'))));
  return directories.size === 1 && files.size >= 4;
}

/**
 * A deliberate naming family: `formatRfc850Date` and `formatAsctimeDate`, or
 * `parseJson` and `parseYaml`.
 *
 * Names that share most of their words are a set someone designed, where the
 * differing word *is* the point. That is the opposite of the case this tool
 * exists for — three names with nothing in common doing one job, each written
 * by someone who could not find the others.
 */
function isNamingFamily(group: DupeCluster): boolean {
  const wordSets = group.members.map((m) => new Set(splitIdentifier(m.name)));
  for (let i = 0; i < wordSets.length; i++) {
    for (let j = i + 1; j < wordSets.length; j++) {
      const a = wordSets[i];
      const b = wordSets[j];
      const shared = [...a].filter((w) => b.has(w)).length;
      const smaller = Math.min(a.size, b.size);
      // Most of the shorter name is shared, and something still differs.
      if (smaller > 0 && shared >= 2 && shared / smaller >= 0.5 && shared < Math.max(a.size, b.size)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Accidental duplication comes in twos and threes: someone could not find the
 * first one, so they wrote a second. Twenty-seven copies is not an accident —
 * it is a pattern somebody chose, and no human is going to merge twenty-seven
 * functions off the back of a report.
 */
const ACTIONABLE_CLUSTER = 4;

function rankScore(group: DupeCluster): number {
  let score = group.similarity;
  // One implementation per file is structure, not redundancy.
  if (group.parallelSet) score -= 0.6;
  // Named doors onto one shared function: merging them deletes the API.
  if (group.delegating) score -= 0.5;
  // Benchmarks, fixtures and examples repeat themselves on purpose, to compare
  // variants. Real, and not work anyone is going to do.
  if (group.members.every((m) => !isProductionCode(m.file))) score -= 0.3;
  // Past a handful, confidence falls away with size.
  if (group.members.length > ACTIONABLE_CLUSTER) {
    score -= Math.min(0.5, 0.08 * (group.members.length - ACTIONABLE_CLUSTER));
  }
  // Same file, adjacent: usually deliberate overloads a reader can already see.
  if (!group.crossFile) score -= 0.15;
  // One calls the other, so it is layering rather than redundancy.
  if (group.connected) score -= 0.4;
  // A designed set of variants, where the differing word is the whole point.
  if (isNamingFamily(group)) score -= 0.35;
  // More copies is stronger evidence that nobody knew the others existed.
  if (group.members.length > 2) score += 0.05;
  return Math.max(0.05, Math.min(1, Math.round(score * 100) / 100));
}

/** Name the cluster without listing sixty symbols in a heading. */
function titleOf(group: DupeCluster): string {
  const unique = [...new Set(group.members.map((m) => m.name))];
  const shown = unique.slice(0, 3).join(', ');
  const rest = unique.length - 3;
  const names = rest > 0 ? `${shown} and ${rest} more` : shown;

  if (group.parallelSet) {
    return `${group.members.length} parallel implementations of ${names}`;
  }
  return `${group.members.length} implementations of the same thing: ${names}`;
}

function describe(group: DupeCluster): string {
  const shown = group.members.slice(0, 6).map((m) => `${m.file}:${m.line}`);
  const where =
    group.members.length > 6
      ? `${shown.join(', ')} and ${group.members.length - 6} more`
      : shown.join(', ');
  const parts = [
    `${group.members.length} symbols share ${(group.similarity * 100).toFixed(0)}% similarity: ${where}.`,
  ];
  if (group.delegating) {
    parts.push(
      'Each one forwards to the same underlying function, so these are named ' +
        'entry points onto one implementation rather than repeated work.',
    );
  } else if (group.parallelSet) {
    parts.push(
      'A deliberate parallel set — translations, adapters, drivers, or two API ' +
        'surfaces over one idea — where matching structure is the design rather than a repetition.',
    );
  } else if (group.connected) {
    parts.push('One of them calls another, so this may be deliberate delegation rather than duplication.');
  } else if (isNamingFamily(group)) {
    parts.push('Their names share most of their words, so these may be a deliberate set of variants rather than redundant re-implementations.');
  } else if (group.crossFile) {
    parts.push('They live in different files and none calls another, so each was likely written without knowledge of the others.');
  } else {
    parts.push('They live in the same file.');
  }
  return parts.join(' ');
}
