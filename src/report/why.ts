import type { CodeGraph, CodeSymbol } from '../types.js';
import { bold, dim, cyan, yellow, green } from '../util/term.js';
import { IntentStore } from '../intent/store.js';

/**
 * Blast radius for one symbol: declared here, called from there, reaching that.
 *
 * Strictly one hop. The failure mode of every code visualiser is lateral
 * wandering — you follow a node, get a fresh graph, and lose where you were.
 */
export function renderWhy(graph: CodeGraph, query: string, root: string): string {
  const matches = [...graph.symbols.values()].filter(
    (s) => s.name === query || s.id === query || s.name.toLowerCase() === query.toLowerCase(),
  );

  if (matches.length === 0) {
    const near = [...graph.symbols.values()]
      .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 8);
    if (near.length === 0) return `\nNo symbol named ${bold(query)}.\n`;
    return `\nNo exact match for ${bold(query)}. Did you mean:\n${near.map((s) => `  ${cyan(s.name)} ${dim(`${s.file}:${s.line}`)}`).join('\n')}\n`;
  }

  const intents = new IntentStore(root);
  const out: string[] = [];

  for (const symbol of matches) {
    out.push('');
    out.push(`${bold(symbol.name)} ${dim(`· ${symbol.kind}${symbol.exported ? ' · exported' : ''}`)}`);
    out.push(`${dim('declared')}  ${cyan(`${symbol.file}:${symbol.line}`)} ${dim(`(${symbol.loc} lines)`)}`);

    const intent = intents.get(symbol.id);
    if (intent) {
      const badge = intent.status === 'confirmed' ? green('confirmed') : yellow('draft');
      out.push(`${dim('intent')}    ${intent.purpose} ${dim(`[${badge}]`)}`);
      if (intent.notFor) out.push(`${dim('not for')}   ${intent.notFor}`);
    }

    const callers = graph.edges.filter((e) => e.to === symbol.id);
    const callees = graph.edges.filter((e) => e.from === symbol.id);

    out.push('');
    out.push(section('called from', callers.map((e) => ({ id: e.from, file: e.file, line: e.line, kind: e.kind })), graph));
    out.push(section('reaches', dedupe(callees.map((e) => ({ id: e.to, file: e.file, line: e.line, kind: e.kind }))), graph));

    if (callers.length === 0 && !symbol.exported) {
      out.push(`  ${yellow('!')} Nothing calls this and it is not exported. It is a deletion candidate.`);
      out.push('');
    }
  }

  return out.join('\n');
}

interface Ref {
  id: string;
  file: string;
  line: number;
  kind: string;
}

function dedupe(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

function section(label: string, refs: Ref[], graph: CodeGraph): string {
  if (refs.length === 0) return `  ${dim(label.padEnd(12))} ${dim('nothing')}\n`;

  const lines = [`  ${bold(label)} ${dim(`(${refs.length})`)}`];
  const grouped = new Map<string, Ref[]>();
  for (const ref of refs) {
    const list = grouped.get(ref.file);
    if (list) list.push(ref);
    else grouped.set(ref.file, [ref]);
  }

  for (const [file, group] of [...grouped].slice(0, 12)) {
    const names = dedupe(group)
      .map((r) => shortName(graph.symbols.get(r.id), r.id))
      .join(', ');
    lines.push(`    ${cyan(`${file}:${group[0].line}`)} ${dim(names)}`);
  }
  if (grouped.size > 12) lines.push(`    ${dim(`… and ${grouped.size - 12} more files`)}`);

  return `${lines.join('\n')}\n`;
}

function shortName(symbol: CodeSymbol | undefined, fallback: string): string {
  return symbol ? symbol.name : fallback.split('#')[1] ?? fallback;
}
