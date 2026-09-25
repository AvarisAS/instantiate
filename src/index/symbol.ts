import type { CodeSymbol, SymbolKind } from '../types.js';

/**
 * Construction of a symbol, shared by every language backend.
 *
 * Each indexer reaches its facts differently — a TypeScript node knows whether
 * it carries an `export` keyword, a Python one infers it from a leading
 * underscore — but what a symbol *is* should not vary by language, or the
 * analyses downstream would quietly mean different things per file.
 */
export interface SymbolInput {
  name: string;
  kind: SymbolKind;
  file: string;
  /** One-based, inclusive. */
  line: number;
  endLine: number;
  exported: boolean;
  /** Comment-free source, the input to duplicate detection. */
  body: string;
  signature: string;
  ambient?: boolean;
  decorators?: string[];
}

export function symbolId(file: string, name: string, container?: string): string {
  return container ? `${file}#${container}.${name}` : `${file}#${name}`;
}

export function moduleId(file: string): string {
  return `${file}#<module>`;
}

/**
 * Record a symbol, unless one of that id already exists.
 *
 * The first declaration wins, which is what collapses TypeScript overload
 * signatures onto the implementation that follows them.
 *
 * Returns the id, so a caller can map its own node to it.
 */
export function record(
  symbols: Map<string, CodeSymbol>,
  input: SymbolInput,
  container?: string,
): string {
  const id = symbolId(input.file, input.name, container);
  if (symbols.has(id)) return id;
  symbols.set(id, {
    id,
    name: input.name,
    kind: input.kind,
    file: input.file,
    line: input.line,
    endLine: input.endLine,
    exported: input.exported,
    ambient: input.ambient,
    ...(input.decorators?.length ? { decorators: input.decorators } : {}),
    loc: input.endLine - input.line + 1,
    body: input.body,
    signature: input.signature,
  });
  return id;
}

/** The symbol standing for a file itself. See the indexers for why it exists. */
export function recordModule(
  symbols: Map<string, CodeSymbol>,
  file: string,
  lines: number,
): string {
  const id = moduleId(file);
  symbols.set(id, {
    id,
    name: file,
    kind: 'module',
    file,
    line: 1,
    endLine: lines,
    // Importing a module runs it, so it is reachable from outside by definition.
    exported: true,
    // Lines belong to the declarations inside, not to the module wrapper, or
    // every file would be counted twice in every total.
    loc: 0,
    body: '',
    signature: 'module',
  });
  return id;
}
