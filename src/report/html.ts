import { basename } from 'node:path';
import type { ScanResult } from '../api.js';
import type { Finding } from '../types.js';
import { layout, treeFromPaths, type LaidOut } from './treemap.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snippet, type Snippet } from './snippets.js';
import { ICONS, THEME_TOKENS } from './theme.js';

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
  /** Where the code lives, so every path in the report can link to it. */
  repo?: { url: string; label: string; blobBase?: string };
  stats: ScanResult['stats'];
  warnings: string[];
  treemap: SerialisedBox[];
  mapSize: { width: number; height: number };
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

interface FileLink {
  path: string;
  /** How many distinct symbols of the other file are involved. */
  count: number;
}

interface FileEntry {
  path: string;
  loc: number;
  symbols: SymbolEntry[];
  findings: string[];
  /** Files that reach into this one, and the ones it reaches into. */
  usedBy: FileLink[];
  uses: FileLink[];
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
    repo: describeRepo(result),
    stats: result.stats,
    warnings: result.warnings,
    treemap: boxes,
    mapSize: { width: TREEMAP_WIDTH, height: TREEMAP_HEIGHT },
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

/**
 * The remote, reduced to what the page needs: somewhere to point at, something
 * short to print, and the prefix that turns a path into a link.
 */
function describeRepo(result: ScanResult): ReportData['repo'] {
  const repo = result.repo;
  if (!repo) return undefined;
  const linkable = /github\.com|gitlab\.com|bitbucket\.org/.test(repo.url);
  return {
    url: repo.url,
    // Host and path, without the scheme: it is a label, not an address bar.
    label: repo.url.replace(/^https?:\/\//, ''),
    blobBase: linkable ? `${repo.url}/${repo.blobPath}/${repo.ref}` : undefined,
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

  const links = fileLinks(result);
  const entries: FileEntry[] = [...perFile.entries()]
    .map(([path, entry]) => ({
      path,
      loc: entry.loc,
      findings: entry.findings,
      symbols: (byFile.get(path) ?? []).sort((a, b) => a.line - b.line),
      usedBy: links.usedBy.get(path) ?? [],
      uses: links.uses.get(path) ?? [],
      marks: [],
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  attachMarks(entries, result);
  attachSource(entries, result.config.root);
  return entries;
}

/**
 * How the files connect.
 *
 * A symbol graph answers "who calls this function"; the question before that
 * one is usually "what depends on this file at all" — which is what tells you
 * whether a change is contained or whether it reaches half the codebase.
 *
 * Counted by distinct symbol pairs, so a file calling one helper forty times
 * does not look like a heavier dependency than one calling forty helpers once.
 */
function fileLinks(result: ScanResult): {
  usedBy: Map<string, FileLink[]>;
  uses: Map<string, FileLink[]>;
} {
  const pairs = new Map<string, Set<string>>();

  for (const edge of result.graph.edges) {
    const from = edge.from.split('#')[0];
    const to = edge.to.split('#')[0];
    if (from === to) continue;
    const key = from + '\u0000' + to;
    const set = pairs.get(key) ?? new Set<string>();
    set.add(edge.from + '>' + edge.to);
    pairs.set(key, set);
  }

  const usedBy = new Map<string, FileLink[]>();
  const uses = new Map<string, FileLink[]>();

  for (const [key, involved] of pairs) {
    const [from, to] = key.split('\u0000');
    const count = involved.size;
    (usedBy.get(to) ?? usedBy.set(to, []).get(to)!).push({ path: from, count });
    (uses.get(from) ?? uses.set(from, []).get(from)!).push({ path: to, count });
  }

  const byWeight = (a: FileLink, b: FileLink) => b.count - a.count || a.path.localeCompare(b.path);
  for (const list of usedBy.values()) list.sort(byWeight);
  for (const list of uses.values()) list.sort(byWeight);
  return { usedBy, uses };
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

    // A finding about a line rather than a symbol — unfinished work — marks
    // that line, and every condition it leaves frozen.
    if (finding.symbols.length === 0) {
      const file = byPath.get(finding.file);
      const lines = [finding.line, ...((finding.evidence?.reads ?? []) as number[])];
      for (const line of file ? lines : []) {
        file!.marks.push({ from: line, to: line, severity: finding.severity, finding: finding.id });
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
${THEME_TOKENS}
* { box-sizing: border-box; }

/* Icons size themselves against the text beside them, and inherit its colour. */
.icon { width: 1.05em; height: 1.05em; flex: 0 0 auto; vertical-align: -0.16em; }
.icon-sm { width: 0.85em; height: 0.85em; opacity: 0.7; }
/*
 * A code browser is an application, not a document: it should take the window
 * and grow with it. Height in percentages rather than viewport units, so the
 * shell sits inside the safe-area padding the host applies rather than
 * overflowing it on a phone.
 */
html, body { height: 100%; }
* { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--line-strong);
                             border: 2px solid var(--panel); }
*::-webkit-scrollbar-thumb:hover { background: var(--muted); }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: var(--step-0);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
#app {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.shell-body { flex: 1 1 auto; min-height: 0; display: flex; }
.warnings { padding: 10px 16px 0; flex: 0 0 auto; }

/* The one bar: identity, navigation, search and the numbers, in that order. */
.bar-title { display: grid; gap: 1px; flex: 0 0 auto; min-width: 0; margin-right: 4px; }
.bar-line { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.bar-title strong { font-size: var(--step-0); letter-spacing: -0.01em; }
.bar-repo { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px;
            color: var(--muted); text-decoration: none; font-family: var(--mono);
            max-width: 34ch; white-space: nowrap; }
.bar-repo:hover { color: var(--accent); text-decoration: underline; }
.bar-repo:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.bar-meta { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums;
            white-space: nowrap; }

.stats { display: flex; flex-wrap: wrap; gap: 4px; flex: 0 0 auto; }
.stat { display: flex; gap: 5px; align-items: baseline; padding: 2px 8px;
        border: 1px solid var(--line); background: var(--sunk); }
.stat-n { font-weight: 640; font-variant-numeric: tabular-nums; font-size: 11.5px; }
.stat-l { font-size: 10.5px; color: var(--muted); }
.stat.is-clean .stat-n { color: var(--good); }
.stat.is-alert .stat-n { color: var(--high); }

h1 { font-size: var(--step-1); margin: 0; letter-spacing: -0.02em; font-weight: 640; }
h2 {
  font-size: var(--step--1); text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--muted); font-weight: 650; margin: 60px 0 6px;
}
.sub { color: var(--muted); font-size: var(--step--1); margin: 0; font-variant-numeric: tabular-nums; }
.lede { color: var(--ink-soft); margin: 0 0 18px; max-width: 64ch; }

.headline { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1px;
            margin: 28px 0 4px; background: var(--line); border: 1px solid var(--line); overflow: hidden; }
.tile { background: var(--panel); padding: 16px 18px; }
.tile .n { font-size: var(--step-2); font-weight: 600; letter-spacing: -0.03em;
           font-variant-numeric: tabular-nums; display: block; line-height: 1.1; }
.tile .l { font-size: var(--step--1); color: var(--muted); }
.tile.is-clean .n { color: var(--good); }
.tile.is-alert .n { color: var(--high); }

.warn { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--medium); padding: 12px 16px; margin: 16px 0; color: var(--ink-soft); }

.panel { background: var(--panel); border: 1px solid var(--line);
         padding: 16px; overflow: hidden; }
svg { display: block; width: 100%; height: auto; }
.box { stroke: var(--panel); stroke-width: 1; cursor: pointer; }
.box:hover { stroke: var(--accent); stroke-width: 2; }
.box-label { font-family: var(--mono); font-size: 9px; fill: var(--ink-soft);
             pointer-events: none; opacity: 0.8; }
.dir-label { font-size: 10px; fill: var(--muted); pointer-events: none; font-weight: 650; }

/* Severity reads as a stripe before it reads as a word. */
.finding { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--low); margin: 7px 0; overflow: hidden; }
.finding[data-severity="high"] { border-left-color: var(--high); }
.finding[data-severity="medium"] { border-left-color: var(--medium); }
.finding summary { padding: 12px 16px; cursor: pointer; display: flex; gap: 12px;
                   align-items: baseline; list-style: none; }
.finding summary::-webkit-details-marker { display: none; }
.finding summary:hover { background: var(--accent-soft); }
.finding summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.sev { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 700;
       flex: 0 0 auto; padding: 2px 7px; background: var(--sunk); color: var(--low); }
.sev.high { color: var(--high); } .sev.medium { color: var(--medium); }
.f-title { flex: 1 1 auto; font-weight: 500; }
.f-meta { color: var(--muted); font-size: var(--step--1); font-variant-numeric: tabular-nums;
          font-family: var(--mono); flex: 0 0 auto; }
.f-body { padding: 0 16px 16px; border-top: 1px solid var(--line); }
.f-detail { color: var(--ink-soft); margin: 12px 0; max-width: 72ch; }

.snips { display: grid; gap: 10px; grid-template-columns: 1fr; }
.snips.side-by-side { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
pre { margin: 0; background: var(--sunk); border: 1px solid var(--line);
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
                 padding: 1px 6px; }

.bars { display: grid; gap: 5px; margin: 12px 0; }
.bar-row { display: grid; grid-template-columns: minmax(110px, 170px) 1fr 46px; gap: 10px;
           align-items: center; font-size: var(--step--1); }
.bar-track { height: 8px; background: var(--sunk); overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); }
.bar-row.minor .bar-fill { background: var(--medium); }
.bar-num { font-family: var(--mono); font-size: 11px; color: var(--muted); text-align: right;
           font-variant-numeric: tabular-nums; }

.filters { display: flex; gap: 6px; flex-wrap: wrap; margin: 16px 0 4px; }
.filters button { background: var(--panel); border: 1px solid var(--line); color: var(--ink-soft); padding: 5px 14px; font-size: var(--step--1); cursor: pointer;
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
.swatch { display: inline-block; width: 13px; height: 13px; vertical-align: -2px;
          margin-right: 7px; border: 1px solid var(--line-strong); }

/* The three panes ---------------------------------------------------------
 *
 * Tree, symbols, source. Severity is carried by the row itself rather than by
 * a bullet beside it, so a glance down the tree reads as a heat profile of the
 * codebase; the source pane shades the exact lines to act on, in place.
 */
.ide { border: 0; overflow: hidden; background: var(--panel); flex: 1 1 auto;
       display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.ide-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
           padding: 8px 12px; border-bottom: 1px solid var(--line);
           background: var(--sunk); flex: 0 0 auto; }
.nav-pair { display: flex; gap: 2px; flex: 0 0 auto; }
.nav-btn { border: 1px solid var(--line-strong); background: var(--panel); color: var(--ink-soft); width: 28px; height: 28px; cursor: pointer; font: inherit;
           font-size: 15px; line-height: 1; padding: 0; }
.nav-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent);
                                background: var(--accent-soft); }
.nav-btn:disabled { opacity: 0.35; cursor: default; }
.nav-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* The path taken, so digging three files deep stays retraceable. */
.trail { display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
         padding: 6px 12px; border-bottom: 1px solid var(--line);
         background: var(--panel); font-size: 11px; }
.trail-step { border: 0; background: none; font: inherit; font-family: var(--mono);
              font-size: 11px; color: var(--muted); cursor: pointer; padding: 2px 6px; max-width: 26ch; overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap; }
.trail-step:hover { background: var(--accent-soft); color: var(--accent); }
.trail-step.is-here { color: var(--ink); background: var(--sunk); font-weight: 600; }
.trail-step:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
.trail-sep { color: var(--line-strong); }
.trail-more { color: var(--muted); padding: 0 2px; }

.search-wrap { position: relative; display: flex; align-items: center; flex: 1 1 220px;
               min-width: 0; }
.search-icon { position: absolute; left: 9px; color: var(--muted); pointer-events: none; }
.ex-search { width: 100%; min-width: 0; font: inherit; font-size: var(--step--1);
             padding: 7px 11px 7px 29px; border: 1px solid var(--line-strong);
             background: var(--panel); color: var(--ink); }
.ex-search:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ex-count { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums;
            flex: 0 0 auto; }

.ide-panes { display: grid;
             grid-template-columns: var(--w-tree, 240px) 6px var(--w-symbols, 280px) 6px 1fr;
             flex: 1 1 auto; min-height: 0; }

/* Splitters. Thin, and wide enough to grab: the padded ::after widens the
   target without widening the line. */
.splitter, .splitter-h { background: var(--line); position: relative; flex: 0 0 auto; }
.splitter { cursor: col-resize; }
.splitter-h { cursor: row-resize; height: 6px; }
.splitter::after { content: ''; position: absolute; inset: 0 -3px; }
.splitter-h::after { content: ''; position: absolute; inset: -3px 0; }
.splitter:hover, .splitter:focus-visible,
.splitter-h:hover, .splitter-h:focus-visible { background: var(--accent); outline: none; }
body.is-resizing { cursor: col-resize; user-select: none; }
body.is-resizing-y { cursor: row-resize; user-select: none; }
body.is-resizing .splitter, body.is-resizing-y .splitter-h { background: var(--accent); }
.ide-tree, .ide-symbols { display: flex; flex-direction: column;
                          min-width: 0; min-height: 0; }
.ide-tree { overflow: auto; padding: 8px 0; }
.ide-code { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.pane-scroll { overflow: auto; flex: 1 1 auto; padding: 8px; }
.code-scroll { padding: 0; }
.pane-empty { color: var(--muted); padding: 22px 14px; font-size: var(--step--1); }
.pane-head { display: flex; gap: 8px; align-items: center; padding: 8px 10px;
             border-bottom: 1px solid var(--line); background: var(--sunk); flex: 0 0 auto; }
.pane-head .search-wrap { flex: 1 1 auto; }
.pane-filter { width: 100%; min-width: 0; font: inherit; font-size: var(--step--1);
               padding: 5px 9px 5px 27px; border: 1px solid var(--line-strong);
               background: var(--panel); color: var(--ink); }
.pane-head .search-icon { left: 8px; }
.pane-filter:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.chip { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; border: 1px solid var(--line-strong); background: var(--panel); color: var(--muted); padding: 4px 10px; font: inherit; font-size: 11px;
        cursor: pointer; flex: 0 0 auto; }
.chip.is-on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

/* Tree: the row carries the colour. */
.tree-dir { display: flex; align-items: center; gap: 5px; width: 100%; border: 0;
            border-left: 3px solid transparent; background: none; cursor: pointer;
            font: inherit; font-size: 11px; font-weight: 650; color: var(--muted);
            text-align: left; padding: 3px 8px 3px calc(8px + var(--depth) * 11px); }
.tree-dir:hover { background: var(--accent-soft); color: var(--accent); }
.tree-dir:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.tree-dir.sev-high { border-left-color: var(--high); color: var(--ink-soft); }
.tree-dir.sev-medium { border-left-color: var(--medium); color: var(--ink-soft); }
.tree-dir.sev-low { border-left-color: var(--low); }
.tree-chevron { display: inline-flex; flex: 0 0 11px; opacity: 0.75; font-size: 10px; }
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
       border: 1px solid transparent; border-left: 3px solid transparent;
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
.sym-flag { font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums; padding: 1px 6px; background: var(--sunk); flex: 0 0 auto; }
.sym-flag.high { color: var(--high); } .sym-flag.medium { color: var(--medium); }

/* Source, with the lines to act on shaded in place. */
.head-spacer { flex: 1 1 auto; }
.code-path { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono);
             font-size: var(--step--1); overflow: hidden; text-overflow: ellipsis;
             white-space: nowrap; color: var(--ink); text-decoration: none; flex: 0 1 auto; }
.code-path.is-link:hover { color: var(--accent); text-decoration: underline; }
.code-path.is-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.code-meta { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums;
             flex: 0 0 auto; }
.code { font-family: var(--mono); font-size: 11.5px; line-height: 1.65;
        min-width: max-content; }
.code-line { display: flex; gap: 14px; padding: 0 14px 0 0; white-space: pre; }
.code-line.sev-high { background: var(--tint-high); box-shadow: inset 3px 0 0 var(--high); }
.code-line.sev-medium { background: var(--tint-medium); box-shadow: inset 3px 0 0 var(--medium); }
.code-line.sev-low { background: var(--tint-low); box-shadow: inset 3px 0 0 var(--low); }
.code-line[data-finding] { cursor: pointer; }
.code-line[data-finding]:hover { filter: brightness(1.06); }
.code-line.is-focus { background: var(--focus-tint); }
.code-line.is-focus.sev-high { background: var(--tint-high); }
.code-n { color: var(--muted); opacity: 0.5; user-select: none; flex: 0 0 5ch;
          text-align: right; font-variant-numeric: tabular-nums;
          background: var(--sunk); padding: 0 8px 0 6px; }
.code-text { flex: 1 1 auto; }

/* A folded run of lines nobody needs to read. */
.fold { display: flex; gap: 14px; align-items: center; width: 100%; border: 0;
        border-block: 1px solid var(--line); background: var(--sunk); cursor: pointer;
        font: inherit; font-size: 11px; color: var(--muted); padding: 3px 14px 3px 0;
        text-align: left; }
.fold:hover { color: var(--accent); background: var(--accent-soft); }
.fold-mark { flex: 0 0 5ch; display: inline-flex; justify-content: flex-end;
             padding-right: 8px; }
.fold:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

/* Tokens. Muted enough that the severity tints still read through them. */
.tok-comment { color: var(--tok-comment); font-style: italic; }
.tok-string { color: var(--tok-string); }
.tok-keyword { color: var(--tok-keyword); }
.tok-number { color: var(--tok-number); }
.tok-type { color: var(--tok-type); }
.tok-fn { color: var(--tok-fn); }
.tok-punct { color: var(--tok-punct); }

/* What to do about it, above the code it concerns. */
.action { border: 1px solid var(--line); border-left: 3px solid var(--low); margin: 8px 10px; background: var(--panel); overflow: hidden; }
.action.high { border-left-color: var(--high); }
.action.medium { border-left-color: var(--medium); }
.action-head { display: flex; gap: 10px; align-items: baseline; width: 100%; border: 0;
               background: none; font: inherit; text-align: left; cursor: pointer;
               padding: 9px 12px; color: var(--ink); }
.action-head:hover { background: var(--accent-soft); }
.action-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.action-title { flex: 1 1 auto; font-weight: 550; font-size: var(--step--1); }
.action-score { font-family: var(--mono); font-size: 11px; color: var(--muted);
                font-variant-numeric: tabular-nums; }
.action-chevron { display: inline-flex; color: var(--muted); font-size: 11px; }
.action-detail { color: var(--ink-soft); font-size: var(--step--1); margin: 0 0 8px;
                 max-width: 74ch; }
.action-do { margin: 0 12px 10px; font-size: var(--step--1); padding: 7px 10px;
             background: var(--accent-soft); max-width: 74ch; }
.action-more { padding: 0 12px 12px; border-top: 1px solid var(--line); margin-top: 2px;
               padding-top: 10px; }

/* References. */
.refs { display: grid; gap: 5px; }
.refs-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em;
              color: var(--muted); font-weight: 650; }
.refs-none { color: var(--muted); font-size: var(--step--1); }
.ref-list { display: grid; gap: 2px; }
.ref { display: flex; gap: 10px; align-items: baseline; width: 100%; border: 0; background: none;
       font: inherit; font-size: var(--step--1); text-align: left; cursor: pointer;
       padding: 3px 6px; color: var(--ink-soft); }
.ref:hover { background: var(--accent-soft); color: var(--accent); }
.ref-name { font-family: var(--mono); flex: 0 0 auto; }
.ref-loc { font-family: var(--mono); font-size: 10px; color: var(--muted); flex: 1 1 auto;
           overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }

.links-toggle { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
                border: 1px solid var(--accent); background: var(--accent-soft);
                color: var(--accent); padding: 4px 10px; font: inherit;
                font-size: var(--step--1); cursor: pointer; flex: 0 0 auto; font-weight: 550; }
.links-toggle:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.links-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.links-toggle.is-on { background: var(--accent); color: var(--panel); border-color: var(--accent); }

.links-tally { font-size: 11px; opacity: 0.85; font-weight: 400;
               font-variant-numeric: tabular-nums; }

/* The connections panel: a place to be read, not a footnote. */
.links { background: var(--sunk); overflow: auto; flex: 0 0 auto; }
.links-lede { margin: 0; padding: 12px 16px 10px; color: var(--ink-soft);
              font-size: var(--step--1); max-width: 78ch; }
.links-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
              gap: 18px; padding: 0 16px 16px; }
.links-col { display: grid; gap: 6px; align-content: start; }
.links-col .refs-label { font-size: 11px; color: var(--ink); }
.link-list { display: grid; gap: 1px; }
.link-row { display: flex; gap: 10px; align-items: baseline; width: 100%;
            border: 1px solid transparent; background: var(--panel); font: inherit;
            font-size: var(--step--1); text-align: left; cursor: pointer; padding: 4px 8px; color: var(--ink-soft); }
.link-row:hover { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.link-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.link-path { font-family: var(--mono); font-size: 11px; flex: 1 1 auto; overflow: hidden;
             text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.link-count { font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums;
              flex: 0 0 auto; }

.map-scroll { display: flex; flex-direction: column; }
/* Natural aspect, pinned to the top: stretching a squarified treemap to fill
   a tall pane would distort the very proportions it encodes, and centring it
   letterboxes the map top and bottom. */
.map-wrap { padding: 12px; flex: 0 0 auto; }
.map-wrap svg { width: 100%; height: auto; }
.legend { padding: 10px 14px; flex: 0 0 auto; margin: 0;
          border-bottom: 1px solid var(--line); background: var(--sunk); }
.legend-note { color: var(--muted); }

@media (max-width: 900px) {
  /* Stacked, and the shell stops being one screen: scroll the page instead. */
  html, body { height: auto; }
  #app { height: auto; }
  .shell-body { padding: 12px 16px; }
  .ide { }
  /* Nothing to drag when the panes are stacked. */
  .ide-panes { grid-template-columns: 1fr; }
  .splitter, .splitter-h { display: none; }
  .ide-tree, .ide-symbols { border-bottom: 1px solid var(--line); }
  /* Stacked, the panel sizes itself; the stored height does not apply. */
  .links { height: auto !important; max-height: none; border-bottom: 2px solid var(--accent); }
  .ide-tree { border-right: 0; border-bottom: 1px solid var(--line); max-height: 200px; }
  .ide-symbols { border-right: 0; border-bottom: 1px solid var(--line); max-height: 280px; }
  .ide-code { max-height: 70vh; }
}
footer { flex: 0 0 auto; padding: 8px 20px; border-top: 1px solid var(--line);
         color: var(--muted); font-size: 11px; background: var(--panel); }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
@media (max-width: 640px) {
  #app { padding-block: 24px 80px; padding-inline: 16px; }
  h1 { font-size: var(--step-2); }
  .finding summary { flex-wrap: wrap; gap: 6px 10px; }
  .bar-row { grid-template-columns: 100px 1fr 42px; }
}
`;

/**
 * The page script, read once. Compiled output sits beside this file as
 * `client.js`; under tsx the TypeScript source is read instead, which is the
 * same code, since the file carries no types.
 */
const SCRIPT = (() => {
  for (const name of ['client.js', 'client.ts']) {
    try {
      // In an ES-module package the compiler marks every file a module with a
      // trailing `export {};`, which a classic <script> rejects outright.
      // The icon set is shared with the website, so it is handed in here.
      const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/^export \{\};?\s*$/m, '');
      return `const ICONS = ${JSON.stringify(ICONS)};\n${source}`;
    } catch {
      // Try the next.
    }
  }
  throw new Error('The report script (src/report/client.ts) is missing from this install.');
})();
