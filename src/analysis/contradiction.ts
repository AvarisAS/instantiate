import type { CodeGraph, CodeSymbol, Finding, Severity } from '../types.js';
import { splitIdentifier } from './similarity.js';

/**
 * Contradictions: one fact, two answers.
 *
 * Drift is about *style* — four ways to write an error. This is about
 * substance: the same environment variable defaulting to two different values,
 * the same timeout being 3 seconds here and 30 there, one date parsed as UTC
 * and the same date parsed as local. Each site is defensible on its own, which
 * is exactly why nobody catches it in review, and why an agent that guesses
 * produces one more of them every time.
 *
 * Precision matters more here than anywhere else: a false contradiction sends
 * someone hunting for a bug that does not exist. So every rule below requires
 * the *same* named thing to carry genuinely different values.
 */

export interface ContradictionResult {
  findings: Finding[];
  count: number;
}

interface Site {
  file: string;
  line: number;
  /** The symbol this line falls inside, for navigation. May be absent. */
  symbol?: CodeSymbol;
  value: string;
  raw: string;
}

/**
 * Where a contradiction does not count.
 *
 * A test asserting `maxAge: 1000` does not contradict production code that uses
 * 600, and neither does a value in a documentation example or a benchmark. A
 * false contradiction sends someone hunting for a bug that does not exist, so
 * precision matters more here than coverage.
 */
const NON_SOURCE =
  /(^|\/)(test|tests|spec|__tests__|test-d|e2e|bench|benchmark|benchmarks|perf|perf-measures|examples?|docs?|fixtures?|scripts?|vendor)\//i;

function isSource(file: string): boolean {
  return !NON_SOURCE.test(file) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && !/_test\.py$|^test_/.test(file);
}

/** Map a match offset to a line number and the symbol that contains it. */
function locate(
  graph: CodeGraph,
  file: string,
  text: string,
  offset: number,
): { file: string; line: number; symbol?: CodeSymbol } {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  let symbol: CodeSymbol | undefined;
  for (const candidate of graph.symbols.values()) {
    if (candidate.file !== file || candidate.kind === 'module') continue;
    if (candidate.line <= line && line <= candidate.endLine) {
      // Prefer the innermost symbol containing the line.
      if (!symbol || candidate.line > symbol.line) symbol = candidate;
    }
  }
  return { file, line, symbol };
}

/** Iterate every source file worth checking, with its text. */
function* sourceFiles(graph: CodeGraph): Generator<[string, string]> {
  for (const [file, text] of graph.sources) {
    if (isSource(file)) yield [file, text];
  }
}

/**
 * Concepts whose value should be the same everywhere it is stated.
 *
 * Matched against split identifier words, so entries here are single words:
 * a list containing `maxage` could never match `maxAge`, which splits into
 * `max` and `age`.
 */
const NUMERIC_CONCEPTS = [
  'timeout', 'retry', 'backoff', 'delay', 'interval', 'ttl',
  'expiry', 'expire', 'limit', 'port', 'threshold', 'concurrency',
];

export function findContradictions(graph: CodeGraph): ContradictionResult {
  const findings: Finding[] = [
    ...divergentDefaults(graph),
    ...divergentConstants(graph),
    ...divergentTimeSemantics(graph),
  ];

  findings.sort((a, b) => b.score - a.score);
  return { findings, count: findings.length };
}

/**
 * One rule: find sites, group them, and report a group that states more than
 * one value.
 *
 * Both the environment-variable rule and the declared-constant rule are this
 * shape, differing only in what they match and how strongly they believe it.
 * They were written separately and drifted apart; the duplicate detector caught
 * them, which seems like the right test of it.
 */
interface DivergenceRule {
  id: string;
  pattern: RegExp;
  /** Pull the grouping key and the value out of a match, or skip it. */
  extract: (match: RegExpExecArray) => { key: string; value: string } | undefined;
  /** Reject a group before it becomes a finding. */
  accept?: (sites: Site[]) => boolean;
  severity: Severity;
  score: number;
  title: (key: string, values: string[], sites: Site[]) => string;
  detail: (key: string, values: string[], sites: Site[]) => string;
  evidence?: (key: string, sites: Site[]) => Record<string, unknown>;
}

function applyRule(graph: CodeGraph, rule: DivergenceRule): Finding[] {
  const groups = new Map<string, Site[]>();

  for (const [file, text] of sourceFiles(graph)) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      const extracted = rule.extract(match);
      if (!extracted) continue;
      const site: Site = {
        ...locate(graph, file, text, match.index),
        value: extracted.value,
        raw: match[0].trim(),
      };
      const list = groups.get(extracted.key);
      if (list) list.push(site);
      else groups.set(extracted.key, [site]);
    }
  }

  const findings: Finding[] = [];
  for (const [key, sites] of groups) {
    const values = [...new Set(sites.map((s) => s.value))];
    if (values.length < 2) continue;
    if (rule.accept && !rule.accept(sites)) continue;

    findings.push({
      id: `contradiction:${rule.id}:${key}`,
      kind: 'contradiction',
      severity: rule.severity,
      title: rule.title(key, values, sites),
      detail: rule.detail(key, values, sites),
      file: sites[0].file,
      line: sites[0].line,
      symbols: sites.map((s) => s.symbol?.id ?? `${s.file}#<module>`),
      loc: sites.length,
      score: rule.score,
      evidence: {
        key,
        ...(rule.evidence?.(key, sites) ?? {}),
        variants: sites.map((s) => ({
          value: s.value,
          raw: s.raw,
          file: s.file,
          line: s.line,
          symbol: s.symbol?.name ?? '(module scope)',
        })),
      },
    });
  }
  return findings;
}

/**
 * The same environment variable or config key, with two different fallbacks.
 * Whichever call site runs first wins, which is never what anybody intended.
 */
function divergentDefaults(graph: CodeGraph): Finding[] {
  return applyRule(graph, {
    id: 'default',
    // `process.env.FOO ?? 'x'`, `env.FOO || 3000`, `env['FOO'] ?? 'x'`
    pattern:
      /(?:process\.env|env)\s*(?:\.\s*([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])\s*(?:\?\?|\|\|)\s*([^;,)\]}]+)/g,
    extract: (match) => {
      const key = match[1] ?? match[2];
      const value = normaliseValue(match[3]);
      return key && value ? { key, value } : undefined;
    },
    // Two literal defaults for one key is about as unambiguous as static
    // analysis gets, so this is reported with real confidence.
    severity: 'high',
    score: 0.9,
    title: (key, values) => `${key} falls back to ${values.length} different values`,
    detail: (_key, values) =>
      `${values.join(' and ')}. Whichever site runs first decides the behaviour, ` +
      'so the value this actually takes depends on import order rather than on a decision.',
  });
}

/**
 * One declared setting, several values. `DEFAULT_CONCURRENCY = 1024` in one
 * file and `= 2` in another is a decision nobody made twice on purpose.
 */
function divergentConstants(graph: CodeGraph): Finding[] {
  return applyRule(graph, {
    id: 'constant',
    // A declaration keyword, or a SCREAMING_SNAKE name, which is a declared
    // setting by convention. Never a property inside an options object:
    // `maxAge: 1000` in one feature and `3600` in another are two settings,
    // not a disagreement, and matching those made this mostly false positives.
    pattern:
      /(?:\b(?:const|let|var|final|static)\s+([A-Za-z_$][\w$]*)|^\s*([A-Z][A-Z0-9_]{2,}))\s*(?::\s*\w+\s*)?=\s*(\d+)\s*(?:;|$)/gm,
    extract: (match) => {
      const name = match[1] ?? match[2];
      if (!name) return undefined;
      const words = splitIdentifier(name);
      const namesConcept = words.some((w) => NUMERIC_CONCEPTS.includes(w));
      const isDeclaredConstant = /^[A-Z][A-Z0-9_]{2,}$/.test(name);
      if (!namesConcept && !isDeclaredConstant) return undefined;
      // Key on the whole name: `retryDelay` and `retryLimit` are different
      // facts that happen to share a word.
      return { key: words.join('-'), value: match[3] };
    },
    // One file stating two values is usually a table of cases, not a conflict.
    accept: (sites) => new Set(sites.map((s) => s.file)).size >= 2,
    severity: 'medium',
    score: 0.6,
    title: (key, values) =>
      `"${key.split('-').join(' ')}" is ${values.slice().sort((a, b) => Number(a) - Number(b)).join(', ')} in different places`,
    detail: (_key, _values, sites) =>
      `${sites.length} sites across ${new Set(sites.map((s) => s.file)).size} files state a different ` +
      'number for the same thing. One of them is stale, or this value belongs in one place rather than several.',
  });
}

/**
 * UTC in one place, local time in another. The classic silent contradiction:
 * both are correct in isolation, and together they are off by the offset.
 */
function divergentTimeSemantics(graph: CodeGraph): Finding[] {
  const utc: Site[] = [];
  const local: Site[] = [];

  const utcPattern = /\b(?:getUTC(?:FullYear|Month|Date|Hours|Minutes|Seconds)|toISOString|Date\.UTC|utc\(\))/;
  const localPattern = /\b(?:get(?:FullYear|Month|Date|Hours|Minutes|Seconds)\s*\(|toLocale(?:Date|Time)?String)/;

  for (const symbol of graph.symbols.values()) {
    if (symbol.kind === 'module' || !isSource(symbol.file)) continue;
    const hasUtc = utcPattern.test(symbol.body);
    const hasLocal = localPattern.test(symbol.body);
    // A symbol doing both is usually a deliberate conversion, not a conflict.
    const site = { file: symbol.file, line: symbol.line, symbol };
    if (hasUtc && !hasLocal) utc.push({ ...site, value: 'UTC', raw: 'UTC' });
    else if (hasLocal && !hasUtc) local.push({ ...site, value: 'local', raw: 'local time' });
  }

  if (utc.length === 0 || local.length === 0) return [];
  // One-off local formatting for display is normal; a split down the middle is not.
  const minority = Math.min(utc.length, local.length);
  const total = utc.length + local.length;
  if (minority < 2 || minority / total < 0.15) return [];

  const all = [...utc, ...local];
  return [
    {
      id: 'contradiction:time-semantics',
      kind: 'contradiction',
      severity: 'medium',
      title: `Dates are read as UTC in ${utc.length} places and local time in ${local.length}`,
      detail:
        'Each is correct on its own, and together they disagree by the machine\'s offset. ' +
        'Check whether any value written by one group is read by the other.',
      file: all[0].file,
      line: all[0].line,
      symbols: all.map((s) => s.symbol?.id ?? `${s.file}#<module>`),
      loc: all.length,
      score: 0.55,
      evidence: {
        utc: utc.slice(0, 12).map((s) => ({ file: s.file, line: s.line, symbol: s.symbol?.name ?? '' })),
        local: local.slice(0, 12).map((s) => ({ file: s.file, line: s.line, symbol: s.symbol?.name ?? '' })),
      },
    },
  ];
}

/** Compare defaults by value, ignoring quoting and spacing. */
function normaliseValue(raw: string): string {
  const trimmed = raw.trim().replace(/[;,)]+$/, '').trim();
  if (!trimmed) return '';
  const unquoted = trimmed.replace(/^['"`]|['"`]$/g, '');
  // A default that is itself an expression cannot be compared reliably.
  if (/[(){}[\]]/.test(unquoted) || unquoted.includes('?')) return '';
  return unquoted;
}
