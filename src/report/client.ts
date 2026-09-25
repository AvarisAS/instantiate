// @ts-nocheck — browser code, shipped verbatim into the report page.
/**
 * The report's page script.
 *
 * It lives in its own file, rather than in a string inside html.ts, so that
 * it is code to every tool that reads code: the type checker parses it, and
 * instantiate indexes it. As a string it was invisible, and a search box whose
 * handler had been deleted went unnoticed because nothing could see that the
 * state it fed was never written.
 *
 * Plain JavaScript with no imports or exports: html.ts inlines the file as a
 * classic script. `DATA` comes from the JSON block beside it.
 */
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

  const parts = ['<svg viewBox="0 0 ' + DATA.mapSize.width + ' ' + DATA.mapSize.height + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Map of the codebase by file size and findings">'];

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
      '<title>' + esc(b.path) + '\n' + b.value + ' lines' +
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
  const generic = /^(index|main|mod|init|__init__)./.test(name);
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
        '<span class="tree-chevron">' + icon(open ? 'chevron-down' : 'chevron-right') + '</span>' +
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
      '<span class="search-wrap">' + icon('search', 'search-icon') +
        '<input class="pane-filter" id="sym-filter" type="search" placeholder="Filter symbols" ' +
          'value="' + esc(symbolFilter) + '" autocomplete="off">' +
      '</span>' +
      '<button class="chip' + (onlyFlagged ? ' is-on' : '') + '" data-toggle="flagged" ' +
        'aria-pressed="' + onlyFlagged + '" title="Show only symbols with findings">' +
        icon('filter') + 'flagged</button>' +
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
 * Icons, from Lucide (ISC), inlined as paths.
 *
 * Not loaded from a CDN for the same reason the highlighter is hand-written: a
 * report is read offline, and an icon set that fails to fetch leaves a page of
 * empty buttons. Only the handful actually used travels with it.
 * ------------------------------------------------------------------------ */

const ICONS = {
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  grid: '<rect width="7" height="7" x="3" y="3"/><rect width="7" height="7" x="14" y="3"/>' +
        '<rect width="7" height="7" x="14" y="14"/><rect width="7" height="7" x="3" y="14"/>',
  network: '<rect x="16" y="16" width="6" height="6"/><rect x="2" y="16" width="6" height="6"/>' +
           '<rect x="9" y="2" width="6" height="6"/>' +
           '<path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/>' +
            '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  ellipsis: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>' +
         '<path d="M12 9v4"/><path d="M12 17h.01"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
};

/** One icon, sized in ems so it follows whatever text it sits beside. */
function icon(name, extraClass) {
  const path = ICONS[name];
  if (!path) return '';
  return '<svg class="icon' + (extraClass ? ' ' + extraClass : '') + '" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" focusable="false">' + path + '</svg>';
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
    const lineComment = lang === 'py' ? /^#.*/ : /^\/\/.*/;
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

    m = rest.match(/^\d[\w.]*/);
    if (m) { out += '<span class="' + SPAN.n + '">' + esc(m[0]) + '</span>'; i += m[0].length; continue; }

    m = rest.match(/^[A-Za-z_$][\w$]*/);
    if (m) {
      const word = m[0];
      const after = rest.slice(word.length).match(/^\s*\(/);
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

    m = rest.match(/^[^\w\s$]+/);
    if (m) { out += '<span class="' + SPAN.p + '">' + esc(m[0]) + '</span>'; i += m[0].length; continue; }

    m = rest.match(/^\s+/);
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
        'title="Open on ' + esc(DATA.repo.label) + '">' + esc(file.path) +
        icon('external', 'icon-sm') + '</a>'
    : '<span class="code-path">' + esc(file.path) + '</span>';

  const head = '<div class="pane-head code-head">' +
      pathHtml +
      '<span class="code-meta">' + file.loc + ' lines</span>' +
      '<span class="head-spacer"></span>' +
      '<button class="links-toggle' + (showLinks ? ' is-on' : '') + '" data-links="1" ' +
        'aria-expanded="' + showLinks + '">' +
        icon('network') +
        '<span>Connections</span>' +
        '<span class="links-tally">' +
          file.usedBy.length + ' in · ' + file.uses.length + ' out' +
        '</span>' +
        icon(showLinks ? 'chevron-down' : 'chevron-right', 'icon-sm') +
      '</button>' +
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

  const lang = /\.(py)$/.test(file.path) ? 'py' : 'js';
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
          '<span class="fold-mark">' + icon('ellipsis') + '</span>' +
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
        '<span class="action-chevron">' + icon(open ? 'chevron-down' : 'chevron-right') + '</span>' +
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
              esc(DATA.repo.label) + icon('external', 'icon-sm') + '</a>'
          : '') +
      '</span>' +
      '<span class="nav-pair">' +
        '<button class="nav-btn" data-nav="back" title="Back (alt + left arrow)" ' +
          (cursor > 0 ? '' : 'disabled ') + 'aria-label="Back">‹</button>' +
        '<button class="nav-btn" data-nav="forward" title="Forward (alt + right arrow)" ' +
          (cursor < history.length - 1 ? '' : 'disabled ') + 'aria-label="Forward">›</button>' +
      '</span>' +
      '<span class="search-wrap">' + icon('search', 'search-icon') +
        '<input id="ex-search" class="ex-search" type="search" ' +
          'placeholder="Search files and symbols" value="' + esc(query) + '" autocomplete="off">' +
      '</span>' +
      '<span class="ex-count">' + files.length + '/' + DATA.files.length + '</span>' +
      '<button class="chip' + (showMap ? ' is-on' : '') + '" data-view="map" ' +
        'aria-pressed="' + showMap + '">' + icon('grid') + 'map</button>' +
      '<span class="stats">' +
        stat(clean.toFixed(1) + '%', 'load-bearing', clean >= 95 ? 'clean' : 'alert') +
        stat(s.deadLoc.toLocaleString('en-GB'), 'dead', s.deadLoc === 0 ? 'clean' : '') +
        stat(s.duplicateLoc.toLocaleString('en-GB'), 'duplicated', s.duplicateLoc === 0 ? 'clean' : '') +
        stat(String(s.driftCount), 'drifting', s.driftCount === 0 ? 'clean' : '') +
        stat(String(s.contradictionCount), 'conflicting', s.contradictionCount === 0 ? 'clean' : 'alert') +
        stat(String(s.unfinishedCount || 0), 'unfinished', !s.unfinishedCount ? 'clean' : 'alert') +
        (s.ignoredCount ? stat(String(s.ignoredCount), 'ignored', '') : '') +
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
    '<span class="ln">' + (s.startLine + i) + '</span>' + esc(line)).join('\n');
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
