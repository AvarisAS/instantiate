import type { CodeGraph, CodeSymbol, Finding } from '../types.js';

/**
 * Convention drift: one job, several dialects.
 *
 * When each session guesses how this codebase handles errors, four dialects
 * appear and no single file looks wrong. Drift is invisible locally and obvious
 * in aggregate, which is exactly what a whole-codebase view is for.
 */

interface Dialect {
  name: string;
  test: RegExp;
}

interface Category {
  key: string;
  label: string;
  dialects: Dialect[];
  /** Below this many uses the category has no established convention to drift from. */
  minUses: number;
}

const CATEGORIES: Category[] = [
  {
    key: 'errors',
    label: 'error handling',
    minUses: 6,
    dialects: [
      { name: 'throw Error', test: /\bthrow\s+new\s+\w*Error\b/ },
      { name: 'result object', test: /\breturn\s*\{\s*(ok|success)\s*:/ },
      { name: 'null return on failure', test: /\bcatch\s*(\([^)]*\))?\s*\{\s*return\s+(null|undefined)\s*[;}]/ },
      { name: 'silent catch', test: /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/ },
      { name: 'console then rethrow', test: /\bcatch[\s\S]{0,80}console\.(error|warn)[\s\S]{0,60}\bthrow\b/ },
    ],
  },
  {
    key: 'async',
    label: 'asynchrony',
    minUses: 6,
    dialects: [
      { name: 'async/await', test: /\bawait\s+/ },
      { name: 'promise chain', test: /\.then\s*\(/ },
      { name: 'node callback', test: /function\s*\([^)]*\berr(or)?\b\s*,/ },
    ],
  },
  {
    key: 'logging',
    label: 'logging',
    minUses: 5,
    dialects: [
      { name: 'console', test: /\bconsole\.(log|info|warn|error|debug)\s*\(/ },
      { name: 'logger object', test: /\b(logger|log)\.(info|warn|error|debug|trace)\s*\(/ },
      { name: 'process.stdout', test: /\bprocess\.(stdout|stderr)\.write\s*\(/ },
    ],
  },
  {
    key: 'exports',
    label: 'module exports',
    minUses: 8,
    dialects: [
      { name: 'named export', test: /\bexport\s+(const|function|class|interface|type|async)\b/ },
      { name: 'default export', test: /\bexport\s+default\b/ },
      { name: 'commonjs', test: /\bmodule\.exports\b/ },
    ],
  },
  {
    key: 'validation',
    label: 'input validation',
    minUses: 4,
    dialects: [
      { name: 'schema library', test: /\b(z|yup|joi|v)\.(object|string|number|array)\s*\(/ },
      { name: 'manual typeof guard', test: /\btypeof\s+\w+\s*(===|!==)\s*['"](string|number|boolean|object)['"]/ },
      { name: 'truthiness check', test: /\bif\s*\(\s*!\w+\s*\)\s*(\{\s*)?(throw|return)\b/ },
    ],
  }
];

export interface DriftResult {
  findings: Finding[];
  count: number;
}

export function findDrift(graph: CodeGraph): DriftResult {
  const findings: Finding[] = [];

  for (const category of CATEGORIES) {
    const uses = new Map<string, CodeSymbol[]>();
    for (const symbol of graph.symbols.values()) {
      for (const dialect of category.dialects) {
        if (dialect.test.test(symbol.body)) {
          const list = uses.get(dialect.name);
          if (list) list.push(symbol);
          else uses.set(dialect.name, [symbol]);
        }
      }
    }

    const total = [...uses.values()].reduce((sum, list) => sum + list.length, 0);
    if (total < category.minUses || uses.size < 2) continue;

    const ranked = [...uses.entries()].sort((a, b) => b[1].length - a[1].length);
    const [dominantName, dominantUses] = ranked[0];
    const dominantShare = dominantUses.length / total;

    // A genuine 50/50 split is a decision nobody made; a 90/10 split is drift.
    // Both are worth showing, but only when one convention is clearly the norm
    // is there an obvious action, so that is what we rank highest.
    const minority = ranked.slice(1);
    const minorityCount = minority.reduce((sum, [, list]) => sum + list.length, 0);
    const deviants = minority.flatMap(([name, list]) =>
      list.map((s) => ({ dialect: name, id: s.id, file: s.file, line: s.line, name: s.name })),
    );

    const breakdown = ranked
      .map(([name, list]) => `${name} ${Math.round((list.length / total) * 100)}%`)
      .join(', ');

    findings.push({
      id: `drift:${category.key}`,
      kind: 'drift',
      severity: dominantShare >= 0.8 ? 'medium' : 'high',
      title: `${category.label} is done ${uses.size} different ways`,
      detail:
        `${breakdown}. ` +
        (dominantShare >= 0.8
          ? `"${dominantName}" is the established convention here; ${minorityCount} place${minorityCount === 1 ? '' : 's'} deviate from it.`
          : `No convention has won, so each new change picks one at random.`),
      file: deviants[0]?.file ?? [...graph.files.keys()][0] ?? '',
      line: deviants[0]?.line ?? 1,
      symbols: deviants.map((d) => d.id),
      loc: minorityCount,
      // A clear norm with a few deviants is actionable; a coin-flip split is not.
      score: dominantShare >= 0.8 ? 0.8 : 0.5,
      evidence: {
        category: category.label,
        dominant: dominantName,
        dominantShare: Number(dominantShare.toFixed(2)),
        breakdown: ranked.map(([name, list]) => ({
          dialect: name,
          count: list.length,
          share: Number((list.length / total).toFixed(3)),
        })),
        // Cap the list: a report is a worklist, not a log.
        deviants: deviants.slice(0, 25),
      },
    });
  }

  findings.sort((a, b) => b.score - a.score);
  return { findings, count: findings.length };
}
