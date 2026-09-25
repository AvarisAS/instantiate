/** Core domain model. A codebase becomes symbols + edges; analyses turn those into findings. */

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'enum'
  | 'module';

export interface CodeSymbol {
  /** Stable across runs: `<relative path>#<container>.<name>`. */
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  endLine: number;
  /** Exported from its module. */
  exported: boolean;
  /**
   * Declared inside `declare module` or `declare global`. Such a declaration
   * merges into a type somewhere else and is consumed by the type system
   * globally, so nothing ever references it by name and it can never be deleted.
   */
  ambient?: boolean;
  /**
   * Module scope contains executable statements, not only declarations. Such a
   * file *does something* when loaded, so if nothing imports it, something runs
   * it: a script, a benchmark, a migration, a CLI entry.
   */
  sideEffects?: boolean;
  /**
   * Decorators applied to it, as written minus arguments: `Injectable`,
   * `app.route`. A decorator is how most frameworks register code they will
   * later call by themselves, so it is the strongest hint of dynamic dispatch.
   */
  decorators?: string[];
  /** Reachable from an entrypoint or public API surface. */
  loc: number;
  /** Normalised source used for duplicate detection. */
  body: string;
  /** Shape signature: parameter count/kinds and return, resolution-free. */
  signature: string;
  /** Concept cluster id, assigned by the concept analysis. */
  conceptId?: number;
}

export type EdgeKind = 'calls' | 'imports' | 'extends' | 'implements' | 'references';

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  file: string;
  line: number;
}

export interface FileRecord {
  path: string;
  loc: number;
  hash: string;
  /** Epoch millis of last index. */
  indexedAt: number;
}

export interface CodeGraph {
  root: string;
  /**
   * Comment-stripped source per file.
   *
   * Analyses that look for patterns rather than for symbols need the whole
   * file: a great deal of real code — module-level configuration, anything
   * inside a `describe()` callback — belongs to no recorded symbol, and reading
   * only symbol bodies made those analyses blind to it.
   */
  sources: Map<string, string>;
  symbols: Map<string, CodeSymbol>;
  edges: Edge[];
  files: Map<string, FileRecord>;
  entrypoints: string[];
  /** Places that reach code by a name computed at run time, which no static graph follows. */
  dynamicSites: DynamicSite[];
  /** Symbols a language runtime or framework calls by itself, found while indexing. */
  roots?: string[];
  createdAt: number;
}

/**
 * `handlers[type]()`, `import(\`./locales/${lang}\`)`, `getattr(obj, name)`.
 *
 * Kept rather than discarded because it is the honest boundary of the
 * analysis: an unreachable symbol near one of these is a question, not a
 * finding, and the list says exactly where a plugin rule or a coverage report
 * would settle it.
 */
export interface DynamicSite {
  file: string;
  line: number;
  kind: 'import' | 'member' | 'reflection';
  /** The expression, trimmed, as written. */
  text: string;
}

export type FindingKind = 'dead' | 'duplicate' | 'drift' | 'contradiction' | 'orphan-file' | 'unfinished';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  detail: string;
  /** Primary location, for navigation. */
  file: string;
  line: number;
  /** Symbols this finding is about. Duplicates have several. */
  symbols: string[];
  /** Lines of code this finding covers; drives ranking and the budget. */
  loc: number;
  /** 0..1 confidence, drives ranking and the noise budget cut-off. */
  score: number;
  /**
   * What to do about it, in one imperative sentence.
   *
   * A finding that states a problem and stops leaves the reader to invent the
   * remedy, which is the step most people skip.
   */
  action: string;
  /** Extra payload, shaped per finding kind, rendered by the report. */
  evidence?: Record<string, unknown>;
}

export interface Concept {
  id: number;
  name: string;
  description: string;
  symbols: string[];
  loc: number;
  /** Concept ids this one depends on, with edge weight. */
  couples: Array<{ to: number; weight: number }>;
}

export interface IntentRecord {
  symbol: string;
  /** Why this exists. */
  purpose: string;
  /** What it is explicitly not for. Guards against scope drift. */
  notFor: string;
  /** 'human' records are trusted; 'draft' ones await confirmation. */
  status: 'draft' | 'confirmed';
  updatedAt: number;
}

export interface Budget {
  dead: number;
  duplicate: number;
  drift: number;
  contradiction: number;
  unfinished?: number;
  ignored?: number;
  createdAt: number;
}

export interface RepoInfo {
  url: string;
  ref: string;
  blobPath: string;
}

export interface AnalysisResult {
  graph: CodeGraph;
  findings: Finding[];
  concepts: Concept[];
  stats: Stats;
}

export interface Stats {
  files: number;
  symbols: number;
  edges: number;
  loc: number;
  deadLoc: number;
  duplicateLoc: number;
  driftCount: number;
  contradictionCount: number;
  /** State nothing sets and bodies that only say they are not written yet. */
  unfinishedCount: number;
  /** `instantiate-ignore` comments that hid a finding. A budget line, so it only grows on purpose. */
  ignoredCount: number;
  indexMs: number;
  analyseMs: number;
}
