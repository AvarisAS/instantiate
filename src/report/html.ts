import { basename } from 'node:path';
import type { ScanResult } from '../api.js';
import type { Finding, Concept } from '../types.js';
import { layout, treeFromPaths, type LaidOut } from './treemap.js';
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
  concepts: Array<Concept & { x: number; y: number; r: number }>;
  findings: Array<Finding & { snippets: Snippet[] }>;
  fileFindings: Record<string, string[]>;
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
    concepts: placeConcepts(result.concepts),
    findings: findings.map((finding) => ({
      ...finding,
      snippets: snippetsFor(result, finding),
    })),
    fileFindings: Object.fromEntries(
      [...perFile.entries()].filter(([, e]) => e.findings.length > 0).map(([path, e]) => [path, e.findings]),
    ),
  };
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

/**
 * Lay the concepts out on a circle, largest first, alternating sides.
 *
 * Thirty bubbles is a drawable number, which is the only reason a node-link
 * picture is honest here at all. A force simulation would need a runtime library
 * and would move on every run; a deterministic ring means two scans of the same
 * code produce the same map, so a human can recognise it.
 */
function placeConcepts(concepts: Concept[]): Array<Concept & { x: number; y: number; r: number }> {
  const maxLoc = Math.max(...concepts.map((c) => c.loc), 1);
  const count = concepts.length || 1;

  return concepts.map((concept, i) => {
    // Interleave so that big neighbours do not all crowd one arc.
    const slot = i % 2 === 0 ? i / 2 : count - 1 - (i - 1) / 2;
    const angle = (slot / count) * Math.PI * 2 - Math.PI / 2;
    // Larger concepts sit nearer the middle: importance reads as centrality.
    const radius = 210 - 70 * (concept.loc / maxLoc);
    return {
      ...concept,
      x: round(320 + Math.cos(angle) * radius),
      y: round(300 + Math.sin(angle) * radius * 0.82),
      r: round(20 + 42 * Math.sqrt(concept.loc / maxLoc)),
    };
  });
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
:root {
  --bg: #fbfaf8; --panel: #ffffff; --ink: #1a1a19; --muted: #6b6a66;
  --line: #e4e2dd; --accent: #2f6f4f;
  --high: #b4432c; --medium: #b8862f; --low: #8a8880;
  --heat0: #e8e6e1; --heat1: #b4432c;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --sans: ui-sans-serif, -apple-system, "Segoe UI", Inter, sans-serif;
}
:root:not([data-theme="light"]) { }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #141414; --panel: #1c1c1b; --ink: #ecebe7; --muted: #918f88;
    --line: #2e2e2c; --accent: #6bbd8f;
    --high: #e0705a; --medium: #d9a441; --low: #7d7b74;
    --heat0: #262625; --heat1: #e0705a;
  }
}
:root[data-theme="dark"] {
  --bg: #141414; --panel: #1c1c1b; --ink: #ecebe7; --muted: #918f88;
  --line: #2e2e2c; --accent: #6bbd8f;
  --high: #e0705a; --medium: #d9a441; --low: #7d7b74;
  --heat0: #262625; --heat1: #e0705a;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: var(--sans); font-size: 15px; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
#app { max-width: 1100px; margin: 0 auto; padding: 40px 16px 120px; }
h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -0.02em; font-weight: 600; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.09em;
     color: var(--muted); font-weight: 600; margin: 56px 0 6px; }
.sub { color: var(--muted); font-size: 14px; margin: 0 0 8px; }
.lede { color: var(--muted); font-size: 14px; margin: 0 0 20px; max-width: 62ch; }

.headline { display: flex; flex-wrap: wrap; gap: 10px; margin: 28px 0 8px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
        padding: 14px 18px; flex: 1 1 150px; }
.tile .n { font-size: 26px; font-weight: 600; letter-spacing: -0.02em;
           font-variant-numeric: tabular-nums; display: block; }
.tile .l { font-size: 12px; color: var(--muted); }

.warn { background: var(--panel); border: 1px solid var(--medium); border-left-width: 3px;
        border-radius: 8px; padding: 12px 16px; margin: 16px 0; font-size: 14px; }

.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
         padding: 16px; overflow: hidden; }
svg { display: block; width: 100%; height: auto; }
.box { stroke: var(--bg); stroke-width: 1; cursor: pointer; }
.box:hover { stroke: var(--accent); stroke-width: 2; }
.box-label { font-family: var(--mono); font-size: 9px; fill: var(--ink);
             pointer-events: none; opacity: 0.75; }
.dir-label { font-family: var(--sans); font-size: 10px; fill: var(--muted);
             pointer-events: none; font-weight: 600; }
.concept { cursor: pointer; }
.concept circle { fill: var(--accent); fill-opacity: 0.14; stroke: var(--accent); stroke-width: 1.5; }
.concept:hover circle { fill-opacity: 0.3; }
.concept text { font-size: 11px; fill: var(--ink); text-anchor: middle; pointer-events: none; }
.concept .loc { font-size: 9px; fill: var(--muted); }
.edge { stroke: var(--muted); stroke-opacity: 0.25; fill: none; }

.finding { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
           margin: 8px 0; overflow: hidden; }
.finding summary { padding: 13px 16px; cursor: pointer; display: flex; gap: 12px;
                   align-items: baseline; list-style: none; }
.finding summary::-webkit-details-marker { display: none; }
.finding summary:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.sev { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 700;
       flex: 0 0 52px; padding-top: 2px; }
.sev.high { color: var(--high); } .sev.medium { color: var(--medium); } .sev.low { color: var(--low); }
.f-title { flex: 1 1 auto; font-weight: 500; }
.f-meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums;
          font-family: var(--mono); flex: 0 0 auto; }
.f-body { padding: 0 16px 16px; border-top: 1px solid var(--line); }
.f-detail { color: var(--muted); font-size: 14px; margin: 12px 0; max-width: 70ch; }

.snips { display: grid; gap: 10px; grid-template-columns: 1fr; }
.snips.side-by-side { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
pre { margin: 0; background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
      padding: 10px 12px; overflow-x: auto; font-family: var(--mono); font-size: 11.5px;
      line-height: 1.5; }
pre .ln { color: var(--muted); opacity: 0.55; user-select: none; display: inline-block;
          width: 3ch; text-align: right; margin-right: 10px; }
.snip-head { font-family: var(--mono); font-size: 11px; color: var(--muted); margin: 0 0 4px; }

.variants { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
.variants th { text-align: left; font-weight: 600; color: var(--muted); font-size: 11px;
               text-transform: uppercase; letter-spacing: 0.06em; padding: 0 10px 6px 0; }
.variants td { padding: 5px 10px 5px 0; border-top: 1px solid var(--line);
               font-family: var(--mono); font-size: 12px; }
.variants code { background: color-mix(in srgb, var(--high) 14%, transparent);
                 padding: 1px 6px; border-radius: 4px; }
.bars { display: grid; gap: 4px; margin: 12px 0; }
.bar-row { display: grid; grid-template-columns: minmax(110px, 160px) 1fr 44px; gap: 10px;
           align-items: center; font-size: 12.5px; }
.bar-track { height: 9px; background: var(--heat0); border-radius: 5px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 5px; }
.bar-row.minor .bar-fill { background: var(--medium); }
.bar-num { font-family: var(--mono); font-size: 11px; color: var(--muted); text-align: right; }

.filters { display: flex; gap: 6px; flex-wrap: wrap; margin: 14px 0 4px; }
.filters button { background: var(--panel); border: 1px solid var(--line); color: var(--muted);
                  border-radius: 999px; padding: 5px 13px; font-size: 12.5px; cursor: pointer;
                  font-family: inherit; }
.filters button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent);
                                       background: color-mix(in srgb, var(--accent) 10%, transparent); }
.crumb { font-family: var(--mono); font-size: 12px; color: var(--muted); margin: 10px 0 0;
         min-height: 18px; }
.crumb button { background: none; border: none; color: var(--accent); cursor: pointer;
                font: inherit; padding: 0; text-decoration: underline; }
.legend { display: flex; gap: 14px; align-items: center; color: var(--muted);
          font-size: 11.5px; margin-top: 10px; flex-wrap: wrap; }
.swatch { display: inline-block; width: 11px; height: 11px; border-radius: 3px;
          vertical-align: -1px; margin-right: 5px; }
footer { margin-top: 64px; padding-top: 18px; border-top: 1px solid var(--line);
         color: var(--muted); font-size: 12.5px; }
@media (max-width: 640px) {
  #app { padding: 24px 16px 80px; }
  h1 { font-size: 22px; }
  .finding summary { flex-wrap: wrap; gap: 6px 10px; }
  .bar-row { grid-template-columns: 96px 1fr 40px; }
}
`;

const SCRIPT = `
const DATA = JSON.parse(document.getElementById('data').textContent);
const app = document.getElementById('app');
let filter = 'all';

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

function conceptMap() {
  const cs = DATA.concepts;
  if (cs.length < 2) return '<p class="lede">Too few symbols to cluster.</p>';
  const byId = new Map(cs.map((c) => [c.id, c]));
  const parts = ['<svg viewBox="0 0 640 600" role="img" aria-label="Concepts in this codebase and how they depend on each other">'];

  const maxWeight = Math.max(1, ...cs.flatMap((c) => c.couples.map((k) => k.weight)));
  for (const c of cs) {
    for (const link of c.couples.slice(0, 3)) {
      const t = byId.get(link.to);
      if (!t) continue;
      parts.push('<line class="edge" x1="' + c.x + '" y1="' + c.y + '" x2="' + t.x + '" y2="' + t.y +
        '" stroke-width="' + (0.5 + (link.weight / maxWeight) * 3).toFixed(2) + '"/>');
    }
  }

  for (const c of cs) {
    parts.push('<g class="concept" data-concept="' + c.id + '">' +
      '<circle cx="' + c.x + '" cy="' + c.y + '" r="' + c.r + '"/>' +
      '<text x="' + c.x + '" y="' + (c.y - 1) + '">' + esc(c.name) + '</text>' +
      '<text class="loc" x="' + c.x + '" y="' + (c.y + 12) + '">' + c.loc + ' lines</text>' +
      '<title>' + esc(c.name) + '\\n' + esc(c.description) + '</title></g>');
  }
  parts.push('</svg>');
  return parts.join('');
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

function findingHtml(f) {
  const sideBySide = (f.kind === 'duplicate' || f.kind === 'contradiction') && f.snippets.length > 1;
  const unit = f.kind === 'contradiction' ? f.loc + ' sites' : f.loc + 'L';
  return '<details class="finding" id="' + esc(f.id) + '" data-kind="' + f.kind + '">' +
    '<summary>' +
      '<span class="sev ' + f.severity + '">' + f.severity + '</span>' +
      '<span class="f-title">' + esc(f.title) + '</span>' +
      '<span class="f-meta">' + unit + ' · ' + Math.round(f.score * 100) + '%</span>' +
    '</summary>' +
    '<div class="f-body">' +
      '<p class="f-detail">' + esc(f.detail) + '</p>' +
      (f.kind === 'drift' ? driftBars(f) : '') +
      (f.kind === 'contradiction' ? conflictTable(f) : '') +
      '<div class="snips' + (sideBySide ? ' side-by-side' : '') + '">' +
        f.snippets.map(snippetHtml).join('') +
      '</div>' +
    '</div>' +
  '</details>';
}

function findingsSection() {
  const all = DATA.findings;
  const list = filter === 'all' ? all : all.filter((f) => f.kind === filter);
  const counts = { all: all.length };
  for (const f of all) counts[f.kind] = (counts[f.kind] || 0) + 1;

  const tabs = ['all', 'dead', 'duplicate', 'contradiction', 'drift']
    .filter((k) => k === 'all' || counts[k])
    .map((k) => '<button data-filter="' + k + '" aria-pressed="' + (filter === k) + '">' +
      k + ' <span class="bar-num">' + (counts[k] || 0) + '</span></button>').join('');

  return '<div class="filters">' + tabs + '</div>' +
    '<p class="crumb" id="crumb"></p>' +
    (list.length
      ? list.map(findingHtml).join('')
      : '<p class="lede">Nothing here. That is the good outcome.</p>');
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
      '<div class="tile"><span class="n">' + clean.toFixed(1) + '%</span>' +
        '<span class="l">load-bearing</span></div>' +
      '<div class="tile"><span class="n">' + s.deadLoc.toLocaleString('en-GB') + '</span>' +
        '<span class="l">lines nothing reaches</span></div>' +
      '<div class="tile"><span class="n">' + s.duplicateLoc.toLocaleString('en-GB') + '</span>' +
        '<span class="l">lines of re-implementation</span></div>' +
      '<div class="tile"><span class="n">' + s.driftCount + '</span>' +
        '<span class="l">conventions done two ways</span></div>' +
      '<div class="tile"><span class="n">' + s.contradictionCount + '</span>' +
        '<span class="l">values stated two ways</span></div>' +
    '</div>' +

    '<h2>The map</h2>' +
    '<p class="lede">Every file, sized by lines and shaded by how much of it is implicated ' +
      'in a finding. Click a file to see what is wrong with it.</p>' +
    '<div class="panel">' + treemap() + '</div>' +
    '<p class="legend">' +
      '<span><span class="swatch" style="background:var(--heat0)"></span>clean</span>' +
      '<span><span class="swatch" style="background:' + heatColour(0.5) + '"></span>some findings</span>' +
      '<span><span class="swatch" style="background:' + heatColour(1) + '"></span>mostly findings</span>' +
      '<span>box size = lines of code</span>' +
    '</p>' +

    '<h2>What this codebase is made of</h2>' +
    '<p class="lede">The graph collapsed into ' + DATA.concepts.length + ' groups, sized by lines, ' +
      'linked where one depends on another. Larger groups sit nearer the centre.</p>' +
    '<div class="panel">' + conceptMap() + '</div>' +

    '<h2>What to do about it</h2>' +
    '<p class="lede">Ranked by confidence times size: the top of this list is where deleting ' +
      'or merging buys the most understanding for the least risk.</p>' +
    '<div id="findings">' + findingsSection() + '</div>' +

    '<footer>Generated by <strong>instantiate</strong>. ' +
      'A static graph cannot see dynamic dispatch, so treat low-confidence findings as questions, ' +
      'not facts.</footer>';
}

app.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-filter]');
  if (tab) {
    filter = tab.dataset.filter;
    document.getElementById('findings').innerHTML = findingsSection();
    return;
  }

  const box = event.target.closest('[data-path]');
  if (box) {
    // Zoom, not lateral wander: a click always lands on the findings for that
    // file, and the breadcrumb says where you are and how to get back.
    const ids = DATA.fileFindings[box.dataset.path] || [];
    const crumb = document.getElementById('crumb');
    filter = 'all';
    document.getElementById('findings').innerHTML = findingsSection();
    const target = ids.map((id) => document.getElementById(id)).find(Boolean);
    const c = document.getElementById('crumb');
    if (target) {
      target.open = true;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      c.innerHTML = box.dataset.path + ' — ' + ids.length + ' finding' +
        (ids.length === 1 ? '' : 's') + ' · <button data-clear>show everything</button>';
    } else {
      c.innerHTML = box.dataset.path + ' — clean · <button data-clear>show everything</button>';
    }
    return;
  }

  const concept = event.target.closest('[data-concept]');
  if (concept) {
    const c = DATA.concepts[Number(concept.dataset.concept)];
    if (c) {
      document.getElementById('crumb').innerHTML = esc(c.name) + ' — ' + esc(c.description) +
        ' · <button data-clear>show everything</button>';
      document.getElementById('crumb').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  if (event.target.closest('[data-clear]')) {
    document.getElementById('crumb').textContent = '';
  }
});

render();
`;
