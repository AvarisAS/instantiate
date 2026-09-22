import type { CodeGraph, CodeSymbol, Edge } from '../types.js';
import type { IntentRecord } from '../types.js';
import { IntentStore } from '../intent/store.js';

/**
 * One symbol, with everything that points at it and everything it reaches.
 *
 * Both the terminal `why` command and the MCP `find_symbol` tool need exactly
 * this; only the rendering differs. Keeping the lookup in one place is the fix
 * the duplicate detector asked for when it found the two copies.
 */
export interface SymbolContext {
  symbol: CodeSymbol;
  intent?: IntentRecord;
  callers: Edge[];
  reaches: CodeSymbol[];
  /** Nothing calls it and nothing outside can: a deletion candidate. */
  orphaned: boolean;
}

export interface LookupResult {
  contexts: SymbolContext[];
  /** Populated instead of `contexts` when the name did not match exactly. */
  suggestions: CodeSymbol[];
}

export function lookup(graph: CodeGraph, query: string, root: string): LookupResult {
  const matches = [...graph.symbols.values()].filter(
    (s) => s.id === query || s.name === query || s.name.toLowerCase() === query.toLowerCase(),
  );

  if (matches.length === 0) {
    return {
      contexts: [],
      suggestions: [...graph.symbols.values()]
        .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 8),
    };
  }

  const intents = new IntentStore(root);
  const contexts = matches.map((symbol) => {
    const callers = graph.edges.filter((e) => e.to === symbol.id);
    const reaches = dedupe(
      graph.edges
        .filter((e) => e.from === symbol.id)
        .map((e) => graph.symbols.get(e.to))
        .filter((s): s is CodeSymbol => !!s),
    );
    return {
      symbol,
      intent: intents.get(symbol.id),
      callers,
      reaches,
      orphaned: callers.length === 0 && !symbol.exported,
    };
  });

  return { contexts, suggestions: [] };
}

function dedupe(symbols: CodeSymbol[]): CodeSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

/** Distinct callers, since one function may reference another many times. */
export function uniqueCallers(context: SymbolContext, graph: CodeGraph): Array<{ symbol: CodeSymbol; line: number; file: string }> {
  const seen = new Set<string>();
  const out: Array<{ symbol: CodeSymbol; line: number; file: string }> = [];
  for (const edge of context.callers) {
    if (seen.has(edge.from)) continue;
    seen.add(edge.from);
    const symbol = graph.symbols.get(edge.from);
    if (symbol) out.push({ symbol, line: edge.line, file: edge.file });
  }
  return out;
}
