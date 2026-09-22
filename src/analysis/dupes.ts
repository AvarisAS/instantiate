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
    // Every Error subclass constructor is `super(message); this.name = '...'`.
    // They are near-identical because the language requires it, not because
    // anyone re-implemented anything, so they are not candidates at all.
    if (symbol.name === 'constructor') continue;
    candidates.push({
      symbol,
      structure: structuralBag(symbol.body),
      vocabulary: vocabularyBag(symbol.name, symbol.body),
    });
  }

  const threshold = calibrate(candidates, config);
  const pairs = scorePairs(candidates, threshold);
  const clusters = cluster(pairs, candidates, graph);

  const findings: Finding[] = [];
  let duplicateLoc = 0;

  for (const group of clusters) {
    // The smallest member is what you would keep; the rest is what you would remove.
    const removable = group.members
      .slice()
      .sort((a, b) => a.loc - b.loc)
      .slice(1)
      .reduce((sum, s) => sum + s.loc, 0);

    const names = group.members.map((m) => m.name);
    const score = rankScore(group);
    if (score >= METRIC_CONFIDENCE_FLOOR) duplicateLoc += removable;
    findings.push({
      id: `duplicate:${group.members.map((m) => m.id).join('|')}`,
      kind: 'duplicate',
      severity: removable >= 40 ? 'high' : removable >= 12 ? 'medium' : 'low',
      title: `${group.members.length} implementations of the same thing: ${names.join(', ')}`,
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
  return (
    STRUCTURE_WEIGHT * cosine(a.structure, b.structure) +
    (1 - STRUCTURE_WEIGHT) * cosine(a.vocabulary, b.vocabulary)
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
        const score = similarity(candidates[a], candidates[b]);
        if (score >= threshold) pairs.push({ a, b, score });
      }
    }
  }
  return pairs;
}

/** Union-find over the surviving pairs: a cluster is a connected component. */
function cluster(pairs: Pair[], candidates: Candidate[], graph: CodeGraph): DupeCluster[] {
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
    });
  }

  return out;
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

function rankScore(group: DupeCluster): number {
  let score = group.similarity;
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

function describe(group: DupeCluster): string {
  const where = group.members.map((m) => `${m.file}:${m.line}`).join(', ');
  const parts = [
    `${group.members.length} symbols share ${(group.similarity * 100).toFixed(0)}% similarity: ${where}.`,
  ];
  if (group.connected) {
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
