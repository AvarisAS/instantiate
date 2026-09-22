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
  symbols: Map<string, CodeSymbol>;
  edges: Edge[];
  files: Map<string, FileRecord>;
  entrypoints: string[];
  createdAt: number;
}

export type FindingKind = 'dead' | 'duplicate' | 'drift' | 'orphan-file';

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
  createdAt: number;
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
  indexMs: number;
  analyseMs: number;
}
