import type { CodeGraph, Concept, CodeSymbol } from '../types.js';
import { splitIdentifier } from './similarity.js';

/**
 * Collapse the graph into a small number of named concepts.
 *
 * A node-link picture of 50,000 symbols is a hairball nobody reads. Thirty
 * labelled bubbles is the only whole-codebase view that survives scale, so the
 * job here is to get from one to the other honestly.
 */
export function findConcepts(graph: CodeGraph, target: number): Concept[] {
  const ids = [...graph.symbols.keys()];
  if (ids.length === 0) return [];

  const index = new Map(ids.map((id, i) => [id, i]));
  const neighbours: number[][] = ids.map(() => []);

  for (const edge of graph.edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    neighbours[from].push(to);
    neighbours[to].push(from);
  }

  // Seed each symbol with its directory. Folder structure is a real signal about
  // intent, and it stops label propagation from drifting into nonsense on the
  // sparse parts of the graph.
  const directories = new Map<string, number>();
  const labels = ids.map((id) => {
    const dir = dirOf(graph.symbols.get(id)!.file);
    let label = directories.get(dir);
    if (label === undefined) {
      label = directories.size;
      directories.set(dir, label);
    }
    return label;
  });

  // Label propagation: adopt whichever label most of your neighbours carry.
  // Deterministic order, so two runs on the same code give the same map.
  for (let pass = 0; pass < 12; pass++) {
    let changed = 0;
    for (let i = 0; i < ids.length; i++) {
      const tally = new Map<number, number>();
      for (const n of neighbours[i]) tally.set(labels[n], (tally.get(labels[n]) ?? 0) + 1);
      // Keep a light pull towards the seed so isolated nodes stay with their folder.
      tally.set(labels[i], (tally.get(labels[i]) ?? 0) + 0.5);
      let best = labels[i];
      let bestCount = -1;
      for (const [label, count] of [...tally].sort((a, b) => a[0] - b[0])) {
        if (count > bestCount) {
          best = label;
          bestCount = count;
        }
      }
      if (best !== labels[i]) {
        labels[i] = best;
        changed++;
      }
    }
    if (changed === 0) break;
  }

  const groups = new Map<number, string[]>();
  for (let i = 0; i < ids.length; i++) {
    const list = groups.get(labels[i]);
    if (list) list.push(ids[i]);
    else groups.set(labels[i], [ids[i]]);
  }

  let concepts = [...groups.values()].map((symbolIds, i) => build(i, symbolIds, graph));
  concepts.sort((a, b) => b.loc - a.loc);

  // Too many clusters is as unreadable as too few. Fold the tail into one bucket
  // rather than pretending a map with 200 bubbles helps anybody.
  if (concepts.length > target) {
    const kept = concepts.slice(0, target - 1);
    const tail = concepts.slice(target - 1);
    kept.push({
      id: target - 1,
      name: 'Everything else',
      description: `${tail.length} small groups too scattered to name, totalling ${tail.reduce((s, c) => s + c.loc, 0)} lines.`,
      symbols: tail.flatMap((c) => c.symbols),
      loc: tail.reduce((s, c) => s + c.loc, 0),
      couples: [],
    });
    concepts = kept;
  }

  concepts.forEach((c, i) => (c.id = i));
  assignCoupling(concepts, graph);
  for (const concept of concepts) {
    for (const id of concept.symbols) {
      const symbol = graph.symbols.get(id);
      if (symbol) symbol.conceptId = concept.id;
    }
  }
  return concepts;
}

function dirOf(file: string): string {
  const i = file.lastIndexOf('/');
  return i === -1 ? '.' : file.slice(0, i);
}

function build(id: number, symbolIds: string[], graph: CodeGraph): Concept {
  const symbols = symbolIds.map((s) => graph.symbols.get(s)!).filter(Boolean);
  return {
    id,
    name: nameOf(symbols),
    description: describe(symbols),
    symbols: symbolIds,
    loc: symbols.reduce((sum, s) => sum + s.loc, 0),
    couples: [],
  };
}

/** Name a cluster from the words its symbols actually use, not from its folder. */
function nameOf(symbols: CodeSymbol[]): string {
  const tally = new Map<string, number>();
  for (const symbol of symbols) {
    // Weight by size: a 200-line function says more about the cluster than a getter.
    const weight = Math.log2(symbol.loc + 2);
    for (const word of splitIdentifier(symbol.name)) {
      tally.set(word, (tally.get(word) ?? 0) + weight);
    }
  }
  const top = [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([word]) => word);

  if (top.length === 0) return dirOf(symbols[0]?.file ?? '.');
  return top.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function describe(symbols: CodeSymbol[]): string {
  const files = new Set(symbols.map((s) => s.file));
  const exported = symbols.filter((s) => s.exported).length;
  return `${symbols.length} symbols across ${files.size} file${files.size === 1 ? '' : 's'}, ${exported} exported.`;
}

function assignCoupling(concepts: Concept[], graph: CodeGraph): void {
  const owner = new Map<string, number>();
  for (const concept of concepts) {
    for (const id of concept.symbols) owner.set(id, concept.id);
  }

  const weights = new Map<string, number>();
  for (const edge of graph.edges) {
    const from = owner.get(edge.from);
    const to = owner.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}>${to}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }

  for (const [key, weight] of weights) {
    const [from, to] = key.split('>').map(Number);
    concepts[from]?.couples.push({ to, weight });
  }
  for (const concept of concepts) {
    concept.couples.sort((a, b) => b.weight - a.weight);
  }
}
