/**
 * Builds the website: a landing page, a page of popular libraries scanned by
 * instantiate, and the full report for each of them.
 *
 *     npx tsx scripts/build-site.ts --out _site
 *
 * Libraries are listed in site/libraries.json, each pinned to a commit so the
 * numbers on the page can be reproduced. Clones are cached between runs in
 * $SITE_CACHE (default: the system temp folder).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/api.js';
import { renderHtmlReport } from '../src/report/html.js';
import { THEME_TOKENS, iconSvg } from '../src/report/theme.js';

interface Library {
  slug: string;
  name: string;
  repo: string;
  ref: string;
  language: string;
  about: string;
}

interface Scanned extends Library {
  files: number;
  loc: number;
  deadLoc: number;
  duplicateLoc: number;
  drift: number;
  conflicts: number;
  unfinished: number;
  loadBearing: number;
  top: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outArg = process.argv.indexOf('--out');
const out = outArg > -1 ? process.argv[outArg + 1] : join(root, '_site');
const cache = process.env.SITE_CACHE ?? join(tmpdir(), 'instantiate-site-cache');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string };
const libraries = JSON.parse(readFileSync(join(root, 'site', 'libraries.json'), 'utf8')) as Library[];

mkdirSync(join(out, 'reports'), { recursive: true });

/** A shallow checkout of exactly the pinned commit. */
function checkout(library: Library): string {
  const dir = join(cache, library.slug);
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git('init', '-q');
    git('remote', 'add', 'origin', library.repo);
  }
  let head = '';
  try {
    head = git('rev-parse', 'HEAD');
  } catch {
    // A fresh repository has no HEAD yet.
  }
  if (head !== library.ref) {
    git('fetch', '-q', '--depth', '1', 'origin', library.ref);
    git('checkout', '-q', '--force', 'FETCH_HEAD');
  }
  return dir;
}

const scanned: Scanned[] = [];
for (const library of libraries) {
  const dir = checkout(library);
  const result = await scan({ root: dir });
  // The report links files to the pinned commit on the remote, not to a branch that moves.
  result.repo = { url: library.repo.replace(/\.git$/, ''), ref: library.ref, blobPath: 'blob' } as typeof result.repo;
  writeFileSync(join(out, 'reports', `${library.slug}.html`), renderHtmlReport(result, result.findings));

  const s = result.stats;
  const confident = result.findings.filter((f) => f.score >= 0.5);
  scanned.push({
    ...library,
    files: s.files,
    loc: s.loc,
    deadLoc: s.deadLoc,
    duplicateLoc: s.duplicateLoc,
    drift: s.driftCount,
    conflicts: s.contradictionCount,
    unfinished: s.unfinishedCount,
    loadBearing: s.loc > 0 ? (1 - (s.deadLoc + s.duplicateLoc) / s.loc) * 100 : 100,
    top: confident.slice(0, 3).map((f) => f.title),
  });
  console.log(`${library.name.padEnd(14)} ${String(s.files).padStart(4)} files, ${confident.length} findings`);
}

const generated = new Date().toISOString().slice(0, 10);

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function number(n: number): string {
  return n.toLocaleString('en-GB');
}

function page(title: string, current: 'home' | 'libraries', body: string): string {
  const nav = (href: string, label: string, icon: string, key?: string): string =>
    `<a class="chip${key === current ? ' is-on' : ''}" href="${href}"${key === current ? ' aria-current="page"' : ''}>${iconSvg(icon)}${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="Find dead code, duplicates, contradictions and unfinished work in TypeScript, JavaScript, Python, Go and Swift. Runs locally.">
<style>${THEME_TOKENS}${SITE_STYLE}</style>
</head>
<body>
<header class="site-bar">
  <a class="brand" href="index.html">instantiate</a>
  <span class="version">v${esc(pkg.version)}</span>
  <nav class="nav">
    ${nav('libraries.html', 'Libraries', 'grid', 'libraries')}
    ${nav('https://github.com/AvarisAS/instantiate/tree/main/docs', 'Docs', 'code')}
    ${nav('https://github.com/AvarisAS/instantiate', 'GitHub', 'external')}
  </nav>
</header>
<main>${body}</main>
<footer class="foot">
  MIT licence · ${esc(pkg.name)} · built ${generated}
</footer>
</body>
</html>
`;
}

function home(): string {
  const finds: Array<[string, string, string, string]> = [
    ['high', 'Dead code', 'Functions, classes and whole files nothing reaches.', 'export function formatLegacyDate(…) // 0 callers'],
    ['medium', 'Duplicates', 'The same job written twice, by people who could not find the first.', 'formatDuration · prettyTime · humanizeMs'],
    ['high', 'Contradictions', 'One setting with two values in different places.', 'DEFAULT_CONCURRENCY = 1024 · = 2'],
    ['medium', 'Unfinished work', 'State nothing ever sets, and bodies that only say not implemented.', "let query = ''  // read in 2 conditions, never set"],
    ['low', 'Drift', 'One job done several ways, with no convention winning.', 'async/await 71% · promise chains 29%'],
  ];
  const example = scanned.find((l) => l.slug === 'hono') ?? scanned[0];
  return `
<section class="hero">
  <h1>See what's actually in your codebase.</h1>
  <p class="lede">Dead code, duplicates, contradictions, unfinished work and inconsistent conventions, ranked into a worklist. Every finding says what to do about it.</p>
  <pre class="cmd"><span class="tok-comment"># install</span>
npm i -D ${esc(pkg.name)}

<span class="tok-comment"># ranked findings in the terminal</span>
npx instantiate scan

<span class="tok-comment"># a self-contained code browser</span>
npx instantiate report --out report.html</pre>
  <p class="actions">
    <a class="chip is-on" href="libraries.html">${iconSvg('grid')}Browse scanned libraries</a>
    <a class="chip" href="reports/${example.slug}.html">${iconSvg('code')}Open an example report (${esc(example.name)})</a>
  </p>
  <p class="langs">TypeScript · JavaScript · Python · Go · Swift. Runs locally, no account, no upload.</p>
</section>

<section>
  <h2>What it finds</h2>
  <ul class="finds">
    ${finds
      .map(
        ([severity, title, text, sample]) =>
          `<li class="find sev-${severity}"><h3>${title}</h3><p>${text}</p><code>${esc(sample)}</code></li>`,
      )
      .join('')}
  </ul>
</section>

<section class="two">
  <div>
    <h2>In CI, a ratchet</h2>
    <p>Record today's numbers, then fail only when they grow. Nobody has to clean up first.</p>
    <pre class="cmd">npx instantiate budget   <span class="tok-comment"># once, commit the file</span>
npx instantiate check    <span class="tok-comment"># in CI</span></pre>
  </div>
  <div>
    <h2>For coding agents</h2>
    <p>An MCP server lets an agent check whether something already exists before it writes it.</p>
    <pre class="cmd">{ "mcpServers": { "instantiate":
  { "command": "npx", "args": ["instantiate", "mcp"] } } }</pre>
  </div>
</section>
`;
}

function librariesPage(list: Scanned[]): string {
  const languages = [...new Set(list.map((l) => l.language))];
  const rows = list
    .map((l) => {
      const dead = l.loc ? (l.deadLoc / l.loc) * 100 : 0;
      const dup = l.loc ? (l.duplicateLoc / l.loc) * 100 : 0;
      const stat = (value: number, label: string, alert = false): string =>
        `<span class="stat${value === 0 ? ' is-clean' : alert ? ' is-alert' : ''}"><span class="stat-n">${number(value)}</span><span class="stat-l">${label}</span></span>`;
      return `
<article class="lib" data-language="${esc(l.language)}">
  <div class="lib-id">
    <h3><a href="reports/${l.slug}.html">${esc(l.name)}</a> <span class="lang">${esc(l.language)}</span></h3>
    <p>${esc(l.about)}</p>
    <p class="meta"><a href="${esc(l.repo)}/tree/${l.ref}">${esc(l.repo.replace('https://github.com/', ''))}@${l.ref.slice(0, 7)}</a> · ${number(l.files)} files · ${number(l.loc)} lines</p>
  </div>
  <div class="lib-bar" role="img" aria-label="${l.loadBearing.toFixed(1)}% load-bearing, ${dead.toFixed(1)}% dead, ${dup.toFixed(1)}% duplicated">
    <span class="bar-dead" style="width:${Math.max(dead, l.deadLoc ? 0.6 : 0)}%"></span><span class="bar-dup" style="width:${Math.max(dup, l.duplicateLoc ? 0.6 : 0)}%"></span>
  </div>
  <div class="stats">
    <span class="stat${l.loadBearing >= 99 ? ' is-clean' : ''}"><span class="stat-n">${l.loadBearing.toFixed(1)}%</span><span class="stat-l">load-bearing</span></span>
    ${stat(l.deadLoc, 'dead lines')}${stat(l.duplicateLoc, 'duplicated')}${stat(l.drift, 'drifting')}${stat(l.conflicts, 'conflicting', true)}${stat(l.unfinished, 'unfinished', true)}
  </div>
  ${l.top.length ? `<ul class="top">${l.top.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="top clean">Nothing above the confidence cut-off.</p>'}
  <a class="chip open" href="reports/${l.slug}.html">${iconSvg('code')}Open report${iconSvg('arrowRight', 'icon-sm')}</a>
</article>`;
    })
    .join('');
  return `
<section class="hero compact">
  <h1>Popular libraries, scanned</h1>
  <p class="lede">Well-maintained open-source code, each pinned to a commit and run through instantiate unchanged. Open any report to browse the code with its findings in place. Only findings at 50% confidence or more are counted here.</p>
  <div class="legend"><span><i class="sw sw-dead"></i>dead</span><span><i class="sw sw-dup"></i>duplicated</span><span><i class="sw sw-clean"></i>load-bearing</span></div>
  <p class="filters" role="group" aria-label="Filter by language">
    <button type="button" class="chip is-on" data-filter="all" aria-pressed="true">All</button>
    ${languages.map((lang) => `<button type="button" class="chip" data-filter="${esc(lang)}" aria-pressed="false">${esc(lang)}</button>`).join('')}
  </p>
</section>
<section class="libs">${rows}</section>
<script>
document.querySelector('.filters').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  for (const b of document.querySelectorAll('.filters button')) {
    const on = b === button;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const wanted = button.dataset.filter;
  for (const lib of document.querySelectorAll('.lib')) {
    lib.hidden = wanted !== 'all' && lib.dataset.language !== wanted;
  }
});
</script>`;
}

const SITE_STYLE = `
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans);
       -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.icon { width: 1.05em; height: 1.05em; flex: 0 0 auto; vertical-align: -0.16em; }
.icon-sm { width: 0.85em; height: 0.85em; opacity: 0.7; }

/* The report's top bar, as the site's header. */
.site-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
            padding: 10px max(16px, calc((100% - 1080px) / 2)); border-bottom: 1px solid var(--line);
            background: var(--panel); position: sticky; top: env(safe-area-inset-top, 0px); z-index: 2; }
.brand { font-weight: 700; font-size: 16px; color: var(--ink); letter-spacing: -0.01em; }
.brand:hover { text-decoration: none; }
.version { font: 11px var(--mono); color: var(--muted); }
.nav { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }
.chip { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
        border: 1px solid var(--line-strong); background: var(--panel); color: var(--ink-soft);
        padding: 5px 11px; font: inherit; font-size: 12.5px; cursor: pointer; }
.chip:hover { border-color: var(--accent); color: var(--accent); text-decoration: none; }
.chip.is-on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

main { max-width: 1080px; margin: 0 auto; padding: 0 16px 48px; }
section { padding-block: 28px; }
h1 { font-size: var(--step-3); line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 12px;
     text-wrap: balance; max-width: 22ch; }
h2 { font-size: var(--step-1); margin: 0 0 12px; }
h3 { font-size: var(--step-0); margin: 0 0 4px; }
.lede { font-size: var(--step-1); color: var(--ink-soft); max-width: 62ch; margin: 0 0 20px; }
.hero { padding-top: 48px; }
.hero.compact { padding-top: 36px; padding-bottom: 8px; }
.langs { color: var(--muted); font-size: 13px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }

/* Code as the report shows it: sunk panel, mono, Flexoki token colours. */
.cmd { background: var(--sunk); border: 1px solid var(--line); padding: 14px 16px; margin: 0 0 18px;
       font: 13px/1.6 var(--mono); overflow-x: auto; color: var(--ink); max-width: 640px; }
.tok-comment { color: var(--tok-comment); }

/* Findings carry the report's severity stripe. */
.finds { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px;
         grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.find { border: 1px solid var(--line); border-left: 3px solid var(--low); background: var(--panel); padding: 14px 16px; }
.find.sev-high { border-left-color: var(--high); }
.find.sev-medium { border-left-color: var(--medium); }
.find p { margin: 0 0 10px; color: var(--ink-soft); font-size: 14px; }
.find code { display: block; font: 12px var(--mono); color: var(--muted); background: var(--sunk);
             padding: 6px 8px; overflow-wrap: anywhere; }
.two { display: grid; gap: 28px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.two p { color: var(--ink-soft); margin: 0 0 12px; }

/* The report's stat chips and heat colours. */
.stats { display: flex; flex-wrap: wrap; gap: 4px; }
.stat { display: inline-flex; gap: 5px; align-items: baseline; padding: 2px 8px;
        border: 1px solid var(--line); background: var(--panel); }
.stat-n { font-weight: 640; font-variant-numeric: tabular-nums; font-size: 12px; }
.stat-l { font-size: 11px; color: var(--muted); }
.stat.is-clean .stat-n { color: var(--good); }
.stat.is-alert .stat-n { color: var(--high); }

.legend { display: flex; gap: 16px; color: var(--muted); font-size: 12px; margin-bottom: 14px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.sw { display: inline-block; width: 12px; height: 12px; }
.sw-dead, .bar-dead { background: var(--heat2); }
.sw-dup, .bar-dup { background: var(--heat1); }
.sw-clean { background: var(--heat0); }
.filters { display: flex; gap: 6px; flex-wrap: wrap; margin: 0; }

.libs { display: grid; gap: 10px; padding-top: 12px; }
.lib { display: grid; gap: 10px 20px; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto;
       align-items: start; border: 1px solid var(--line); background: var(--panel); padding: 16px; }
.lib-id { grid-column: 1; grid-row: 1 / span 2; }
.lib-id h3 { font-size: var(--step-1); }
.lib-id p { margin: 0; color: var(--ink-soft); font-size: 14px; }
.lib-id .meta { color: var(--muted); font-size: 12px; margin-top: 6px; font-variant-numeric: tabular-nums; }
.lang { font: 11px var(--mono); color: var(--muted); border: 1px solid var(--line); padding: 1px 6px;
        vertical-align: 2px; font-weight: 400; }
.lib-bar { grid-column: 2 / span 2; display: flex; height: 10px; background: var(--heat0); overflow: hidden; }
.lib .stats { grid-column: 2 / span 2; }
.top { grid-column: 1 / span 2; margin: 0; padding: 8px 0 0 16px; border-top: 1px solid var(--line);
       color: var(--ink-soft); font-size: 13px; }
.top.clean { list-style: none; padding-left: 0; color: var(--good); }
.open { grid-column: 3; justify-self: end; align-self: end; }
.lib[hidden] { display: none; }

@media (max-width: 720px) {
  .lib { grid-template-columns: minmax(0, 1fr); }
  .lib-id, .lib-bar, .lib .stats, .top, .open { grid-column: 1; grid-row: auto; }
  .open { justify-self: start; }
  h1 { font-size: var(--step-2); }
}

.foot { max-width: 1080px; margin: 0 auto; padding: 20px 16px 40px; color: var(--muted);
        font-size: 12px; border-top: 1px solid var(--line); }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

// Last, once every constant above is initialised.
writeFileSync(join(out, 'index.html'), page('instantiate', 'home', home()));
writeFileSync(join(out, 'libraries.html'), page('Libraries · instantiate', 'libraries', librariesPage(scanned)));
writeFileSync(join(out, '.nojekyll'), '');
console.log(`\nsite written to ${out}`);
