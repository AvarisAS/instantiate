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
  /** Where the code lives, so every path in the report can link to it. */
  repo?: { url: string; label: string; blobBase?: string };
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
  /*
   * Flexoki, by Steph Ango. An ink-on-paper palette: warm neutrals that hold
   * their character in both themes, and colours picked to sit on them without
   * shouting. Chosen over the cool blue-greys because a page full of code
   * should read like a printed page, not like a control panel.
   */
  --bg: #FFFCF0;          /* paper */
  --panel: #FFFCF0;
  --sunk: #F2F0E5;        /* base-50 */
  --ink: #100F0F;         /* black */
  --ink-soft: #403E3C;    /* base-800 */
  --muted: #6F6E69;       /* base-600 */
  --line: #DAD8CE;        /* base-150 */
  --line-strong: #B7B5AC; /* base-300 */
  --accent: #205EA6;      /* blue-600 */
  --accent-soft: #E1ECF7;
  --high: #AF3029;        /* red-600 */
  --medium: #AD8301;      /* yellow-600 */
  --low: #878580;         /* base-500 */
  --good: #66800B;        /* green-600 */

  /* Three bands, not a gradient: "clean", "some" and "mostly" have to be
     distinguishable at a glance in a map of four hundred boxes. */
  --heat0: #EDEBE0;
  --heat1: #E8C88A;
  --heat2: #C86A56;

  --focus-tint: color-mix(in srgb, var(--accent) 10%, transparent);
  --tok-comment: #878580;  /* base-500 */
  --tok-string: #66800B;   /* green-600 */
  --tok-keyword: #5E409D;  /* purple-600 */
  --tok-number: #BC5215;   /* orange-600 */
  --tok-type: #205EA6;     /* blue-600 */
  --tok-fn: #24837B;       /* cyan-600 */
  --tok-punct: #6F6E69;
  --tint-high: color-mix(in srgb, var(--high) 10%, transparent);
  --tint-medium: color-mix(in srgb, var(--medium) 13%, transparent);
  --tint-low: color-mix(in srgb, var(--low) 9%, transparent);

  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --step--1: 0.78rem;
  --step-0: 0.94rem;
  --step-1: 1.15rem;
  --step-2: 1.6rem;
  --step-3: 2.1rem;
}

/* Flexoki's dark side: the same ink, inverted. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #100F0F;          /* black */
    --panel: #1C1B1A;       /* base-950 */
    --sunk: #282726;        /* base-900 */
    --ink: #CECDC3;         /* base-200 */
    --ink-soft: #B7B5AC;    /* base-300 */
    --muted: #878580;       /* base-500 */
    --line: #343331;        /* base-850 */
    --line-strong: #575653; /* base-700 */
    --accent: #4385BE;      /* blue-400 */
    --accent-soft: #1A2733;
    --high: #D14D41;        /* red-400 */
    --medium: #D0A215;      /* yellow-400 */
    --low: #878580;
    --good: #879A39;        /* green-400 */
    --heat0: #2A2927;
    --heat1: #6E5A1E;
    --heat2: #8C3B31;
    --focus-tint: color-mix(in srgb, var(--accent) 18%, transparent);
    --tok-comment: #6F6E69;  /* base-600 */
    --tok-string: #879A39;   /* green-400 */
    --tok-keyword: #8B7EC8;  /* purple-400 */
    --tok-number: #DA702C;   /* orange-400 */
    --tok-type: #4385BE;     /* blue-400 */
    --tok-fn: #3AA99F;       /* cyan-400 */
    --tok-punct: #878580;
    --tint-high: color-mix(in srgb, var(--high) 14%, transparent);
    --tint-medium: color-mix(in srgb, var(--medium) 16%, transparent);
    --tint-low: color-mix(in srgb, var(--low) 12%, transparent);
  }
}
:root[data-theme="dark"] {
  --bg: #100F0F;
  --panel: #1C1B1A;
  --sunk: #282726;
  --ink: #CECDC3;
  --ink-soft: #B7B5AC;
  --muted: #878580;
  --line: #343331;
  --line-strong: #575653;
  --accent: #4385BE;
  --accent-soft: #1A2733;
  --high: #D14D41;
  --medium: #D0A215;
  --low: #878580;
  --good: #879A39;
  --heat0: #2A2927;
  --heat1: #6E5A1E;
  --heat2: #8C3B31;
  --focus-tint: color-mix(in srgb, var(--accent) 18%, transparent);
  --tok-comment: #6F6E69;
  --tok-string: #879A39;
  --tok-keyword: #8B7EC8;
  --tok-number: #DA702C;
  --tok-type: #4385BE;
  --tok-fn: #3AA99F;
  --tok-punct: #878580;
  --tint-high: color-mix(in srgb, var(--high) 14%, transparent);
  --tint-medium: color-mix(in srgb, var(--medium) 16%, transparent);
  --tint-low: color-mix(in srgb, var(--low) 12%, transparent);
}

* { box-sizing: border-box; }
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
.bar-repo { font-size: 10.5px; color: var(--muted); text-decoration: none;
            font-family: var(--mono); max-width: 34ch; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
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

.ex-search { flex: 1 1 220px; min-width: 0; font: inherit; font-size: var(--step--1);
             padding: 7px 11px; border: 1px solid var(--line-strong);
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
.pane-filter { flex: 1 1 auto; min-width: 0; font: inherit; font-size: var(--step--1);
               padding: 5px 9px; border: 1px solid var(--line-strong);
               background: var(--panel); color: var(--ink); }
.pane-filter:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.chip { border: 1px solid var(--line-strong); background: var(--panel); color: var(--muted); padding: 4px 10px; font: inherit; font-size: 11px;
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
.tree-chevron { flex: 0 0 9px; font-size: 9px; opacity: 0.7; }
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
.code-head { justify-content: space-between; }
.code-path { font-family: var(--mono); font-size: var(--step--1); overflow: hidden;
             text-overflow: ellipsis; white-space: nowrap; color: var(--ink);
             text-decoration: none; }
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
.fold-mark { flex: 0 0 5ch; text-align: right; padding-right: 8px;
             font-family: var(--mono); letter-spacing: 1px; }
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
.action-chevron { font-size: 9px; color: var(--muted); }
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

.links-toggle { display: flex; align-items: center; gap: 7px; border: 1px solid var(--accent);
                background: var(--accent-soft); color: var(--accent);
                padding: 4px 11px; font: inherit; font-size: var(--step--1); cursor: pointer;
                flex: 0 0 auto; font-weight: 550; }
.links-toggle:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.links-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.links-toggle.is-on { background: var(--accent); color: var(--panel); border-color: var(--accent); }
.links-icon { font-size: 9px; }
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

const SCRIPT = `
const DATA = JSON.parse(document.getElementById('data').textContent);
const app = document.getElementById('app');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/*
 * Three bands, not a gradient.
 *
 * A continuous scale across four hundred boxes produced four hundred shades of
 * almost-black, and the legend promised a distinction the map never showed.
 * Clean, some, mostly — and nothing in between to squint at.
 */
const SOME_FINDINGS = 0.08;
const MOSTLY_FINDINGS = 0.35;

const heatColour = (heat) =>
  heat < SOME_FINDINGS ? 'var(--heat0)' : heat < MOSTLY_FINDINGS ? 'var(--heat1)' : 'var(--heat2)';

function treemap() {
  const boxes = DATA.treemap;
  if (!boxes.length) return '<p class="lede">Nothing indexed.</p>';

  const dirs = boxes.filter((b) => !b.leaf);
  const leaves = boxes.filter((b) => b.leaf);

  const parts = ['<svg viewBox="0 0 ${TREEMAP_WIDTH} ${TREEMAP_HEIGHT}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Map of the codebase by file size and findings">'];

  for (const b of dirs) {
    parts.push('<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h +
      '" fill="none" stroke="var(--line)"/>');
    if (b.h > 22 && b.w > 40) {
      parts.push('<text class="dir-label" x="' + (b.x + 4) + '" y="' + (b.y + 11) + '">' +
        esc(b.name) + '</text>');
    }
  }

  for (const b of leaves) {
    parts.push('<rect class="box" data-path="' + esc(b.path) + '" x="' + b.x + '" y="' + b.y +
      '" width="' + b.w + '" height="' + b.h + '" fill="' + heatColour(b.heat) + '">' +
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
let showMap = false;
/** Line numbers inside folds the reader has opened. */
let expandedFolds = new Set();
/** Folders the reader has opened, beyond those open because of the selection. */
let openFolders = new Set();
/** Findings whose reasoning the reader has opened. */
let expandedActions = new Set();
/** Whether the file-connection panel is open. */
let showLinks = false;

/* ---------------------------------------------------------------------------
 * Navigation history.
 *
 * Following a call site into another file, and another, is how anybody
 * actually reads unfamiliar code — and it is also how you lose your place.
 * Every move is recorded, so the trail shows the path taken and each step on
 * it goes back there. Forward entries are discarded on a new move, which is
 * what a back button everywhere else does.
 * ------------------------------------------------------------------------ */

const history = [];
let cursor = -1;

/* ---------------------------------------------------------------------------
 * Pane widths.
 *
 * Deep folder names want a wide tree; reading code wants a narrow one. Which
 * is right changes from file to file, so it belongs to the reader. Remembered
 * per browser, and guarded: storage is unavailable in a private window and
 * throws rather than returning nothing.
 * ------------------------------------------------------------------------ */

const MIN_PANE = 140;
const MIN_LINKS = 90;
const sizes = { tree: 240, symbols: 280, links: 260 };

try {
  const saved = JSON.parse(localStorage.getItem('instantiate:panes') || 'null');
  for (const key of ['tree', 'symbols', 'links']) {
    if (saved && typeof saved[key] === 'number') sizes[key] = saved[key];
  }
} catch { /* no storage, or it is blocked: the defaults are fine */ }

function rememberPanes() {
  try {
    localStorage.setItem('instantiate:panes', JSON.stringify(sizes));
  } catch { /* nothing to do, and nothing worth telling the reader */ }
}

/** The connections panel grows downwards; the side panes grow rightwards. */
const isVertical = (which) => which === 'links';
const floorFor = (which) => (isVertical(which) ? MIN_LINKS : MIN_PANE);

/** Apply the current sizes without a repaint, so a drag stays smooth. */
function writeSizes() {
  const panes = document.querySelector('.ide-panes');
  if (panes) {
    panes.style.setProperty('--w-tree', sizes.tree + 'px');
    panes.style.setProperty('--w-symbols', sizes.symbols + 'px');
  }
  const links = document.querySelector('.links');
  if (links) links.style.height = sizes.links + 'px';
}

function startResize(event, which) {
  const start = isVertical(which) ? event.clientY : event.clientX;
  const from = sizes[which];
  event.preventDefault();
  document.body.classList.add(isVertical(which) ? 'is-resizing-y' : 'is-resizing');

  const onMove = (move) => {
    const now = isVertical(which) ? move.clientY : move.clientX;
    sizes[which] = Math.max(floorFor(which), from + (now - start));
    writeSizes();
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.body.classList.remove('is-resizing', 'is-resizing-y');
    rememberPanes();
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function navigate(file, symbol) {
  if (!file) return;
  const current = history[cursor];
  // Re-selecting exactly where you already are is not a step.
  if (current && current.file === file && current.symbol === (symbol || null)) return;

  history.length = cursor + 1;
  history.push({ file, symbol: symbol || null });
  cursor = history.length - 1;
  apply();
}

function go(delta) {
  const next = cursor + delta;
  if (next < 0 || next >= history.length) return;
  cursor = next;
  apply();
}

/** Put the panes where the current history entry says they should be. */
function apply() {
  const entry = history[cursor];
  if (!entry) return;
  openFile = entry.file;
  openSymbol = entry.symbol;
  symbolFilter = '';
  expandedFolds = new Set();
  showMap = false;
  revealInTree(openFile);
  repaintExplorer();
}

/**
 * A file's name, with its folder when the name alone says nothing.
 *
 * A trail reading "index.ts › cookie.ts › index.ts" tells you where you have
 * been only if you already remember, which is the thing the trail is for.
 */
function shortPath(file) {
  const parts = file.split('/');
  const name = parts[parts.length - 1];
  const generic = /^(index|main|mod|init|__init__)\./.test(name);
  return generic && parts.length > 1 ? parts[parts.length - 2] + '/' + name : name;
}

/** The path taken, most recent last, each step a way back to it. */
function trailHtml() {
  if (history.length <= 1) return '';
  const start = Math.max(0, cursor - 5);
  const steps = history.slice(start, cursor + 1);

  return '<nav class="trail" aria-label="Path taken">' +
      (start > 0 ? '<span class="trail-more">…</span>' : '') +
      steps.map((entry, i) => {
        const index = start + i;
        const label = entry.symbol
          ? esc(shortPath(entry.file)) + ' · ' + esc(entry.symbol.split('#')[1].split('.').pop())
          : esc(shortPath(entry.file));
        return '<button class="trail-step' + (index === cursor ? ' is-here' : '') + '" ' +
          'data-step="' + index + '" title="' + esc(entry.file) + '">' + label + '</button>';
      }).join('<span class="trail-sep">›</span>') +
    '</nav>';
}

/**
 * Open on the file most worth looking at.
 *
 * A tool that opens empty shows nothing of what it does, and the first file
 * alphabetically is almost always the least interesting — a benchmark, a
 * fixture. Rank by the worst thing in each file, then by how much of it.
 */
function mostInteresting() {
  const rank = { high: 3, medium: 2, low: 1 };
  let best = null;
  let bestScore = 0;
  for (const file of DATA.files) {
    if (!file.findings.length) continue;
    const severity = worstSeverity(file.findings);
    const score = (rank[severity] || 0) * 100 + file.findings.length;
    if (score > bestScore) {
      bestScore = score;
      best = file;
    }
  }
  return best ? best.path : (DATA.files[0] && DATA.files[0].path) || null;
}

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

/** Findings anywhere beneath a folder, and the worst severity among them. */
function folderSummary(node) {
  let count = 0;
  let worst = null;
  const rank = { high: 3, medium: 2, low: 1 };
  for (const file of node.files) {
    count += file.findings.length;
    const severity = worstSeverity(file.findings);
    if (severity && (!worst || rank[severity] > rank[worst])) worst = severity;
  }
  for (const dir of node.dirs.values()) {
    const inner = folderSummary(dir);
    count += inner.count;
    if (inner.worst && (!worst || rank[inner.worst] > rank[worst])) worst = inner.worst;
  }
  return { count, worst };
}

/**
 * A tree of 384 files is unusable as a flat list, so folders start closed.
 *
 * Open by default: the path down to whatever file is selected, so the reader
 * can always see where they are, and every folder when a search is running,
 * since a hidden match is the same as no match.
 */
function isOpenFolder(path) {
  if (query) return true;
  if (openFolders.has(path)) return true;
  return !!openFile && openFile.startsWith(path + '/');
}

function treeHtml(node, depth) {
  const parts = [];

  for (const dir of node.dirs.values()) {
    // A folder containing only one folder reads better as one row: src/analysis.
    let label = dir.name;
    let current = dir;
    while (current.files.length === 0 && current.dirs.size === 1) {
      current = [...current.dirs.values()][0];
      label += '/' + current.name;
    }

    const summary = folderSummary(current);
    const open = isOpenFolder(current.path);
    parts.push(
      '<button class="tree-dir' + (summary.worst ? ' sev-' + summary.worst : '') + '" ' +
        'data-folder="' + esc(current.path) + '" style="--depth:' + depth + '" ' +
        'aria-expanded="' + open + '">' +
        '<span class="tree-chevron">' + (open ? '▾' : '▸') + '</span>' +
        '<span class="tree-name">' + esc(label) + '</span>' +
        (summary.count ? '<span class="tree-count">' + summary.count + '</span>' : '') +
      '</button>',
    );
    if (open) parts.push(treeHtml(current, depth + 1));
  }

  for (const file of node.files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
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


/* ---------------------------------------------------------------------------
 * Syntax colouring.
 *
 * Hand-written rather than pulled from a CDN: a report is read offline, from a
 * mail attachment or a stopped train, and a highlighter that fails to load
 * would take the code's legibility with it. It only has to be good enough to
 * separate prose from structure — comments, strings, keywords, names — which
 * is what makes code skimmable.
 *
 * Block comments and template strings span lines, so highlighting carries a
 * little state from one line to the next.
 * ------------------------------------------------------------------------ */

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'new', 'try', 'catch', 'finally', 'throw',
  'typeof', 'instanceof', 'async', 'await', 'yield', 'class', 'extends', 'implements',
  'super', 'this', 'null', 'undefined', 'true', 'false', 'in', 'of', 'delete', 'void',
  'import', 'export', 'from', 'as', 'default', 'interface', 'type', 'enum', 'namespace',
  'declare', 'readonly', 'public', 'private', 'protected', 'static', 'abstract', 'satisfies',
]);

const PY_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue',
  'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'pass',
  'yield', 'global', 'nonlocal', 'assert', 'del', 'in', 'is', 'not', 'and', 'or',
  'None', 'True', 'False', 'async', 'await', 'self', 'cls', 'match', 'case',
]);

const SPAN = { c: 'tok-comment', s: 'tok-string', k: 'tok-keyword', n: 'tok-number',
               t: 'tok-type', f: 'tok-fn', p: 'tok-punct' };

// Built from char codes so no quote or backslash has to survive nesting.
const DOUBLE = String.fromCharCode(34);
const SINGLE = String.fromCharCode(39);
const BACKTICK = String.fromCharCode(96);
const BACKSLASH = String.fromCharCode(92);

/** Highlight one line, given and returning the multi-line state it is inside. */
function highlightLine(text, lang, state) {
  const keywords = lang === 'py' ? PY_KEYWORDS : JS_KEYWORDS;
  let out = '';
  let i = 0;

  // Finish whatever ran past the end of the previous line.
  if (state.block) {
    const close = lang === 'py' ? state.block : '*/';
    const at = text.indexOf(close);
    if (at === -1) return { html: '<span class="' + SPAN.c + '">' + esc(text) + '</span>', state };
    out += '<span class="' + SPAN.c + '">' + esc(text.slice(0, at + close.length)) + '</span>';
    i = at + close.length;
    state = { block: null };
  }

  while (i < text.length) {
    const rest = text.slice(i);

    // Line comment.
    const lineComment = lang === 'py' ? /^#.*/ : /^\\/\\/.*/;
    let m = rest.match(lineComment);
    if (m) { out += '<span class="' + SPAN.c + '">' + esc(m[0]) + '</span>'; break; }

    // Block comment, or a Python docstring, which may not close on this line.
    if (lang !== 'py' && rest.slice(0, 2) === '/*') {
      const close = rest.indexOf('*/', 2);
      if (close === -1) {
        out += '<span class="' + SPAN.c + '">' + esc(rest) + '</span>';
        return { html: out, state: { block: '*/' } };
      }
      out += '<span class="' + SPAN.c + '">' + esc(rest.slice(0, close + 2)) + '</span>';
      i += close + 2;
      continue;
    }
    if (lang === 'py') {
      const triple = DOUBLE + DOUBLE + DOUBLE;
      const tripleSingle = SINGLE + SINGLE + SINGLE;
      const quote = rest.slice(0, 3) === triple
        ? triple
        : rest.slice(0, 3) === tripleSingle
          ? tripleSingle
          : null;
      if (quote) {
        const close = rest.indexOf(quote, 3);
        if (close === -1) {
          out += '<span class="' + SPAN.s + '">' + esc(rest) + '</span>';
          return { html: out, state: { block: quote } };
        }
        out += '<span class="' + SPAN.s + '">' + esc(rest.slice(0, close + 3)) + '</span>';
        i += close + 3;
        continue;
      }
    }

    // A string. Scanned by hand rather than by regular expression: the
    // pattern needs both quote characters and a backslash, and every one of
    // them has to survive being nested inside a template literal.
    const quote = rest[0];
    if (quote === DOUBLE || quote === SINGLE || quote === BACKTICK) {
      let j = 1;
      let closed = false;
      while (j < rest.length) {
        if (rest[j] === BACKSLASH) { j += 2; continue; }
        if (rest[j] === quote) { j += 1; closed = true; break; }
        j += 1;
      }
      const literal = rest.slice(0, j);
      out += '<span class="' + SPAN.s + '">' + esc(literal) + '</span>';
      // Only a template literal may legitimately run past the line.
      if (!closed && quote === BACKTICK) return { html: out, state: { block: BACKTICK } };
      if (!closed) break;
      i += literal.length;
      continue;
    }

    m = rest.match(/^\\d[\\w.]*/);
    if (m) { out += '<span class="' + SPAN.n + '">' + esc(m[0]) + '</span>'; i += m[0].length; continue; }

    m = rest.match(/^[A-Za-z_$][\\w$]*/);
    if (m) {
      const word = m[0];
      const after = rest.slice(word.length).match(/^\\s*\\(/);
      const cls = keywords.has(word)
        ? SPAN.k
        : /^[A-Z]/.test(word)
          ? SPAN.t
          : after
            ? SPAN.f
            : null;
      out += cls ? '<span class="' + cls + '">' + esc(word) + '</span>' : esc(word);
      i += word.length;
      continue;
    }

    m = rest.match(/^[^\\w\\s$]+/);
    if (m) { out += '<span class="' + SPAN.p + '">' + esc(m[0]) + '</span>'; i += m[0].length; continue; }

    m = rest.match(/^\\s+/);
    if (m) { out += esc(m[0]); i += m[0].length; continue; }

    out += esc(rest[0]);
    i += 1;
  }

  return { html: out, state };
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

  const remote = DATA.repo && DATA.repo.blobBase;
  const pathHtml = remote
    ? '<a class="code-path is-link" href="' + esc(remote + '/' + file.path) +
        (selected ? '#L' + selected.line : '') + '" target="_blank" rel="noreferrer" ' +
        'title="Open on ' + esc(DATA.repo.label) + '">' + esc(file.path) + '</a>'
    : '<span class="code-path">' + esc(file.path) + '</span>';

  const head = '<div class="pane-head code-head">' +
      pathHtml +
      '<button class="links-toggle' + (showLinks ? ' is-on' : '') + '" data-links="1" ' +
        'aria-expanded="' + showLinks + '">' +
        '<span class="links-icon">' + (showLinks ? '▾' : '▸') + '</span>' +
        '<span>Connections</span>' +
        '<span class="links-tally">' +
          file.usedBy.length + ' use this · uses ' + file.uses.length +
        '</span>' +
      '</button>' +
      '<span class="code-meta">' + file.loc + ' lines</span>' +
    '</div>' +
    (showLinks
      ? connectionsHtml(file) +
        '<div class="splitter-h" data-split="links" role="separator" aria-orientation="horizontal" ' +
          'tabindex="0" aria-label="Resize the connections panel"></div>'
      : '');

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

  /*
   * Fold the quiet stretches.
   *
   * A finding sits inside a file of hundreds of lines, and scrolling past the
   * untouched ones to find it is the work this page is meant to remove. Lines
   * near something worth reading stay; long runs of nothing collapse to a row
   * that says how many, and opens when clicked.
   */
  const CONTEXT = 4;
  const MIN_FOLD = 10;
  const keep = new Set();
  const total = file.source.length;
  const mark = (from, to) => {
    for (let n = Math.max(1, from - CONTEXT); n <= Math.min(total, to + CONTEXT); n++) keep.add(n);
  };
  for (const m of file.marks) mark(m.from, m.to);
  if (focusFrom !== null) mark(focusFrom, focusTo);
  // A file with nothing to say about it is shown whole rather than folded away.
  if (keep.size === 0) for (let n = 1; n <= total; n++) keep.add(n);
  for (const n of expandedFolds) keep.add(n);

  const lang = /\\.(py)$/.test(file.path) ? 'py' : 'js';
  let state = { block: null };
  const rows = [];
  let n = 1;

  while (n <= total) {
    if (keep.has(n)) {
      const severity = lineSeverity.get(n);
      const inFocus = focusFrom !== null && n >= focusFrom && n <= focusTo;
      const highlighted = highlightLine(file.source[n - 1], lang, state);
      state = highlighted.state;
      const cls = 'code-line' + (severity ? ' sev-' + severity : '') + (inFocus ? ' is-focus' : '');
      rows.push(
        '<div class="' + cls + '"' + (inFocus && n === focusFrom ? ' id="focus-line"' : '') +
          (severity ? ' data-finding="' + esc(lineFinding.get(n)) + '"' : '') + '>' +
          '<span class="code-n">' + n + '</span>' +
          '<span class="code-text">' + (highlighted.html || ' ') + '</span></div>',
      );
      n++;
      continue;
    }

    let end = n;
    while (end <= total && !keep.has(end)) end++;
    const length = end - n;

    if (length < MIN_FOLD) {
      // Too short to be worth hiding; show it and keep the highlighter in step.
      for (let k = n; k < end; k++) {
        const highlighted = highlightLine(file.source[k - 1], lang, state);
        state = highlighted.state;
        rows.push(
          '<div class="code-line"><span class="code-n">' + k + '</span>' +
            '<span class="code-text">' + (highlighted.html || ' ') + '</span></div>',
        );
      }
    } else {
      // Folded lines still pass through the highlighter, or a block comment
      // opened inside the fold would colour everything after it.
      for (let k = n; k < end; k++) state = highlightLine(file.source[k - 1], lang, state).state;
      rows.push(
        '<button class="fold" data-fold="' + n + '" data-fold-end="' + (end - 1) + '">' +
          '<span class="fold-mark">⋯</span>' +
          '<span class="fold-text">' + length + ' unremarkable lines</span>' +
        '</button>',
      );
    }
    n = end;
  }

  return head + '<div class="pane-scroll code-scroll">' + actions +
    '<div class="code">' + rows.join('') + '</div></div>';
}

/**
 * What reaches this file, and what it reaches.
 *
 * Answered at the file level because that is the question people ask before
 * they ask about a function: is this change contained, or does it touch half
 * the codebase.
 */
function connectionsHtml(file) {
  const column = (label, links, empty) => {
    if (links.length === 0) {
      return '<div class="links-col"><span class="refs-label">' + label + '</span>' +
        '<span class="refs-none">' + empty + '</span></div>';
    }
    const rows = links.slice(0, 40).map((link) =>
      '<button class="link-row" data-file="' + esc(link.path) + '">' +
        '<span class="link-path">' + esc(link.path) + '</span>' +
        '<span class="link-count" title="' + link.count + ' symbols involved">' +
          link.count + (link.count === 1 ? ' symbol' : ' symbols') +
        '</span>' +
      '</button>').join('');
    const more = links.length > 40
      ? '<span class="refs-none">and ' + (links.length - 40) + ' more</span>'
      : '';
    return '<div class="links-col">' +
      '<span class="refs-label">' + label + ' (' + links.length + ')</span>' +
      '<div class="link-list">' + rows + more + '</div></div>';
  };

  return '<div class="links" style="height:' + sizes.links + 'px">' +
      '<p class="links-lede">Every file connected to this one. Click any of them to go there — ' +
        'the trail above keeps your way back.</p>' +
      '<div class="links-cols">' +
        column('Files that use ' + esc(file.path.split('/').pop()),
          file.usedBy, 'Nothing in this codebase imports or calls it.') +
        column('Files it uses',
          file.uses, 'It depends on nothing else here.') +
      '</div>' +
    '</div>';
}


/**
 * One finding, stated as a problem and a remedy.
 *
 * Collapsed to the two lines that matter — what is wrong, and what to do —
 * because the code is what the reader came for, and three expanded cards push
 * it off the screen entirely. The reasoning is a click away.
 */
function actionCard(finding) {
  const open = expandedActions.has(finding.id);
  return '<div class="action ' + finding.severity + (open ? ' is-open' : '') + '">' +
      '<button class="action-head" data-action="' + esc(finding.id) + '" aria-expanded="' + open + '">' +
        '<span class="sev ' + finding.severity + '">' + finding.severity + '</span>' +
        '<span class="action-title">' + esc(finding.title) + '</span>' +
        '<span class="action-score">' + Math.round(finding.score * 100) + '%</span>' +
        '<span class="action-chevron">' + (open ? '▾' : '▸') + '</span>' +
      '</button>' +
      (finding.action ? '<p class="action-do"><strong>Do:</strong> ' + esc(finding.action) + '</p>' : '') +
      (open
        ? '<div class="action-more">' +
            '<p class="action-detail">' + esc(finding.detail) + '</p>' +
            (finding.kind === 'drift' ? driftBars(finding) : '') +
            (finding.kind === 'contradiction' ? conflictTable(finding) : '') +
            (finding.kind === 'duplicate' && finding.snippets.length > 1
              ? '<div class="snips side-by-side">' + finding.snippets.map(snippetHtml).join('') + '</div>'
              : '') +
          '</div>'
        : '') +
    '</div>';
}

/**
 * One bar.
 *
 * The title, the numbers and the controls were three rows of chrome above a
 * page whose whole point is the code beneath them. They say little enough
 * between them to share a line, and the line they share is the only one that
 * is not code.
 */
function toolbarHtml(files) {
  const s = DATA.stats;
  const clean = s.loc > 0 ? (1 - (s.deadLoc + s.duplicateLoc) / s.loc) * 100 : 100;
  const stat = (value, label, state) =>
    '<span class="stat' + (state ? ' is-' + state : '') + '">' +
      '<span class="stat-n">' + value + '</span>' +
      '<span class="stat-l">' + label + '</span></span>';

  return '<div class="ide-bar">' +
      '<span class="bar-title">' +
        '<span class="bar-line">' +
          '<strong>' + esc(DATA.title) + '</strong>' +
          '<span class="bar-meta">' + s.files + ' files · ' + s.loc.toLocaleString('en-GB') + ' lines</span>' +
        '</span>' +
        (DATA.repo
          ? '<a class="bar-repo" href="' + esc(DATA.repo.url) + '" target="_blank" rel="noreferrer">' +
              esc(DATA.repo.label) + '</a>'
          : '') +
      '</span>' +
      '<span class="nav-pair">' +
        '<button class="nav-btn" data-nav="back" title="Back (alt + left arrow)" ' +
          (cursor > 0 ? '' : 'disabled ') + 'aria-label="Back">‹</button>' +
        '<button class="nav-btn" data-nav="forward" title="Forward (alt + right arrow)" ' +
          (cursor < history.length - 1 ? '' : 'disabled ') + 'aria-label="Forward">›</button>' +
      '</span>' +
      '<input id="ex-search" class="ex-search" type="search" placeholder="Search files and symbols" ' +
        'value="' + esc(query) + '" autocomplete="off">' +
      '<span class="ex-count">' + files.length + '/' + DATA.files.length + '</span>' +
      '<button class="chip' + (showMap ? ' is-on' : '') + '" data-view="map" ' +
        'aria-pressed="' + showMap + '">map</button>' +
      '<span class="stats">' +
        stat(clean.toFixed(1) + '%', 'load-bearing', clean >= 95 ? 'clean' : 'alert') +
        stat(s.deadLoc.toLocaleString('en-GB'), 'dead', s.deadLoc === 0 ? 'clean' : '') +
        stat(s.duplicateLoc.toLocaleString('en-GB'), 'duplicated', s.duplicateLoc === 0 ? 'clean' : '') +
        stat(String(s.driftCount), 'drifting', s.driftCount === 0 ? 'clean' : '') +
        stat(String(s.contradictionCount), 'conflicting', s.contradictionCount === 0 ? 'clean' : 'alert') +
      '</span>' +
    '</div>';
}

function explorer() {
  const files = matchingFiles();
  return '<div class="ide">' +
      toolbarHtml(files) +
      trailHtml() +
      '<div class="ide-panes" style="--w-tree:' + sizes.tree + 'px;--w-symbols:' + sizes.symbols + 'px">' +
        '<nav class="ide-tree" aria-label="Files">' + treeHtml(buildTree(files), 0) + '</nav>' +
        '<div class="splitter" data-split="tree" role="separator" aria-orientation="vertical" ' +
          'tabindex="0" aria-label="Resize the file tree"></div>' +
        '<section class="ide-symbols" aria-label="Symbols">' + symbolsPane() + '</section>' +
        '<div class="splitter" data-split="symbols" role="separator" aria-orientation="vertical" ' +
          'tabindex="0" aria-label="Resize the symbol list"></div>' +
        '<section class="ide-code" aria-label="' + (showMap ? 'Map' : 'Source') + '">' +
          (showMap ? mapPane() : codePane()) +
        '</section>' +
      '</div>' +
    '</div>';
}

/** The overview, as a view of the third pane rather than a separate page. */
function mapPane() {
  return '<div class="pane-head code-head">' +
      '<span class="code-path">Every file, sized by lines, shaded by findings</span>' +
      '<span class="code-meta">click to open</span>' +
    '</div>' +
    '<p class="legend">' +
      '<span><span class="swatch" style="background:var(--heat0)"></span>clean</span>' +
      '<span><span class="swatch" style="background:var(--heat1)"></span>some findings</span>' +
      '<span><span class="swatch" style="background:var(--heat2)"></span>mostly findings</span>' +
      '<span class="legend-note">box size = lines of code</span>' +
    '</p>' +
    '<div class="pane-scroll map-scroll">' +
      '<div class="map-wrap">' + treemap() + '</div>' +
    '</div>';
}

/** Open every folder on the way down to a file, so it can be seen. */
function revealInTree(path) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) openFolders.add(parts.slice(0, i).join('/'));
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
  app.innerHTML =
    (DATA.warnings.length
      ? '<div class="warnings">' + DATA.warnings.map((w) => '<p class="warn">' + esc(w) + '</p>').join('') + '</div>'
      : '') +
    '<div id="explorer-host" class="shell-body">' + explorer() + '</div>' +
    '<footer>Generated by <strong>instantiate</strong> on ' + DATA.generatedAt + '. ' +
      'A static graph cannot see dynamic dispatch, so treat low-confidence findings as ' +
      'questions, not facts.</footer>';
}

app.addEventListener('pointerdown', (event) => {
  const splitter = event.target.closest('[data-split]');
  if (splitter) startResize(event, splitter.dataset.split);
});

// The keyboard reaches the splitters too, since a drag is not available to
// everybody.
app.addEventListener('keydown', (event) => {
  const splitter = event.target.closest('[data-split]');
  if (!splitter) return;
  const which = splitter.dataset.split;
  const step = event.shiftKey ? 48 : 16;
  const [less, more] = isVertical(which) ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
  const delta = event.key === less ? -step : event.key === more ? step : 0;
  if (!delta) return;
  event.preventDefault();
  sizes[which] = Math.max(floorFor(which), sizes[which] + delta);
  rememberPanes();
  writeSizes();
});

app.addEventListener('click', (event) => {
  // A call site: open that file and land on the symbol it names.
  const ref = event.target.closest('.ref[data-file]');
  if (ref) {
    const target = FILES.get(ref.dataset.file);
    const wanted = ref.dataset.symbol;
    const match = target && wanted ? target.symbols.find((sym) => sym.name === wanted) : null;
    navigate(ref.dataset.file, match ? match.id : null);
    return;
  }

  const view = event.target.closest('[data-view]');
  if (view) {
    showMap = !showMap;
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
    // Closing a symbol is not a move; opening one is a step into it.
    if (openSymbol === symButton.dataset.symbol) {
      openSymbol = null;
      repaintExplorer();
    } else {
      navigate(openFile, symButton.dataset.symbol);
    }
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

  const links = event.target.closest('[data-links]');
  if (links) {
    showLinks = !showLinks;
    repaintExplorer();
    return;
  }

  const linkRow = event.target.closest('.link-row[data-file]');
  if (linkRow) {
    navigate(linkRow.dataset.file, null);
    return;
  }

  const step = event.target.closest('[data-step]');
  if (step) {
    cursor = Number(step.dataset.step);
    apply();
    return;
  }

  const nav = event.target.closest('[data-nav]');
  if (nav) {
    go(nav.dataset.nav === 'back' ? -1 : 1);
    return;
  }

  const action = event.target.closest('[data-action]');
  if (action) {
    const id = action.dataset.action;
    if (expandedActions.has(id)) expandedActions.delete(id);
    else expandedActions.add(id);
    repaintExplorer();
    return;
  }

  const folder = event.target.closest('[data-folder]');
  if (folder) {
    const path = folder.dataset.folder;
    if (openFolders.has(path)) openFolders.delete(path);
    else openFolders.add(path);
    repaintExplorer();
    return;
  }

  const fold = event.target.closest('[data-fold]');
  if (fold) {
    const from = Number(fold.dataset.fold);
    const to = Number(fold.dataset.foldEnd);
    for (let n = from; n <= to; n++) expandedFolds.add(n);
    repaintExplorer();
    return;
  }

  const fileButton = event.target.closest('[data-file]');
  if (fileButton) {
    navigate(fileButton.dataset.file, null);
    return;
  }

  // The map is a way in, not somewhere to stay: picking a file returns to it.
  const box = event.target.closest('[data-path]');
  if (box) {
    navigate(box.dataset.path, null);
  }
});

const first = mostInteresting();
if (first) {
  history.push({ file: first, symbol: null });
  cursor = 0;
  openFile = first;
  revealInTree(first);
}
render();

// Alt and an arrow, the same keys a browser uses.
document.addEventListener('keydown', (event) => {
  if (!event.altKey) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); go(1); }
});
`;
