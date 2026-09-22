/**
 * Local similarity model. No network, no API key, deterministic across runs.
 *
 * Two signals, because token-level clone detection is the wrong tool here.
 * LLM-written duplicates are rarely copy-paste: the same job gets done three
 * times with different names and slightly different shape. So we measure
 *
 *   structure  — the token skeleton with identifiers erased, and
 *   vocabulary — the words in the names, calls and strings,
 *
 * and require both to agree before calling something a duplicate.
 */

export type Bag = Map<string, number>;

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'new', 'try', 'catch', 'finally', 'throw',
  'typeof', 'instanceof', 'async', 'await', 'yield', 'class', 'extends', 'super',
  'this', 'null', 'undefined', 'true', 'false', 'in', 'of', 'delete', 'void',
]);

/** Words that carry no intent, so including them makes everything look alike. */
const STOPWORDS = new Set([
  'get', 'set', 'to', 'from', 'the', 'a', 'an', 'is', 'of', 'value', 'data',
  'result', 'item', 'items', 'obj', 'object', 'arg', 'args', 'opt', 'opts',
  'options', 'param', 'params', 'fn', 'cb', 'callback', 'tmp', 'temp', 'x', 'y', 'i',
]);

/**
 * Abbreviations, expanded to their long form. Without this, `secs`/`seconds` and
 * `ms`/`milliseconds` look like unrelated words, and near-identical functions
 * written by different sessions score far too low to surface.
 */
const ABBREVIATIONS: Record<string, string> = {
  ms: 'millisecond', msec: 'millisecond', millis: 'millisecond',
  sec: 'second', secs: 'second', s: 'second',
  min: 'minute', mins: 'minute',
  hr: 'hour', hrs: 'hour',
  ts: 'timestamp', dt: 'datetime',
  num: 'number', cnt: 'count', amt: 'amount', qty: 'quantity',
  str: 'string', bool: 'boolean', int: 'integer',
  msg: 'message', err: 'error', ex: 'exception',
  req: 'request', res: 'response', resp: 'response',
  cfg: 'config', conf: 'config', config: 'config', env: 'environment',
  auth: 'authenticate', usr: 'user', acct: 'account', addr: 'address',
  db: 'database', repo: 'repository', svc: 'service', ctx: 'context',
  init: 'initialise', calc: 'calculate', conv: 'convert',
  fmt: 'format', len: 'length', idx: 'index', buf: 'buffer',
  dir: 'directory', pkg: 'package', dep: 'dependency', util: 'utility',
};

const SHINGLE = 4;

/** Token skeleton: identifiers, numbers and strings collapse to placeholders. */
export function structuralBag(body: string): Bag {
  const tokens = tokenise(body).map((t) => {
    if (KEYWORDS.has(t)) return t;
    if (/^[0-9]/.test(t)) return 'N';
    if (/^['"`]/.test(t)) return 'S';
    if (/^[A-Za-z_$]/.test(t)) return 'ID';
    return t;
  });

  const bag: Bag = new Map();
  for (let i = 0; i + SHINGLE <= tokens.length; i++) {
    const key = tokens.slice(i, i + SHINGLE).join(' ');
    bag.set(key, (bag.get(key) ?? 0) + 1);
  }
  return bag;
}

/** Word bag from identifiers and string literals: what the code is *about*. */
export function vocabularyBag(name: string, body: string): Bag {
  const bag: Bag = new Map();
  const add = (word: string, weight: number): void => {
    if (word.length < 2 || STOPWORDS.has(word)) return;
    bag.set(word, (bag.get(word) ?? 0) + weight);
  };

  // The symbol's own name is the strongest statement of intent it has.
  for (const word of splitIdentifier(name)) add(word, 3);

  for (const token of tokenise(body)) {
    if (KEYWORDS.has(token)) continue;
    if (/^['"`]/.test(token)) {
      for (const word of splitIdentifier(token.slice(1, -1))) add(word, 1);
    } else if (/^[A-Za-z_$]/.test(token)) {
      for (const word of splitIdentifier(token)) add(word, 1);
    }
  }
  return bag;
}

/** camelCase, PascalCase, snake_case and kebab-case all become lowercase words. */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean)
    .map(stem);
}

/** Expand abbreviations, then stem, so that all spellings of one idea collapse. */
function stem(word: string): string {
  const expanded = ABBREVIATIONS[word];
  if (expanded) return expanded;
  let base = word;
  if (base.length > 5 && base.endsWith('ing')) base = base.slice(0, -3);
  else if (base.length > 4 && base.endsWith('ed')) base = base.slice(0, -2);
  else if (base.length > 3 && base.endsWith('s') && !base.endsWith('ss')) base = base.slice(0, -1);
  // `secs` -> `sec` -> `second`: stemming can expose a further abbreviation.
  return ABBREVIATIONS[base] ?? base;
}

function tokenise(source: string): string[] {
  return source.match(/'[^']*'|"[^"]*"|`[^`]*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s\w]/g) ?? [];
}

export function cosine(a: Bag, b: Bag): number {
  if (a.size === 0 || b.size === 0) return 0;
  // Iterate the smaller bag: the intersection is all that contributes.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [key, weight] of small) {
    const other = large.get(key);
    if (other !== undefined) dot += weight * other;
  }
  if (dot === 0) return 0;
  return dot / (norm(a) * norm(b));
}

const normCache = new WeakMap<Bag, number>();

function norm(bag: Bag): number {
  const cached = normCache.get(bag);
  if (cached !== undefined) return cached;
  let sum = 0;
  for (const weight of bag.values()) sum += weight * weight;
  const value = Math.sqrt(sum) || 1;
  normCache.set(bag, value);
  return value;
}
