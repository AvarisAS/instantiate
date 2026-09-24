import { existsSync, readFileSync } from 'node:fs';
import { relative, isAbsolute, resolve } from 'node:path';
import { UserError } from '../errors.js';

/**
 * Lines a test run actually executed.
 *
 * A static graph cannot see dynamic dispatch — a container resolving a name
 * from a string, a route table built at run time, a decorator registering its
 * function with a framework. No amount of reading the source fixes that,
 * because the answer is not in the source.
 *
 * But a test run knows. Most projects already produce a coverage report, and
 * merging it into the graph converts the hardest guesses into facts: anything
 * the tests executed is alive, however it was reached. What remains
 * unreachable is unreachable *and* untested, which is a stronger finding than
 * either on its own.
 *
 * Two formats, covering most of what exists:
 *   - Istanbul / nyc / c8 / Vitest / Jest `coverage-final.json`
 *   - coverage.py `coverage json` output
 */

export interface Coverage {
  /** Repository-relative path -> the set of lines that ran. */
  executed: Map<string, Set<number>>;
  format: string;
  files: number;
}

export function readCoverage(root: string, path: string): Coverage {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UserError(
      `Could not read the coverage file at ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }

  if (!raw || typeof raw !== 'object') {
    throw new UserError(`${path} is not a coverage report this understands.`);
  }

  const record = raw as Record<string, unknown>;
  const pythonFiles = record.files;
  if (pythonFiles && typeof pythonFiles === 'object') {
    return fromCoveragePy(root, pythonFiles as Record<string, unknown>);
  }
  return fromIstanbul(root, record);
}

/** coverage.py: `{ "files": { "src/x.py": { "executed_lines": [1, 2, 4] } } }` */
function fromCoveragePy(root: string, files: Record<string, unknown>): Coverage {
  const executed = new Map<string, Set<number>>();
  for (const [file, value] of Object.entries(files)) {
    const lines = (value as { executed_lines?: number[] })?.executed_lines;
    if (!Array.isArray(lines)) continue;
    executed.set(normalise(root, file), new Set(lines));
  }
  return { executed, format: 'coverage.py', files: executed.size };
}

/**
 * Istanbul: statement ranges plus an execution count for each. A statement
 * counted above zero means every line it spans ran.
 */
function fromIstanbul(root: string, report: Record<string, unknown>): Coverage {
  const executed = new Map<string, Set<number>>();

  for (const [file, value] of Object.entries(report)) {
    const entry = value as {
      statementMap?: Record<string, { start?: { line?: number }; end?: { line?: number } }>;
      s?: Record<string, number>;
      path?: string;
    };
    if (!entry?.statementMap || !entry.s) continue;

    const lines = new Set<number>();
    for (const [id, range] of Object.entries(entry.statementMap)) {
      if (!entry.s[id]) continue;
      const from = range.start?.line;
      const to = range.end?.line ?? from;
      if (typeof from !== 'number') continue;
      for (let line = from; line <= (to ?? from); line++) lines.add(line);
    }
    executed.set(normalise(root, entry.path ?? file), lines);
  }

  if (executed.size === 0) {
    throw new UserError(
      'That file parsed but held no coverage this understands. ' +
        'Expected an Istanbul `coverage-final.json` or the output of `coverage json`.',
    );
  }
  return { executed, format: 'istanbul', files: executed.size };
}

/**
 * Coverage tools emit absolute paths, or paths relative to wherever they ran.
 *
 * A relative one is resolved against the scanned project first, since that is
 * where coverage is normally produced, and against the working directory only
 * if that finds nothing — otherwise running the tool from a parent directory
 * silently turns every path into `../../..` and matches nothing at all.
 */
function normalise(root: string, file: string): string {
  let absolute: string;
  if (isAbsolute(file)) {
    absolute = file;
  } else if (existsSync(resolve(root, file))) {
    absolute = resolve(root, file);
  } else {
    absolute = resolve(process.cwd(), file);
  }
  return relative(root, absolute).split('\\').join('/');
}
