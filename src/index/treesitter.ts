import { Language, Parser } from 'web-tree-sitter';
import { fileURLToPath } from 'node:url';
import type { CodeSymbol, DynamicSite, Edge, FileRecord } from '../types.js';
import type { Config } from '../config.js';

/**
 * What every non-TypeScript language produces: the same graph pieces the
 * TypeScript indexer builds, so every analysis downstream is language-blind.
 */
export interface LanguageGraph {
  symbols: Map<string, CodeSymbol>;
  edges: Edge[];
  files: Map<string, FileRecord>;
  /** Comment-stripped source per file, for the analyses that read whole files. */
  sources: Map<string, string>;
  /** Files discovered to be run directly, by reading them rather than by name. */
  scripts: string[];
  /** Files whose exported symbols are a contract with code outside this repository. */
  publicApi?: string[];
  /** Symbols the runtime or a framework calls by itself: operators, system-discovered types. */
  roots?: string[];
  dynamicSites: DynamicSite[];
}

/**
 * A language behind tree-sitter. Adding one is a new file exporting one of
 * these and a line in `BACKENDS`; nothing else needs to know it exists.
 */
export interface Backend {
  name: string;
  /** Which files are this language's, from the resolved config. */
  globs(config: Config): string[];
  build(config: Config, files: string[]): Promise<LanguageGraph>;
}

let ready: Promise<void> | undefined;
const parsers = new Map<string, Promise<Parser>>();

/**
 * A parser for one of the vendored grammars in `grammars/`.
 *
 * Loading a grammar costs real time, so each is loaded once, and only when a
 * repository actually contains that language.
 */
export function parserFor(grammar: string): Promise<Parser> {
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = (async () => {
      ready ??= Parser.init();
      await ready;
      // Two levels up from src/index or dist/index is the package root.
      const path = fileURLToPath(new URL(`../../grammars/tree-sitter-${grammar}.wasm`, import.meta.url));
      const instance = new Parser();
      instance.setLanguage(await Language.load(path));
      return instance;
    })();
    parsers.set(grammar, parser);
  }
  return parser;
}
