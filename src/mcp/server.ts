import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { scan, type ScanResult } from '../api.js';
import { IntentStore } from '../intent/store.js';
import { vocabularyBag, cosine, splitIdentifier } from '../analysis/similarity.js';
import { lookup, uniqueCallers } from '../index/lookup.js';
import type { CodeSymbol } from '../types.js';

/**
 * The graph, served to coding agents.
 *
 * Reporting duplicates after they are written is hygiene. This is the half that
 * prevents them: an agent that can ask "does anything already do this?" before
 * writing gets an answer from the graph instead of guessing, and the fourth
 * `formatDuration` is never born.
 */

const TOOLS: Tool[] = [
  {
    name: 'check_before_writing',
    description:
      'Call this BEFORE writing any new function, helper, type or module. Describe what you ' +
      'are about to write, in plain words. Returns anything in the codebase that already ' +
      'does that job, so you extend or reuse it instead of adding a redundant implementation. ' +
      'This is the cheapest way to avoid duplicating code that already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'What the new code would do, e.g. "format a duration in milliseconds as a human-readable string".',
        },
        signature: {
          type: 'string',
          description: 'Optional: the shape you have in mind, e.g. "(ms: number) => string".',
        },
      },
      required: ['description'],
    },
  },
  {
    name: 'find_symbol',
    description:
      'Where a symbol is declared, everything that calls it, and everything it reaches. ' +
      'Use this instead of grepping across files to understand what a change would break.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Symbol name or full id.' } },
      required: ['name'],
    },
  },
  {
    name: 'blast_radius',
    description:
      'Everything that transitively depends on a symbol. Call this before changing or ' +
      'deleting something, to see what else is affected.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        depth: { type: 'number', description: 'Hops to follow. Default 2.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_concepts',
    description:
      'What this codebase is made of: the graph collapsed into a few dozen named groups. ' +
      'Use this to orient before working in an unfamiliar area.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_findings',
    description:
      'Current dead code, duplicate clusters and convention drift, ranked. Use this to find ' +
      'the established convention in this codebase before adding code that picks a different one.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['all', 'dead', 'duplicate', 'drift'] },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_intent',
    description:
      'The recorded intent for a symbol: why it exists and what it is explicitly not for. ' +
      'Read this before changing something, so a change does not quietly contradict the ' +
      'reason the code was written.',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    },
  }
];

export async function runMcpServer(root: string): Promise<void> {
  const server = new Server(
    { name: 'instantiate', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // One scan on boot, refreshed lazily: an agent session asks many questions of
  // one codebase state, and re-indexing per call would make every answer slow.
  let cached: ScanResult | undefined;
  let scannedAt = 0;
  const MAX_AGE = 30_000;

  const current = (): ScanResult => {
    if (!cached || Date.now() - scannedAt > MAX_AGE) {
      cached = scan({ root });
      scannedAt = Date.now();
    }
    return cached;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = handle(request.params.name, args, current(), root);
      return { content: [{ type: 'text' as const, text }] };
    } catch (error) {
      return {
        content: [
          { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
        ],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());

  // connect() resolves as soon as the transport is wired up, so returning here
  // would let the CLI exit and kill the server before it answers anything.
  // Stay alive until the client closes stdin, which is how an MCP host stops us.
  await new Promise<void>((resolve) => {
    process.stdin.on('close', resolve);
    process.stdin.on('end', resolve);
    server.onclose = resolve;
  });
}

function handle(
  name: string,
  args: Record<string, unknown>,
  result: ScanResult,
  root: string,
): string {
  switch (name) {
    case 'check_before_writing':
      return checkBeforeWriting(String(args.description ?? ''), result, root);
    case 'find_symbol':
      return findSymbol(String(args.name ?? ''), result, root);
    case 'blast_radius':
      return blastRadius(String(args.name ?? ''), Number(args.depth ?? 2), result);
    case 'list_concepts':
      return listConcepts(result);
    case 'list_findings':
      return listFindings(String(args.kind ?? 'all'), Number(args.limit ?? 15), result);
    case 'get_intent':
      return getIntent(String(args.symbol ?? ''), root);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function checkBeforeWriting(description: string, result: ScanResult, root: string): string {
  if (!description.trim()) return 'Describe what the new code would do.';

  // Score the description against every function the same way duplicates are
  // scored against each other, so "already exists" means the same thing here as
  // it does in a finding.
  const wanted = vocabularyBag('', description);
  const scored: Array<{ symbol: CodeSymbol; score: number }> = [];

  for (const symbol of result.graph.symbols.values()) {
    if (symbol.kind !== 'function' && symbol.kind !== 'method') continue;
    const nameWords = new Set(splitIdentifier(symbol.name));
    const asked = new Set(splitIdentifier(description));
    const nameOverlap = [...nameWords].filter((w) => asked.has(w)).length;
    const score =
      0.7 * cosine(wanted, vocabularyBag(symbol.name, symbol.body)) +
      0.3 * (nameOverlap / Math.max(nameWords.size, 1));
    if (score > 0.15) scored.push({ symbol, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);

  if (top.length === 0 || top[0].score < 0.3) {
    return (
      'Nothing in this codebase appears to do that already. Safe to write it.\n\n' +
      'When you do, put it where the concept lives — run list_concepts if unsure.'
    );
  }

  const intents = new IntentStore(root);
  const lines = [
    `${top.length} existing implementation${top.length === 1 ? '' : 's'} may already do this. ` +
      'Reuse or extend before writing anything new.\n',
  ];

  for (const { symbol, score } of top) {
    lines.push(`${symbol.name}  (${Math.round(score * 100)}% match)`);
    lines.push(`  ${symbol.file}:${symbol.line} · ${symbol.kind} · ${symbol.loc} lines`);
    lines.push(`  signature: ${symbol.signature}`);
    const intent = intents.get(symbol.id);
    if (intent) {
      lines.push(`  intent: ${intent.purpose}`);
      if (intent.notFor) lines.push(`  not for: ${intent.notFor}`);
    }
    lines.push('');
  }

  lines.push('If none of these fits, say why in the new symbol\'s intent record.');
  return lines.join('\n');
}

function findSymbol(query: string, result: ScanResult, root: string): string {
  const { contexts, suggestions } = lookup(result.graph, query, root);

  if (contexts.length === 0) {
    return suggestions.length === 0
      ? `No symbol named ${query}.`
      : `No exact match. Similar: ${suggestions.map((s) => `${s.name} (${s.file}:${s.line})`).join(', ')}`;
  }

  const lines: string[] = [];
  for (const context of contexts) {
    const { symbol, intent } = context;
    lines.push(`${symbol.name} · ${symbol.kind}${symbol.exported ? ' · exported' : ''}`);
    lines.push(`declared at ${symbol.file}:${symbol.line}-${symbol.endLine}`);
    lines.push(`signature ${symbol.signature}`);
    if (intent) {
      lines.push(`intent ${intent.purpose}${intent.notFor ? ` | not for: ${intent.notFor}` : ''}`);
    }

    const callers = uniqueCallers(context, result.graph);
    lines.push(`\ncalled from (${callers.length}):`);
    for (const caller of callers.slice(0, 20)) {
      lines.push(`  ${caller.symbol.name} — ${caller.file}:${caller.line}`);
    }

    lines.push(`\nreaches (${context.reaches.length}):`);
    for (const reached of context.reaches.slice(0, 20)) {
      lines.push(`  ${reached.name} — ${reached.file}:${reached.line}`);
    }

    if (context.orphaned) {
      lines.push('\nNothing calls this and it is not exported: it is a deletion candidate.');
    }
    lines.push('');
  }
  return lines.join('\n');
}

function blastRadius(query: string, depth: number, result: ScanResult): string {
  const start = [...result.graph.symbols.values()].find((s) => s.name === query || s.id === query);
  if (!start) return `No symbol named ${query}.`;

  const incoming = new Map<string, string[]>();
  for (const edge of result.graph.edges) {
    const list = incoming.get(edge.to);
    if (list) list.push(edge.from);
    else incoming.set(edge.to, [edge.from]);
  }

  const seen = new Set([start.id]);
  let frontier = [start.id];
  const levels: string[][] = [];

  for (let hop = 0; hop < Math.max(1, Math.min(depth, 5)); hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const caller of incoming.get(id) ?? []) {
        if (!seen.has(caller)) {
          seen.add(caller);
          next.push(caller);
        }
      }
    }
    if (next.length === 0) break;
    levels.push(next);
    frontier = next;
  }

  if (levels.length === 0) return `Nothing depends on ${start.name}. Changing it affects nothing else.`;

  const lines = [
    `${seen.size - 1} symbol${seen.size === 2 ? '' : 's'} depend${seen.size === 2 ? 's' : ''} on ${start.name} (${start.file}:${start.line}).`,
    'Changing its behaviour changes theirs.\n',
  ];
  levels.forEach((level, hop) => {
    lines.push(`${hop + 1} hop${hop === 0 ? '' : 's'} away (${level.length}):`);
    for (const id of level.slice(0, 25)) {
      const symbol = result.graph.symbols.get(id);
      if (symbol) lines.push(`  ${symbol.name} — ${symbol.file}:${symbol.line}`);
    }
    if (level.length > 25) lines.push(`  … and ${level.length - 25} more`);
    lines.push('');
  });
  return lines.join('\n');
}

function listConcepts(result: ScanResult): string {
  if (result.concepts.length === 0) return 'Nothing indexed.';
  const lines = [`${result.concepts.length} concepts, largest first.\n`];
  for (const concept of result.concepts) {
    const couples = concept.couples
      .slice(0, 3)
      .map((c) => result.concepts[c.to]?.name)
      .filter(Boolean);
    lines.push(`${concept.name} — ${concept.loc} lines. ${concept.description}`);
    if (couples.length > 0) lines.push(`  depends on: ${couples.join(', ')}`);
    const files = [...new Set(concept.symbols.map((s) => s.split('#')[0]))].slice(0, 5);
    lines.push(`  files: ${files.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

function listFindings(kind: string, limit: number, result: ScanResult): string {
  const wanted = kind === 'dupes' ? 'duplicate' : kind;
  const list = (wanted === 'all' ? result.findings : result.findings.filter((f) => f.kind === wanted)).slice(
    0,
    Math.max(1, Math.min(limit, 50)),
  );
  if (list.length === 0) return 'No findings.';

  const lines: string[] = [];
  for (const finding of list) {
    lines.push(`[${finding.severity}] ${finding.title}`);
    lines.push(`  ${finding.file}:${finding.line} · ${finding.loc} lines · ${Math.round(finding.score * 100)}% confidence`);
    lines.push(`  ${finding.detail}`);
    lines.push('');
  }
  return lines.join('\n');
}

function getIntent(symbol: string, root: string): string {
  const store = new IntentStore(root);
  const record = store.get(symbol) ?? store.search(symbol, 1)[0];
  if (!record) {
    return (
      `No recorded intent for ${symbol}.\n\n` +
      'That is itself worth knowing: nobody has written down why this exists, so ' +
      'any assumption about its purpose is a guess. Read its callers before changing it.'
    );
  }
  return [
    `${record.symbol} (${record.status})`,
    `purpose: ${record.purpose}`,
    `not for: ${record.notFor || '(unstated)'}`,
    record.status === 'draft'
      ? '\nThis is an unconfirmed draft, generated from the code. Treat it as a description, not as intent.'
      : '',
  ].join('\n');
}
