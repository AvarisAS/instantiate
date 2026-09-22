import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Snippet {
  file: string;
  startLine: number;
  lines: string[];
}

const MAX_LINES = 60;
const cache = new Map<string, string[]>();

/** Read a line range from a file, capped, for embedding in the report. */
export function snippet(root: string, file: string, from: number, to: number): Snippet | undefined {
  let lines = cache.get(file);
  if (!lines) {
    try {
      lines = readFileSync(join(root, file), 'utf8').split('\n');
    } catch {
      return undefined; // The file moved since the scan; not worth failing a report over.
    }
    cache.set(file, lines);
  }

  const start = Math.max(0, from - 1);
  const end = Math.min(lines.length, Math.max(start + 1, Math.min(to, start + MAX_LINES)));
  return { file, startLine: start + 1, lines: lines.slice(start, end) };
}
