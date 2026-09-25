import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { relative, isAbsolute, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * Three formats, covering most of what exists:
 *   - Istanbul / nyc / c8 / Vitest / Jest `coverage-final.json`
 *   - coverage.py `coverage json` output
 *   - raw V8 coverage: the directory `NODE_V8_COVERAGE` writes to
 *
 * The last is what makes a production trace cheap: run the real service for a
 * while with `NODE_V8_COVERAGE=dir`, and whatever users exercised counts too —
 * including every path the test suite never thought to try.
 */

export interface Coverage {
  /** Repository-relative path -> the set of lines that ran. */
  executed: Map<string, Set<number>>;
  format: string;
  files: number;
}

/** Several reports — a test run and a production trace, say — read as one. */
export function readCoverages(root: string, paths: string[]): Coverage {
  const all = paths.map((path) => readCoverage(root, path));
  if (all.length === 1) return all[0];
  const executed = new Map<string, Set<number>>();
  for (const coverage of all) {
    for (const [file, lines] of coverage.executed) {
      const merged = executed.get(file) ?? new Set<number>();
      for (const line of lines) merged.add(line);
      executed.set(file, merged);
    }
  }
  return { executed, format: [...new Set(all.map((c) => c.format))].join(' + '), files: executed.size };
}

export function readCoverage(root: string, path: string): Coverage {
  if (existsSync(path) && statSync(path).isDirectory()) {
    const reports = readdirSync(path).filter((name) => name.endsWith('.json'));
    if (reports.length === 0) throw new UserError(`${path} is a directory with no coverage files in it.`);
    return fromV8(root, reports.map((name) => JSON.parse(readFileSync(join(path, name), 'utf8'))));
  }

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
  if (Array.isArray(record.result)) return fromV8(root, [record]);
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

interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

/**
 * V8's own format: byte ranges per function, each with an execution count,
 * where an inner range overrides the one around it.
 *
 * Offsets refer to the code V8 ran. For plain JavaScript that is the file on
 * disk; for TypeScript it is a transpiled copy whose offsets mean nothing
 * here, so those are left out — `c8 report --reporter=json` maps them through
 * source maps into an Istanbul report, which this already reads.
 */
function fromV8(root: string, reports: unknown[]): Coverage {
  const executed = new Map<string, Set<number>>();
  for (const report of reports) {
    const result = (report as { result?: Array<{ url?: string; functions?: Array<{ ranges?: V8Range[] }> }> }).result;
    for (const script of result ?? []) {
      if (!script.url?.startsWith('file://')) continue;
      const absolute = fileURLToPath(script.url);
      if (!/\.[cm]?jsx?$/.test(absolute) || absolute.includes('/node_modules/')) continue;
      const file = normalise(root, absolute);
      if (file.startsWith('..')) continue;

      let text: string;
      try {
        text = readFileSync(absolute, 'utf8');
      } catch {
        continue;
      }
      // Line start offsets, so a byte range becomes the lines it covers.
      const starts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
      const ranges = (script.functions ?? []).flatMap((fn) => fn.ranges ?? []);
      // Widest first, so a nested range paints over its parent.
      ranges.sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));

      const ran = new Map<number, boolean>();
      for (const range of ranges) {
        for (let line = lineAt(starts, range.startOffset); line < starts.length; line++) {
          const start = starts[line];
          if (start >= range.endOffset) break;
          const end = (starts[line + 1] ?? text.length + 1) - 1;
          if (end < range.startOffset || start >= range.endOffset) continue;
          // A line only partly inside a never-run range may still have run the
          // rest, so only a line wholly inside one is marked as not run.
          const whole = start >= range.startOffset && end <= range.endOffset;
          if (range.count > 0) ran.set(line + 1, true);
          else if (whole) ran.set(line + 1, false);
        }
      }
      const lines = executed.get(file) ?? new Set<number>();
      for (const [line, yes] of ran) if (yes) lines.add(line);
      executed.set(file, lines);
    }
  }
  if (executed.size === 0) {
    throw new UserError(
      'That V8 coverage held no JavaScript files from this project. For TypeScript, convert it first: ' +
        '`npx c8 report --temp-directory <dir> --reporter=json`, then pass coverage/coverage-final.json.',
    );
  }
  return { executed, format: 'v8', files: executed.size };
}

/** Zero-based line containing an offset. */
function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
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
  // Through symlinks on both sides: macOS reports /private/var for /var, and
  // a mismatch would make every file look like it lives outside the project.
  return relative(real(root), real(absolute)).split('\\').join('/');
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
