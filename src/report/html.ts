import { basename } from 'node:path';
import type { ScanResult } from '../api.js';
import type { Finding } from '../types.js';
import { layout, treeFromPaths, type LaidOut } from './treemap.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snippet, type Snippet } from './snippets.js';

/**
 * A single self-contained HTML file.
 *
 * This is the format that travels: it gets attached to a PR, dropped in a
 * channel, opened by someone who will never install the CLI, and kept as a
 * record of what the repo looked like this month. A localhost UI is seen by one
 * person; a file is seen by ten.
 *
 * It is a worklist with pictures, not an atlas. Every screen ends in something
 * to do, because an atlas gets one appreciative look and never opens again.
 */
export function renderHtmlReport(result: ScanResult, findings: Finding[]): string {
  const shown = findings.slice(0, Math.max(result.config.maxFindings, 40));
  const data = buildData(result, shown);
  const title = basename(result.config.root) || 'codebase';

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — instantiate</title>
<style>${STYLE}</style>
</head>
<body>
<div id="app"></div>
<script id="data" type="application/json">${escapeJson(JSON.stringify(data))}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

interface ReportData {
  title: string;
  generatedAt: string;
  stats: ScanResult['stats'];
  warnings: string[];
  treemap: SerialisedBox[];
  files: FileEntry[];
  findings: Array<Finding & { snippets: Snippet[] }>;
  fileFindings: Record<string, string[]>;
}

interface Ref {
  file: string;
  line: number;
  name: string;
}

interface SymbolEntry {
  id: string;
  name: string;
  kind: string;
  line: number;
  loc: number;
  exported: boolean;
  /** Where this is used, and what it reaches. Both capped; counts are exact. */
  usedBy: Ref[];
  usedByCount: number;
  reaches: Ref[];
  reachesCount: number;
  findings: string[];
}

interface LineMark {
  from: number;
  to: number;
  severity: string;
  finding: string;
}

interface FileEntry {
  path: string;
  loc: number;
  symbols: SymbolEntry[];
  findings: string[];
  /** The file's real source, for the code pane. Absent when too large to embed. */
  source?: string[];
  /** Line ranges implicated in a finding, for highlighting. */
  marks: LineMark[];
}

interface SerialisedBox {
  name: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  leaf: boolean;
  heat: number;
  value: number;
  findings: number;
}

const TREEMAP_WIDTH = 1000;
const TREEMAP_HEIGHT = 560;

function buildData(result: ScanResult, findings: Finding[]): ReportData {
  const perFile = new Map<string, { loc: number; findings: string[]; weight: number }>();
  for (const [path, record] of result.graph.files) {
    perFile.set(path, { loc: record.loc, findings: [], weight: 0 });
  }
  for (const finding of result.findings) {
    const files = new Set([finding.file, ...finding.symbols.map((s) => s.split('#')[0])]);
    for (const file of files) {
      const entry = perFile.get(file);
      if (!entry) continue;
      entry.findings.push(finding.id);
      entry.weight += finding.loc * finding.score;
    }
  }

  const tree = treeFromPaths(
    basename(result.config.root) || 'root',
    [...perFile.entries()].map(([path, entry]) => ({
      path,
      value: Math.max(entry.loc, 1),
      // Heat is the share of a file implicated in findings, so a small bad file
      // still shows, and a large file is not punished for its size alone.
      heat: Math.min(1, entry.weight / Math.max(entry.loc, 1)),
      findings: entry.findings.length,
    })),
  );

  const laid = layout(tree, { x: 0, y: 0, width: TREEMAP_WIDTH, height: TREEMAP_HEIGHT });
  const boxes: SerialisedBox[] = [];
  flatten(laid, boxes);

  return {
    title: basename(result.config.root) || 'codebase',
    generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    stats: result.stats,
    warnings: result.warnings,
    treemap: boxes,
    files: buildFileIndex(result, perFile),
    findings: findings.map((finding) => ({
      ...finding,
      snippets: snippetsFor(result, finding),
    })),
    fileFindings: Object.fromEntries(
      [...perFile.entries()].filter(([, e]) => e.findings.length > 0).map(([path, e]) => [path, e.findings]),
    ),
  };
}

/** Cap on how many call sites travel with each symbol; the count stays exact. */
const MAX_REFS = 25;

/**
 * Limits on embedded source.
 *
 * The code pane is the point of the page, so source ships with it rather than
 * being fetched — a report is read offline. But a repository can be large, and
 * a page nobody can open helps nobody, so very large files are skipped and,
 * past a total budget, only files with something wrong with them keep theirs.
 */
const MAX_FILE_LINES = 5000;
const SOURCE_BUDGET_BYTES = 9_000_000;

/**
 * Every file, with its symbols and where each one is used.
 *
 * This is what the page is actually for. A map of a codebase answers "what is
 * in here"; a developer's question is almost always "where does this live, who
 * calls it, and what is wrong with it" — which needs the tree, the symbol and
 * its call sites in one place, not a picture.
 */
function buildFileIndex(
  result: ScanResult,
  perFile: Map<string, { loc: number; findings: string[]; weight: number }>,
): FileEntry[] {
  const incoming = new Map<string, Ref[]>();
  const outgoing = new Map<string, Ref[]>();

  for (const edge of result.graph.edges) {
    const from = result.graph.symbols.get(edge.from);
    const to = result.graph.symbols.get(edge.to);
    if (!from || !to || from.id === to.id) continue;
    // A module symbol stands for an import, which is not a call site.
    if (from.kind === 'module') continue;

    const callers = incoming.get(edge.to) ?? [];
    if (!callers.some((r) => r.name === from.name && r.file === edge.file)) {
      callers.push({ file: edge.file, line: edge.line, name: from.name });
      incoming.set(edge.to, callers);
    }
    const callees = outgoing.get(edge.from) ?? [];
    if (!callees.some((r) => r.name === to.name && r.file === to.file)) {
      callees.push({ file: to.file, line: to.line, name: to.name });
      outgoing.set(edge.from, callees);
    }
  }

  const findingsBySymbol = new Map<string, string[]>();
  for (const finding of result.findings) {
    for (const id of finding.symbols) {
      const list = findingsBySymbol.get(id) ?? [];
      list.push(finding.id);
      findingsBySymbol.set(id, list);
    }
  }

  const byFile = new Map<string, SymbolEntry[]>();
  for (const symbol of result.graph.symbols.values()) {
    if (symbol.kind === 'module') continue;
    const usedBy = incoming.get(symbol.id) ?? [];
    const reaches = outgoing.get(symbol.id) ?? [];
    const entry: SymbolEntry = {
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      loc: symbol.loc,
      exported: symbol.exported,
      usedBy: usedBy.slice(0, MAX_REFS),
      usedByCount: usedBy.length,
      reaches: reaches.slice(0, MAX_REFS),
      reachesCount: reaches.length,
      findings: findingsBySymbol.get(symbol.id) ?? [],
    };
    const list = byFile.get(symbol.file) ?? [];
    list.push(entry);
    byFile.set(symbol.file, list);
  }

  const entries: FileEntry[] = [...perFile.entries()]
    .map(([path, entry]) => ({
      path,
      loc: entry.loc,
      findings: entry.findings,
      symbols: (byFile.get(path) ?? []).sort((a, b) => a.line - b.line),
      marks: [],
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  attachMarks(entries, result);
  attachSource(entries, result.config.root);
  return entries;
}

/**
 * Which lines a finding covers, so the code pane can colour them.
 *
 * A finding names symbols, and a symbol is a line range; that range is what a
 * reader needs shaded, not a single line they then have to search around.
 */
function attachMarks(entries: FileEntry[], result: ScanResult): void {
  const byPath = new Map(entries.map((e) => [e.path, e]));

  for (const finding of result.findings) {
    for (const id of finding.symbols) {
      const symbol = result.graph.symbols.get(id);
      const file = symbol ? byPath.get(symbol.file) : undefined;
      if (symbol && file) {
        file.marks.push({
          from: symbol.line,
          to: symbol.endLine,
          severity: finding.severity,
          finding: finding.id,
        });
        continue;
      }
      // A finding may point at module scope, where there is no symbol range.
      const path = id.split('#')[0];
      const fallback = byPath.get(path);
      if (fallback) {
        fallback.marks.push({
          from: finding.line,
          to: finding.line,
          severity: finding.severity,
          finding: finding.id,
        });
      }
    }

    // Drift and contradictions carry their own per-site locations.
    const sites = [
      ...((finding.evidence?.deviants ?? []) as Array<{ file: string; line: number }>),
      ...((finding.evidence?.variants ?? []) as Array<{ file: string; line: number }>),
    ];
    for (const site of sites) {
      const file = byPath.get(site.file);
      if (file) {
        file.marks.push({
          from: site.line,
          to: site.line,
          severity: finding.severity,
          finding: finding.id,
        });
      }
    }
  }
}

/** Read each file's real source, newest-severity-first within a size budget. */
function attachSource(entries: FileEntry[], root: string): void {
  // Files with findings get their source first: those are the ones a reader
  // opens, and if the budget runs out it should run out on the clean ones.
  const order = [...entries].sort((a, b) => b.findings.length - a.findings.length);
  let spent = 0;

  for (const entry of order) {
    if (spent > SOURCE_BUDGET_BYTES) break;
    let text: string;
    try {
      text = readFileSync(join(root, entry.path), 'utf8');
    } catch {
      continue;
    }
    if (text.length > 400_000) continue;
    const lines = text.split('\n');
    if (lines.length > MAX_FILE_LINES) continue;
    entry.source = lines;
    spent += text.length;
  }
}

function flatten(node: LaidOut, out: SerialisedBox[]): void {
  if (node.depth > 0) {
    out.push({
      name: node.name,
      path: node.path,
      x: round(node.x),
      y: round(node.y),
      w: round(node.width),
      h: round(node.height),
      depth: node.depth,
      leaf: !node.children || node.children.length === 0,
      heat: Number((node.heat ?? 0).toFixed(3)),
      value: node.value,
      findings: node.findings ?? 0,
    });
  }
  for (const child of node.children ?? []) flatten(child, out);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function snippetsFor(result: ScanResult, finding: Finding): Snippet[] {
  const root = result.config.root;

  if (finding.kind === 'duplicate') {
    const members = (finding.evidence?.members ?? []) as Array<{
      file: string;
      line: number;
      endLine: number;
    }>;
    // Side by side is the entire argument for a duplicate: two functions that
    // look the same next to each other need no explanation.
    return members
      .map((m) => snippet(root, m.file, m.line, m.endLine))
      .filter((s): s is Snippet => !!s);
  }

  if (finding.kind === 'contradiction') {
    const variants = (finding.evidence?.variants ?? []) as Array<{ file: string; line: number }>;
    return variants
      .slice(0, 6)
      .map((v) => snippet(root, v.file, Math.max(1, v.line), v.line + 8))
      .filter((s): s is Snippet => !!s);
  }

  if (finding.kind === 'drift') {
    const deviants = (finding.evidence?.deviants ?? []) as Array<{ file: string; line: number }>;
    return deviants
      .slice(0, 4)
      .map((d) => snippet(root, d.file, Math.max(1, d.line - 1), d.line + 6))
      .filter((s): s is Snippet => !!s);
  }

  const symbol = result.graph.symbols.get(finding.symbols[0]);
  const one = snippet(root, finding.file, finding.line, symbol?.endLine ?? finding.line + 12);
  return one ? [one] : [];
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** Keep embedded JSON from terminating the script block early. */
function escapeJson(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

const STYLE = `
/*
 * A report is read the way an instrument panel is read: severity first, then
 * scale, then the code. So severity is carried by shape as well as colour — a
 * stripe down the edge of every finding — and the semantic scale is kept
 * separate from the accent, which marks only what is interactive.
 *
 * No web fonts: a report is opened offline, attached to a mail, read on a
 * plane. A font that fails to load silently would take the typography with it.
 */
:root {
  /* Cool slate neutrals, biased very slightly towards the accent's blue. */
  --bg: #f7f8fa;
  --panel: #ffffff;
  --sunk: #eef0f4;
  --ink: #15181d;
  --ink-soft: #454b56;
  --muted: #6d737f;
  --line: #dde1e8;
  --line-strong: #c3c9d4;
  --accent: #1f5fa8;
  --accent-soft: #e8f0fa;
  /* Semantic, and deliberately not the accent. */
  --high: #a8321f;
  --medium: #8a6410;
  --low: #6d737f;
  --good: #1f6b46;
  --tint-high: color-mix(in srgb, var(--high) 9%, transparent);
  --tint-medium: color-mix(in srgb, var(--medium) 10%, transparent);
  --tint-low: color-mix(in srgb, var(--low) 7%, transparent);
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --step--1: 0.78rem;
  --step-0: 0.94rem;
  --step-1: 1.15rem;
  --step-2: 1.6rem;
  --step-3: 2.1rem;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #101216;
    --panel: #171a20;
    --sunk: #1e222a;
    --ink: #e9ecf1;
    --ink-soft: #b3bac6;
    --muted: #868d9b;
    --line: #272c35;
    --line-strong: #39404c;
    --accent: #6ba6e8;
    --accent-soft: #17222f;
    --high: #e0705a;
    --medium: #d2a03f;
    --low: #868d9b;
    --good: #5cb98a;
  }
}
:root[data-theme="dark"] {
  --bg: #101216;
  --panel: #171a20;
  --sunk: #1e222a;
  --ink: #e9ecf1;
  --ink-soft: #b3bac6;
  --muted: #868d9b;
  --line: #272c35;
  --line-strong: #39404c;
  --accent: #6ba6e8;
  --accent-soft: #17222f;
  --high: #e0705a;
  --medium: #d2a03f;
  --low: #868d9b;
  --good: #5cb98a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: var(--step-0);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
#app { max-width: 1120px; margin: 0 auto; padding-block: 40px 120px; padding-inline: 20px; }

h1 {
  font-size: var(--step-3); margin: 0 0 2px; letter-spacing: -0.025em;
  font-weight: 620; text-wrap: balance;
}
h2 {
  font-size: var(--step--1); text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--muted); font-weight: 650; margin: 60px 0 6px;
}
.sub { color: var(--muted); font-size: var(--step--1); margin: 0; font-variant-numeric: tabular-nums; }
.lede { color: var(--ink-soft); margin: 0 0 18px; max-width: 64ch; }

.headline { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1px;
            margin: 28px 0 4px; background: var(--line); border: 1px solid var(--line);
            border-radius: 12px; overflow: hidden; }
.tile { background: var(--panel); padding: 16px 18px; }
.tile .n { font-size: var(--step-2); font-weight: 600; letter-spacing: -0.03em;
           font-variant-numeric: tabular-nums; display: block; line-height: 1.1; }
.tile .l { font-size: var(--step--1); color: var(--muted); }
.tile.is-clean .n { color: var(--good); }
.tile.is-alert .n { color: var(--high); }

.warn { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--medium);
        border-radius: 8px; padding: 12px 16px; margin: 16px 0; color: var(--ink-soft); }

.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
         padding: 16px; overflow: hidden; }
svg { display: block; width: 100%; height: auto; }
.box { stroke: var(--panel); stroke-width: 1; cursor: pointer; }
.box:hover { stroke: var(--accent); stroke-width: 2; }
.box-label { font-family: var(--mono); font-size: 9px; fill: var(--ink-soft);
             pointer-events: none; opacity: 0.8; }
.dir-label { font-size: 10px; fill: var(--muted); pointer-events: none; font-weight: 650; }

/* Severity reads as a stripe before it reads as a word. */
.finding { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--low);
           border-radius: 8px; margin: 7px 0; overflow: hidden; }
.finding[data-severity="high"] { border-left-color: var(--high); }
.finding[data-severity="medium"] { border-left-color: var(--medium); }
.finding summary { padding: 12px 16px; cursor: pointer; display: flex; gap: 12px;
                   align-items: baseline; list-style: none; }
.finding summary::-webkit-details-marker { display: none; }
.finding summary:hover { background: var(--accent-soft); }
.finding summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.sev { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 700;
       flex: 0 0 auto; padding: 2px 7px; border-radius: 4px; background: var(--sunk); color: var(--low); }
.sev.high { color: var(--high); } .sev.medium { color: var(--medium); }
.f-title { flex: 1 1 auto; font-weight: 500; }
.f-meta { color: var(--muted); font-size: var(--step--1); font-variant-numeric: tabular-nums;
          font-family: var(--mono); flex: 0 0 auto; }
.f-body { padding: 0 16px 16px; border-top: 1px solid var(--line); }
.f-detail { color: var(--ink-soft); margin: 12px 0; max-width: 72ch; }

.snips { display: grid; gap: 10px; grid-template-columns: 1fr; }
.snips.side-by-side { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
pre { margin: 0; background: var(--sunk); border: 1px solid var(--line); border-radius: 6px;
      padding: 10px 12px; overflow-x: auto; font-family: var(--mono); font-size: 11.5px;
      line-height: 1.55; }
pre .ln { color: var(--muted); opacity: 0.6; user-select: none; display: inline-block;
          width: 3ch; text-align: right; margin-right: 10px; }
.snip-head { font-family: var(--mono); font-size: 11px; color: var(--muted); margin: 0 0 4px; }

.variants { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: var(--step--1); }
.variants th { text-align: left; font-weight: 650; color: var(--muted); font-size: 10px;
               text-transform: uppercase; letter-spacing: 0.07em; padding: 0 10px 6px 0; }
.variants td { padding: 6px 10px 6px 0; border-top: 1px solid var(--line);
               font-family: var(--mono); font-size: 12px; }
.variants code { background: color-mix(in srgb, var(--high) 12%, transparent);
                 padding: 1px 6px; border-radius: 4px; }

.bars { display: grid; gap: 5px; margin: 12px 0; }
.bar-row { display: grid; grid-template-columns: minmax(110px, 170px) 1fr 46px; gap: 10px;
           align-items: center; font-size: var(--step--1); }
.bar-track { height: 8px; background: var(--sunk); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 4px; }
.bar-row.minor .bar-fill { background: var(--medium); }
.bar-num { font-family: var(--mono); font-size: 11px; color: var(--muted); text-align: right;
           font-variant-numeric: tabular-nums; }

.filters { display: flex; gap: 6px; flex-wrap: wrap; margin: 16px 0 4px; }
.filters button { background: var(--panel); border: 1px solid var(--line); color: var(--ink-soft);
                  border-radius: 999px; padding: 5px 14px; font-size: var(--step--1); cursor: pointer;
                  font-family: inherit; }
.filters button:hover { border-color: var(--line-strong); }
.filters button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent);
                                       background: var(--accent-soft); }
.crumb { font-family: var(--mono); font-size: 12px; color: var(--muted); margin: 10px 0 0;
         min-height: 18px; }
.crumb button { background: none; border: none; color: var(--accent); cursor: pointer;
                font: inherit; padding: 0; text-decoration: underline; }
.legend { display: flex; gap: 16px; align-items: center; color: var(--muted);
          font-size: var(--step--1); margin-top: 10px; flex-wrap: wrap; }
.swatch { display: inline-block; width: 11px; height: 11px; border-radius: 3px;
          vertical-align: -1px; margin-right: 6px; border: 1px solid var(--line); }

/* The three panes ---------------------------------------------------------
 *
 * Tree, symbols, source. Severity is carried by the row itself rather than by
 * a bullet beside it, so a glance down the tree reads as a heat profile of the
 * codebase; the source pane shades the exact lines to act on, in place.
 */
.ide { border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
       background: var(--panel); }
.ide-bar { display: flex; gap: 12px; align-items: center; padding: 10px 12px;
           border-bottom: 1px solid var(--line); background: var(--sunk); }
.ex-search { flex: 1 1 auto; min-width: 0; font: inherit; font-size: var(--step--1);
             padding: 7px 11px; border-radius: 7px; border: 1px solid var(--line-strong);
             background: var(--panel); color: var(--ink); }
.ex-search:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ex-count { color: var(--muted); font-size: var(--step--1); font-variant-numeric: tabular-nums;
            flex: 0 0 auto; }

.ide-panes { display: grid; grid-template-columns: minmax(180px, 240px) minmax(200px, 280px) 1fr;
             height: 640px; }
.ide-tree, .ide-symbols { border-right: 1px solid var(--line); display: flex;
                          flex-direction: column; min-width: 0; }
.ide-tree { overflow: auto; padding: 8px 0; }
.ide-code { display: flex; flex-direction: column; min-width: 0; }
.pane-scroll { overflow: auto; flex: 1 1 auto; padding: 8px; }
.code-scroll { padding: 0; }
.pane-empty { color: var(--muted); padding: 22px 14px; font-size: var(--step--1); }
.pane-head { display: flex; gap: 8px; align-items: center; padding: 8px 10px;
             border-bottom: 1px solid var(--line); background: var(--sunk); flex: 0 0 auto; }
.pane-filter { flex: 1 1 auto; min-width: 0; font: inherit; font-size: var(--step--1);
               padding: 5px 9px; border-radius: 6px; border: 1px solid var(--line-strong);
               background: var(--panel); color: var(--ink); }
.pane-filter:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.chip { border: 1px solid var(--line-strong); background: var(--panel); color: var(--muted);
        border-radius: 999px; padding: 4px 10px; font: inherit; font-size: 11px;
        cursor: pointer; flex: 0 0 auto; }
.chip.is-on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

/* Tree: the row carries the colour. */
.tree-dir { padding: 3px 10px 3px calc(10px + var(--depth) * 11px); color: var(--muted);
            font-size: 11px; font-weight: 650; }
.tree-file { display: flex; align-items: center; gap: 7px; width: 100%; border: 0;
             border-left: 3px solid transparent; background: none; font: inherit;
             font-size: var(--step--1); color: var(--ink-soft); text-align: left; cursor: pointer;
             padding: 3px 8px 3px calc(8px + var(--depth) * 11px); }
.tree-file:hover { background: var(--accent-soft); }
.tree-file.sev-high { border-left-color: var(--high); background: var(--tint-high); color: var(--ink); }
.tree-file.sev-medium { border-left-color: var(--medium); background: var(--tint-medium); color: var(--ink); }
.tree-file.sev-low { border-left-color: var(--low); background: var(--tint-low); }
.tree-file.is-open { outline: 2px solid var(--accent); outline-offset: -2px; font-weight: 600; }
.tree-file:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.tree-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.tree-count { font-family: var(--mono); font-size: 10px; color: var(--muted);
              font-variant-numeric: tabular-nums; }

/* Symbols. */
.sym { display: flex; gap: 9px; align-items: center; width: 100%; text-align: left;
       border: 1px solid transparent; border-left: 3px solid transparent; border-radius: 6px;
       background: none; font: inherit; cursor: pointer; padding: 5px 8px; color: var(--ink); }
.sym:hover { background: var(--accent-soft); }
.sym.is-open { border-color: var(--accent); background: var(--accent-soft); }
.sym.has-high { border-left-color: var(--high); background: var(--tint-high); }
.sym.has-medium { border-left-color: var(--medium); background: var(--tint-medium); }
.sym.has-low { border-left-color: var(--low); background: var(--tint-low); }
.sym:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.sym-line { font-family: var(--mono); font-size: 10px; color: var(--muted);
            font-variant-numeric: tabular-nums; flex: 0 0 34px; text-align: right; }
.sym-main { flex: 1 1 auto; min-width: 0; display: grid; }
.sym-name { font-family: var(--mono); font-size: var(--step--1); overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
.sym-sub { font-size: 10px; color: var(--muted); }
.sym-uses.is-dead { color: var(--high); font-weight: 600; }
.sym-uses.is-quiet { font-style: italic; }
.sym-flag { font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums;
            border-radius: 4px; padding: 1px 6px; background: var(--sunk); flex: 0 0 auto; }
.sym-flag.high { color: var(--high); } .sym-flag.medium { color: var(--medium); }

/* Source, with the lines to act on shaded in place. */
.code-head { justify-content: space-between; }
.code-path { font-family: var(--mono); font-size: var(--step--1); overflow: hidden;
             text-overflow: ellipsis; white-space: nowrap; }
.code-meta { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums;
             flex: 0 0 auto; }
.code { font-family: var(--mono); font-size: 11.5px; line-height: 1.6; }
.code-line { display: flex; gap: 12px; padding: 0 12px; border-left: 3px solid transparent;
             white-space: pre; }
.code-line.sev-high { background: var(--tint-high); border-left-color: var(--high); cursor: pointer; }
.code-line.sev-medium { background: var(--tint-medium); border-left-color: var(--medium); cursor: pointer; }
.code-line.sev-low { background: var(--tint-low); border-left-color: var(--low); cursor: pointer; }
.code-line.is-focus { outline: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
                      outline-offset: -1px; }
.code-n { color: var(--muted); opacity: 0.55; user-select: none; flex: 0 0 4ch;
          text-align: right; font-variant-numeric: tabular-nums; }
.code-text { flex: 1 1 auto; }

/* What to do about it, above the code it concerns. */
.action { border: 1px solid var(--line); border-left: 3px solid var(--low);
          border-radius: 8px; margin: 10px; padding: 11px 13px; background: var(--panel); }
.action.high { border-left-color: var(--high); }
.action.medium { border-left-color: var(--medium); }
.action-head { display: flex; gap: 10px; align-items: baseline; }
.action-title { flex: 1 1 auto; font-weight: 550; }
.action-score { font-family: var(--mono); font-size: 11px; color: var(--muted);
                font-variant-numeric: tabular-nums; }
.action-detail { color: var(--ink-soft); font-size: var(--step--1); margin: 8px 0 0;
                 max-width: 74ch; }
.action-do { margin: 8px 0 0; font-size: var(--step--1); padding: 8px 10px;
             background: var(--accent-soft); border-radius: 6px; max-width: 74ch; }

/* References. */
.refs { display: grid; gap: 5px; }
.refs-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em;
              color: var(--muted); font-weight: 650; }
.refs-none { color: var(--muted); font-size: var(--step--1); }
.ref-list { display: grid; gap: 2px; }
.ref { display: flex; gap: 10px; align-items: baseline; width: 100%; border: 0; background: none;
       font: inherit; font-size: var(--step--1); text-align: left; cursor: pointer;
       padding: 3px 6px; border-radius: 5px; color: var(--ink-soft); }
.ref:hover { background: var(--accent-soft); color: var(--accent); }
.ref-name { font-family: var(--mono); flex: 0 0 auto; }
.ref-loc { font-family: var(--mono); font-size: 10px; color: var(--muted); flex: 1 1 auto;
           overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }

.map-block { margin-top: 40px; }
.map-block summary { cursor: pointer; color: var(--muted); font-size: var(--step--1);
                     padding: 6px 0; }
.map-block summary:hover { color: var(--accent); }

@media (max-width: 900px) {
  .ide-panes { grid-template-columns: 1fr; height: auto; }
  .ide-tree { border-right: 0; border-bottom: 1px solid var(--line); max-height: 200px; }
  .ide-symbols { border-right: 0; border-bottom: 1px solid var(--line); max-height: 260px; }
  .ide-code { max-height: 520px; }
  .pane-scroll { max-height: 420px; }
}
footer { margin-top: 64px; padding-top: 18px; border-top: 1px solid var(--line);
         color: var(--muted); font-size: var(--step--1); max-width: 72ch; }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
@media (max-width: 640px) {
  #app { padding-block: 24px 80px; padding-inline: 16px; }
  h1 { font-size: var(--step-2); }
  .finding summary { flex-wrap: wrap; gap: 6px 10px; }
  .bar-row { grid-template-columns: 100px 1fr 42px; }
}
`;

const SCRIPT = `
const DATA = JSON.parse(document.getElementById('data').textContent);
const app = document.getElementById('app');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const heatColour = (heat) => {
  if (heat <= 0.001) return 'var(--heat0)';
  // Opacity rather than a gradient: it reads correctly in both themes.
  return 'color-mix(in srgb, var(--heat1) ' + Math.round(18 + heat * 82) + '%, var(--heat0))';
};

function treemap() {
  const boxes = DATA.treemap;
  if (!boxes.length) return '<p class="lede">Nothing indexed.</p>';

  const dirs = boxes.filter((b) => !b.leaf);
  const leaves = boxes.filter((b) => b.leaf);

  const parts = ['<svg viewBox="0 0 ${TREEMAP_WIDTH} ${TREEMAP_HEIGHT}" role="img" aria-label="Map of the codebase by file size and findings">'];

  for (const b of dirs) {
    parts.push('<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h +
      '" fill="none" stroke="var(--line)" rx="3"/>');
    if (b.h > 22 && b.w > 40) {
      parts.push('<text class="dir-label" x="' + (b.x + 4) + '" y="' + (b.y + 11) + '">' +
        esc(b.name) + '</text>');
    }
  }

  for (const b of leaves) {
    parts.push('<rect class="box" data-path="' + esc(b.path) + '" x="' + b.x + '" y="' + b.y +
      '" width="' + b.w + '" height="' + b.h + '" rx="2" fill="' + heatColour(b.heat) + '">' +
      '<title>' + esc(b.path) + '\\n' + b.value + ' lines' +
      (b.findings ? ' · ' + b.findings + ' finding' + (b.findings === 1 ? '' : 's') : ' · clean') +
      '</title></rect>');
    if (b.w > 46 && b.h > 13) {
      const chars = Math.floor((b.w - 6) / 5);
      const label = b.name.length > chars ? b.name.slice(0, Math.max(1, chars - 1)) + '…' : b.name;
      parts.push('<text class="box-label" x="' + (b.x + 3) + '" y="' + (b.y + 10) + '">' +
        esc(label) + '</text>');
    }
  }

  parts.push('</svg>');
  return parts.join('');
}


/* ---------------------------------------------------------------------------
 * The explorer.
 *
 * A developer's question is almost never "what is this codebase made of". It
 * is "where does this live, who calls it, and what is wrong with it" — which
 * wants a tree, a symbol and its call sites in one place, not a picture.
 * ------------------------------------------------------------------------ */

let openFile = null;
let openSymbol = null;
let query = '';
let symbolFilter = '';
let onlyFlagged = false;

const FILES = new Map(DATA.files.map((f) => [f.path, f]));
const FINDINGS = new Map(DATA.findings.map((f) => [f.id, f]));

const worstSeverity = (ids) => {
  let worst = null;
  for (const id of ids) {
    const f = FINDINGS.get(id);
    if (!f) continue;
    if (f.severity === 'high') return 'high';
    if (f.severity === 'medium') worst = 'medium';
    else if (!worst) worst = 'low';
  }
  return worst;
};

/** Files matching the search, by path or by any symbol name. */
function matchingFiles() {
  if (!query) return DATA.files;
  const q = query.toLowerCase();
  return DATA.files.filter(
    (f) => f.path.toLowerCase().includes(q) || f.symbols.some((s) => s.name.toLowerCase().includes(q)),
  );
}

/** Nest flat paths into folders, collapsing chains with a single child. */
function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(path)) node.dirs.set(path, { name: parts[i], path, dirs: new Map(), files: [] });
      node = node.dirs.get(path);
    }
    node.files.push(file);
  }
  return root;
}

function treeHtml(node, depth) {
  const parts = [];
  for (const dir of node.dirs.values()) {
    // A folder with one folder inside reads better as one row: src/analysis.
    let label = dir.name;
    let current = dir;
    while (current.files.length === 0 && current.dirs.size === 1) {
      current = [...current.dirs.values()][0];
      label += '/' + current.name;
    }
    parts.push(
      '<div class="tree-dir" style="--depth:' + depth + '">' + esc(label) + '</div>' +
        treeHtml(current, depth + 1),
    );
  }
  for (const file of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
    const severity = worstSeverity(file.findings);
    const selected = file.path === openFile ? ' is-open' : '';
    parts.push(
      '<button class="tree-file' + selected + (severity ? ' sev-' + severity : '') +
        '" data-file="' + esc(file.path) + '" ' +
        'style="--depth:' + depth + '" title="' + esc(file.path) + '">' +
        '<span class="tree-name">' + esc(file.path.split('/').pop()) + '</span>' +
        (file.findings.length ? '<span class="tree-count">' + file.findings.length + '</span>' : '') +
      '</button>',
    );
  }
  return parts.join('');
}

function symbolHtml(symbol) {
  const severity = worstSeverity(symbol.findings);
  const open = symbol.id === openSymbol;

  /*
   * "Unused" is a verdict, and only the dead-code analysis gets to make it.
   * A package's public API has no callers inside the package — that is what
   * makes it the API — so marking "sign" and "verify" as unused would be
   * alarming and wrong.
   */
  const reportedDead = symbol.findings.some((id) => {
    const f = FINDINGS.get(id);
    return f && (f.kind === 'dead' || f.kind === 'orphan-file');
  });
  const uses = symbol.usedByCount > 0
    ? { label: String(symbol.usedByCount) + ' uses', tone: '' }
    : reportedDead
      ? { label: 'unused', tone: ' is-dead' }
      : { label: symbol.exported ? 'no callers here' : 'no callers', tone: ' is-quiet' };

  return '<button class="sym' + (open ? ' is-open' : '') + (severity ? ' has-' + severity : '') +
      '" data-symbol="' + esc(symbol.id) + '">' +
      '<span class="sym-line">' + symbol.line + '</span>' +
      '<span class="sym-main">' +
        '<span class="sym-name">' + esc(symbol.name) + '</span>' +
        '<span class="sym-sub">' + esc(symbol.kind) + ' · ' + symbol.loc + ' lines · ' +
          '<span class="sym-uses' + uses.tone + '">' + uses.label + '</span></span>' +
      '</span>' +
      (symbol.findings.length ? '<span class="sym-flag ' + severity + '">' + symbol.findings.length + '</span>' : '') +
    '</button>';
}

/** Column two: what this file declares, filterable. */
function symbolsPane() {
  if (!openFile) return '<div class="pane-empty">Pick a file.</div>';
  const file = FILES.get(openFile);
  if (!file) return '<div class="pane-empty">File not found.</div>';

  const q = symbolFilter.toLowerCase();
  const shown = file.symbols.filter((s) => {
    if (q && !s.name.toLowerCase().includes(q)) return false;
    if (onlyFlagged && s.findings.length === 0) return false;
    return true;
  });

  return '<div class="pane-head">' +
      '<input class="pane-filter" id="sym-filter" type="search" placeholder="Filter symbols" ' +
        'value="' + esc(symbolFilter) + '" autocomplete="off">' +
      '<button class="chip' + (onlyFlagged ? ' is-on' : '') + '" data-toggle="flagged" ' +
        'aria-pressed="' + onlyFlagged + '">flagged only</button>' +
    '</div>' +
    '<div class="pane-scroll">' +
      (shown.length
        ? shown.map(symbolHtml).join('')
        : '<div class="pane-empty">' +
            (file.symbols.length ? 'No symbol matches.' : 'This file declares nothing.') +
          '</div>') +
    '</div>';
}

/** Column three: the file, with the lines to act on shaded, and what to do. */
function codePane() {
  if (!openFile) {
    return '<div class="pane-empty">' +
      '<p>Open a file to read it here, with anything worth acting on marked in place.</p></div>';
  }
  const file = FILES.get(openFile);
  if (!file) return '<div class="pane-empty">File not found.</div>';

  const selected = openSymbol ? file.symbols.find((s) => s.id === openSymbol) : null;
  const ids = selected && selected.findings.length ? selected.findings : file.findings;
  const actions = ids.map((id) => FINDINGS.get(id)).filter(Boolean).map(actionCard).join('');

  const head = '<div class="pane-head code-head">' +
      '<span class="code-path">' + esc(file.path) + '</span>' +
      '<span class="code-meta">' + file.loc + ' lines</span>' +
    '</div>';

  if (!file.source) {
    return head + '<div class="pane-scroll">' + (actions || '') +
      '<div class="pane-empty">This file was too large to include in the report. ' +
      'Open it in your editor at the lines above.</div></div>';
  }

  // Strongest severity wins a line, so an overlap never shades a problem down.
  const rank = { high: 3, medium: 2, low: 1 };
  const lineSeverity = new Map();
  const lineFinding = new Map();
  for (const mark of file.marks) {
    for (let n = mark.from; n <= mark.to; n++) {
      const current = lineSeverity.get(n);
      if (!current || rank[mark.severity] > rank[current]) {
        lineSeverity.set(n, mark.severity);
        lineFinding.set(n, mark.finding);
      }
    }
  }

  const focusFrom = selected ? selected.line : null;
  const focusTo = selected ? selected.line + selected.loc - 1 : null;

  const rows = file.source.map((text, i) => {
    const n = i + 1;
    const severity = lineSeverity.get(n);
    const inFocus = focusFrom !== null && n >= focusFrom && n <= focusTo;
    const cls = 'code-line' + (severity ? ' sev-' + severity : '') + (inFocus ? ' is-focus' : '');
    const anchor = inFocus && n === focusFrom ? ' id="focus-line"' : '';
    return '<div class="' + cls + '"' + anchor +
      (severity ? ' data-finding="' + esc(lineFinding.get(n)) + '"' : '') + '>' +
      '<span class="code-n">' + n + '</span>' +
      '<span class="code-text">' + esc(text || ' ') + '</span></div>';
  }).join('');

  return head + '<div class="pane-scroll code-scroll">' + actions +
    '<div class="code">' + rows + '</div></div>';
}

/** One finding, stated as a problem and a remedy. */
function actionCard(finding) {
  return '<div class="action ' + finding.severity + '">' +
      '<div class="action-head">' +
        '<span class="sev ' + finding.severity + '">' + finding.severity + '</span>' +
        '<span class="action-title">' + esc(finding.title) + '</span>' +
        '<span class="action-score">' + Math.round(finding.score * 100) + '%</span>' +
      '</div>' +
      '<p class="action-detail">' + esc(finding.detail) + '</p>' +
      (finding.action ? '<p class="action-do"><strong>Do:</strong> ' + esc(finding.action) + '</p>' : '') +
      (finding.kind === 'drift' ? driftBars(finding) : '') +
      (finding.kind === 'contradiction' ? conflictTable(finding) : '') +
      (finding.kind === 'duplicate' && finding.snippets.length > 1
        ? '<div class="snips side-by-side">' + finding.snippets.map(snippetHtml).join('') + '</div>'
        : '') +
    '</div>';
}

function explorer() {
  const files = matchingFiles();
  return '<div class="ide">' +
      '<div class="ide-bar">' +
        '<input id="ex-search" class="ex-search" type="search" placeholder="Search files and symbols" ' +
          'value="' + esc(query) + '" autocomplete="off">' +
        '<span class="ex-count">' + files.length + ' of ' + DATA.files.length + ' files</span>' +
      '</div>' +
      '<div class="ide-panes">' +
        '<nav class="ide-tree" aria-label="Files">' + treeHtml(buildTree(files), 0) + '</nav>' +
        '<section class="ide-symbols" aria-label="Symbols">' + symbolsPane() + '</section>' +
        '<section class="ide-code" aria-label="Source">' + codePane() + '</section>' +
      '</div>' +
    '</div>';
}

function repaintExplorer() {
  const host = document.getElementById('explorer-host');
  if (!host) return;
  const active = document.activeElement;
  const focusedId = active && (active.id === 'ex-search' || active.id === 'sym-filter') ? active.id : null;
  const caret = focusedId ? active.selectionStart : null;

  host.innerHTML = explorer();

  if (focusedId) {
    const input = document.getElementById(focusedId);
    if (input) {
      input.focus();
      if (caret !== null) input.setSelectionRange(caret, caret);
    }
  }
  const focus = document.getElementById('focus-line');
  if (focus) focus.scrollIntoView({ block: 'center' });
}

function snippetHtml(s) {
  const lines = s.lines.map((line, i) =>
    '<span class="ln">' + (s.startLine + i) + '</span>' + esc(line)).join('\\n');
  return '<div><p class="snip-head">' + esc(s.file) + ':' + s.startLine + '</p><pre>' + lines + '</pre></div>';
}

function conflictTable(f) {
  const variants = (f.evidence && f.evidence.variants) || [];
  if (!variants.length) return '';
  // The disagreement itself, stated plainly: value, and where it is claimed.
  return '<table class="variants"><thead><tr><th>value</th><th>where</th></tr></thead><tbody>' +
    variants.map((v) =>
      '<tr><td><code>' + esc(v.value) + '</code></td>' +
      '<td>' + esc(v.symbol || '') + ' — ' + esc(v.file) + ':' + v.line + '</td></tr>').join('') +
    '</tbody></table>';
}

function driftBars(f) {
  const rows = (f.evidence && f.evidence.breakdown) || [];
  if (!rows.length) return '';
  // Small multiples: the proportions make the argument on their own.
  return '<div class="bars">' + rows.map((r, i) =>
    '<div class="bar-row' + (i === 0 ? '' : ' minor') + '">' +
      '<span>' + esc(r.dialect) + '</span>' +
      '<span class="bar-track"><span class="bar-fill" style="width:' +
        Math.round(r.share * 100) + '%"></span></span>' +
      '<span class="bar-num">' + Math.round(r.share * 100) + '%</span>' +
    '</div>').join('') + '</div>';
}

/** A figure reads as good or bad before it is read as a number. */
function tile(value, label, state) {
  const cls = state === 'clean' ? ' is-clean' : state === 'alert' ? ' is-alert' : '';
  return '<div class="tile' + cls + '"><span class="n">' + value + '</span>' +
    '<span class="l">' + label + '</span></div>';
}

function render() {
  const s = DATA.stats;
  const clean = s.loc > 0 ? (1 - (s.deadLoc + s.duplicateLoc) / s.loc) * 100 : 100;

  app.innerHTML =
    '<h1>' + esc(DATA.title) + '</h1>' +
    '<p class="sub">' + DATA.generatedAt + ' · ' + s.files + ' files · ' +
      s.symbols + ' symbols · ' + s.loc.toLocaleString('en-GB') + ' lines</p>' +

    DATA.warnings.map((w) => '<p class="warn">' + esc(w) + '</p>').join('') +

    '<div class="headline">' +
      tile(clean.toFixed(1) + '%', 'load-bearing', clean >= 95 ? 'clean' : 'alert') +
      tile(s.deadLoc.toLocaleString('en-GB'), 'lines nothing reaches', s.deadLoc === 0 ? 'clean' : '') +
      tile(s.duplicateLoc.toLocaleString('en-GB'), 'lines of re-implementation', s.duplicateLoc === 0 ? 'clean' : '') +
      tile(String(s.driftCount), 'conventions done two ways', s.driftCount === 0 ? 'clean' : '') +
      tile(String(s.contradictionCount), 'values stated two ways', s.contradictionCount === 0 ? 'clean' : 'alert') +
    '</div>' +

    '<div id="explorer-host">' + explorer() + '</div>' +

    '<details class="map-block"><summary>Show the whole codebase as a map</summary>' +
      '<p class="lede">Every file, sized by lines and shaded by how much of it is ' +
        'implicated in a finding. Click one to open it above.</p>' +
      '<div class="panel">' + treemap() + '</div>' +
      '<p class="legend">' +
        '<span><span class="swatch" style="background:var(--heat0)"></span>clean</span>' +
        '<span><span class="swatch" style="background:' + heatColour(0.5) + '"></span>some findings</span>' +
        '<span><span class="swatch" style="background:' + heatColour(1) + '"></span>mostly findings</span>' +
        '<span>box size = lines of code</span>' +
      '</p>' +
    '</details>' +

    '<footer>Generated by <strong>instantiate</strong>. ' +
      'A static graph cannot see dynamic dispatch, so treat low-confidence findings as questions, ' +
      'not facts.</footer>';
}

app.addEventListener('input', (event) => {
  if (event.target.id === 'sym-filter') {
    symbolFilter = event.target.value.trim();
    repaintExplorer();
    return;
  }
  if (event.target.id !== 'ex-search') return;
  query = event.target.value.trim();
  // Searching for a symbol should land on it, not merely narrow the tree.
  if (query) {
    const hit = matchingFiles();
    if (hit.length === 1) openFile = hit[0].path;
  }
  repaintExplorer();
});

app.addEventListener('click', (event) => {
  // A call site: open that file and land on the symbol it names.
  const ref = event.target.closest('.ref[data-file]');
  if (ref) {
    openFile = ref.dataset.file;
    const target = FILES.get(openFile);
    const wanted = ref.dataset.symbol;
    const match = target && wanted ? target.symbols.find((sym) => sym.name === wanted) : null;
    openSymbol = match ? match.id : null;
    symbolFilter = '';
    repaintExplorer();
    return;
  }

  const toggle = event.target.closest('[data-toggle]');
  if (toggle) {
    onlyFlagged = !onlyFlagged;
    repaintExplorer();
    return;
  }

  const symButton = event.target.closest('[data-symbol]');
  if (symButton) {
    openSymbol = openSymbol === symButton.dataset.symbol ? null : symButton.dataset.symbol;
    repaintExplorer();
    return;
  }

  // A shaded line in the source: select the symbol that finding belongs to.
  const codeLine = event.target.closest('.code-line[data-finding]');
  if (codeLine) {
    const file = FILES.get(openFile);
    const id = codeLine.dataset.finding;
    const owner = file && file.symbols.find((sym) => sym.findings.includes(id));
    if (owner) {
      openSymbol = owner.id;
      repaintExplorer();
    }
    return;
  }

  const fileButton = event.target.closest('[data-file]');
  if (fileButton) {
    openFile = fileButton.dataset.file;
    openSymbol = null;
    symbolFilter = '';
    repaintExplorer();
    return;
  }

  // The map is an index into the panes, not a destination of its own.
  const box = event.target.closest('[data-path]');
  if (box) {
    openFile = box.dataset.path;
    openSymbol = null;
    symbolFilter = '';
    repaintExplorer();
    document.getElementById('explorer-host').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

render();
`;
