import type { CodeGraph } from '../types.js';
import { bold, dim, cyan, yellow, green } from '../util/term.js';
import { lookup, uniqueCallers, type SymbolContext } from '../index/lookup.js';

/**
 * Blast radius for one symbol: declared here, called from there, reaching that.
 *
 * Strictly one hop. The failure mode of every code visualiser is lateral
 * wandering — you follow a node, get a fresh graph, and lose where you were.
 */
export function renderWhy(graph: CodeGraph, query: string, root: string): string {
  const { contexts, suggestions } = lookup(graph, query, root);

  if (contexts.length === 0) {
    if (suggestions.length === 0) return `\nNo symbol named ${bold(query)}.\n`;
    const list = suggestions
      .map((s) => `  ${cyan(s.name)} ${dim(`${s.file}:${s.line}`)}`)
      .join('\n');
    return `\nNo exact match for ${bold(query)}. Did you mean:\n${list}\n`;
  }

  return contexts.map((context) => renderOne(context, graph)).join('\n');
}

function renderOne(context: SymbolContext, graph: CodeGraph): string {
  const { symbol, intent } = context;
  const out: string[] = [''];

  out.push(`${bold(symbol.name)} ${dim(`· ${symbol.kind}${symbol.exported ? ' · exported' : ''}`)}`);
  out.push(`${dim('declared')}  ${cyan(`${symbol.file}:${symbol.line}`)} ${dim(`(${symbol.loc} lines)`)}`);

  if (intent) {
    const badge = intent.status === 'confirmed' ? green('confirmed') : yellow('draft');
    out.push(`${dim('intent')}    ${intent.purpose} ${dim(`[${badge}]`)}`);
    if (intent.notFor) out.push(`${dim('not for')}   ${intent.notFor}`);
  }

  out.push('');
  out.push(
    section(
      'used by',
      uniqueCallers(context, graph).map((c) => ({ name: c.symbol.name, file: c.file, line: c.line })),
    ),
  );
  if (context.importedBy.length > 0) {
    // Importing is not using; a file may import a symbol and pass it straight on.
    out.push(
      `  ${bold('imported by')} ${dim(`(${context.importedBy.length})`)}\n` +
        `    ${dim(context.importedBy.slice(0, 6).join(', '))}` +
        (context.importedBy.length > 6 ? dim(` and ${context.importedBy.length - 6} more`) : '') +
        '\n',
    );
  }
  out.push(
    section(
      'reaches',
      context.reaches.map((s) => ({ name: s.name, file: s.file, line: s.line })),
    ),
  );

  if (context.orphaned) {
    out.push(`  ${yellow('!')} Nothing calls this and it is not exported. It is a deletion candidate.`);
    out.push('');
  }

  return out.join('\n');
}

interface Ref {
  name: string;
  file: string;
  line: number;
}

function section(label: string, refs: Ref[]): string {
  if (refs.length === 0) return `  ${dim(label.padEnd(12))} ${dim('nothing')}\n`;

  const grouped = new Map<string, Ref[]>();
  for (const ref of refs) {
    const list = grouped.get(ref.file);
    if (list) list.push(ref);
    else grouped.set(ref.file, [ref]);
  }

  // Count what is listed: rows are files, so a count of edges disagreed with
  // the list underneath it.
  const lines = [
    `  ${bold(label)} ${dim(`(${refs.length} in ${grouped.size} file${grouped.size === 1 ? '' : 's'})`)}`,
  ];

  for (const [file, group] of [...grouped].slice(0, 12)) {
    lines.push(`    ${cyan(`${file}:${group[0].line}`)} ${dim(group.map((r) => r.name).join(', '))}`);
  }
  if (grouped.size > 12) lines.push(`    ${dim(`… and ${grouped.size - 12} more files`)}`);

  return `${lines.join('\n')}\n`;
}
