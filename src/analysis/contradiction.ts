import type { CodeGraph, CodeSymbol, Finding } from '../types.js';
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
  symbol: CodeSymbol;
  value: string;
  raw: string;
}

/** Concepts whose value should be the same everywhere it is stated. */
const NUMERIC_CONCEPTS = [
  'timeout', 'retry', 'retries', 'backoff', 'delay', 'interval', 'ttl',
  'maxage', 'expiry', 'expires', 'limit', 'maxsize', 'maxlength', 'pagesize',
  'batchsize', 'port', 'threshold', 'concurrency',
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
 * The same environment variable or config key, with two different fallbacks.
 * Whichever call site runs first wins, which is never what anybody intended.
 */
function divergentDefaults(graph: CodeGraph): Finding[] {
  const byKey = new Map<string, Site[]>();
  // `process.env.FOO ?? 'x'`, `process.env.FOO || 'x'`, `env.FOO ?? 3000`
  const pattern = /(?:process\.env|env)\s*(?:\.\s*([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])\s*(?:\?\?|\|\|)\s*([^;,)\]}]+)/g;

  for (const symbol of graph.symbols.values()) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(symbol.body)) !== null) {
      const key = match[1] ?? match[2];
      const value = normaliseValue(match[3]);
      if (!key || !value) continue;
      const list = byKey.get(key);
      if (list) list.push({ symbol, value, raw: match[0].trim() });
      else byKey.set(key, [{ symbol, value, raw: match[0].trim() }]);
    }
  }

  const findings: Finding[] = [];
  for (const [key, sites] of byKey) {
    const values = new Set(sites.map((s) => s.value));
    if (values.size < 2) continue;

    findings.push({
      id: `contradiction:default:${key}`,
      kind: 'contradiction',
      severity: 'high',
      title: `${key} falls back to ${values.size} different values`,
      detail:
        `${[...values].join(' and ')}. Whichever site runs first decides the behaviour, ` +
        'so the value this actually takes depends on import order rather than on a decision.',
      file: sites[0].symbol.file,
      line: sites[0].symbol.line,
      symbols: sites.map((s) => s.symbol.id),
      loc: sites.length,
      // Two literal defaults for one key is about as unambiguous as static
      // analysis gets, so this is reported with real confidence.
      score: 0.9,
      evidence: {
        key,
        variants: sites.map((s) => ({
          value: s.value,
          raw: s.raw,
          file: s.symbol.file,
          line: s.symbol.line,
          symbol: s.symbol.name,
        })),
      },
    });
  }
  return findings;
}

/**
 * One named concept, several magic numbers. A `timeout` of 3000 in one module
 * and 30000 in another is a decision nobody made twice on purpose.
 */
function divergentConstants(graph: CodeGraph): Finding[] {
  const byConcept = new Map<string, Site[]>();
  // `timeout: 3000`, `const retryLimit = 5`, `maxAge = 86400`
  const pattern = /\b([A-Za-z_$][\w$]*)\s*[:=]\s*(\d{2,})\b/g;

  for (const symbol of graph.symbols.values()) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(symbol.body)) !== null) {
      const words = splitIdentifier(match[1]);
      const concept = words.find((w) => NUMERIC_CONCEPTS.includes(w));
      if (!concept) continue;
      // Key on the whole name, not just the concept word: `retryDelay` and
      // `retryLimit` are different facts that happen to share a word.
      const key = words.join('-');
      const site = { symbol, value: match[2], raw: match[0].trim() };
      const list = byConcept.get(key);
      if (list) list.push(site);
      else byConcept.set(key, [site]);
    }
  }

  const findings: Finding[] = [];
  for (const [key, sites] of byConcept) {
    const values = new Set(sites.map((s) => s.value));
    if (values.size < 2) continue;
    // One file stating two values is usually a table of cases, not a conflict.
    const files = new Set(sites.map((s) => s.symbol.file));
    if (files.size < 2) continue;

    const label = key.split('-').join(' ');
    findings.push({
      id: `contradiction:constant:${key}`,
      kind: 'contradiction',
      severity: 'medium',
      title: `"${label}" is ${[...values].sort((a, b) => Number(a) - Number(b)).join(', ')} in different places`,
      detail:
        `${sites.length} sites across ${files.size} files state a different number for the same thing. ` +
        'One of them is stale, or this value belongs in one place rather than several.',
      file: sites[0].symbol.file,
      line: sites[0].symbol.line,
      symbols: sites.map((s) => s.symbol.id),
      loc: sites.length,
      score: 0.6,
      evidence: {
        concept: label,
        variants: sites.map((s) => ({
          value: s.value,
          raw: s.raw,
          file: s.symbol.file,
          line: s.symbol.line,
          symbol: s.symbol.name,
        })),
      },
    });
  }
  return findings;
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
    const hasUtc = utcPattern.test(symbol.body);
    const hasLocal = localPattern.test(symbol.body);
    // A symbol doing both is usually a deliberate conversion, not a conflict.
    if (hasUtc && !hasLocal) utc.push({ symbol, value: 'UTC', raw: 'UTC' });
    else if (hasLocal && !hasUtc) local.push({ symbol, value: 'local', raw: 'local time' });
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
      file: all[0].symbol.file,
      line: all[0].symbol.line,
      symbols: all.map((s) => s.symbol.id),
      loc: all.length,
      score: 0.55,
      evidence: {
        utc: utc.slice(0, 12).map((s) => ({ file: s.symbol.file, line: s.symbol.line, symbol: s.symbol.name })),
        local: local.slice(0, 12).map((s) => ({ file: s.symbol.file, line: s.symbol.line, symbol: s.symbol.name })),
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
