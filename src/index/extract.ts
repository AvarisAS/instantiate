import ts from 'typescript';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { CodeGraph, CodeSymbol, Edge, FileRecord, SymbolKind } from '../types.js';
import type { Config } from '../config.js';
import { relPath } from '../config.js';
import { matchesAny } from '../util/glob.js';

/** Build the code graph for a project: symbols, call/reference edges, files. */
export function buildGraph(config: Config): CodeGraph {
  const files = discoverFiles(config);
  const program = createProgram(config, files);
  const checker = program.getTypeChecker();

  const symbols = new Map<string, CodeSymbol>();
  const edges: Edge[] = [];
  const fileRecords = new Map<string, FileRecord>();
  /** Declaration node -> symbol id, so pass two can resolve references to symbols. */
  const declToId = new Map<ts.Node, string>();

  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && files.includes(sf.fileName));

  // Pass one: declare. Every symbol must exist before any edge can point at it.
  for (const sf of sourceFiles) {
    const rel = relPath(config.root, sf.fileName);
    const text = sf.getFullText();
    fileRecords.set(rel, {
      path: rel,
      loc: countLines(text),
      hash: createHash('sha1').update(text).digest('hex').slice(0, 16),
      indexedAt: Date.now(),
    });
    collectDeclarations(sf, rel, sf, symbols, declToId);
  }

  // Pass two: connect.
  for (const sf of sourceFiles) {
    const rel = relPath(config.root, sf.fileName);
    collectEdges(sf, rel, sf, checker, declToId, symbols, edges, config);
  }

  return {
    root: config.root,
    symbols,
    edges,
    files: fileRecords,
    entrypoints: [],
    createdAt: Date.now(),
  };
}

function createProgram(config: Config, files: string[]): ts.Program {
  const tsconfigPath = ts.findConfigFile(config.root, ts.sys.fileExists, 'tsconfig.json');
  let options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
    allowNonTsExtensions: true,
    skipLibCheck: true,
  };

  if (tsconfigPath && dirname(tsconfigPath).startsWith(config.root)) {
    const raw = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!raw.error) {
      const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(tsconfigPath));
      // Keep the project's paths/baseUrl (they drive resolution) but never its emit
      // settings, since we only ever type-check.
      options = { ...parsed.options, noEmit: true, allowJs: true, skipLibCheck: true };
    }
  }

  return ts.createProgram({ rootNames: files, options });
}

function discoverFiles(config: Config): string[] {
  const out: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // Unreadable directory is skipped, not fatal.
    }
    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.') continue;
      const abs = join(dir, entry);
      const rel = relPath(config.root, abs);
      if (matchesAny(rel, config.exclude)) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
      } else if (matchesAny(rel, config.include)) {
        out.push(abs);
      }
    }
  };

  walk(config.root);
  return out;
}

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n + 1;
}

function symbolId(file: string, name: string, container?: string): string {
  return container ? `${file}#${container}.${name}` : `${file}#${name}`;
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
  );
}

function signatureOf(node: ts.Node): string {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  ) {
    const params = node.parameters
      .map((p) => (p.type ? p.type.getText() : p.dotDotDotToken ? '...any' : 'any'))
      .join(',');
    const ret = node.type ? node.type.getText() : 'infer';
    return `(${params})=>${ret}`;
  }
  return node.kind.toString();
}

/** Comment-free, whitespace-normalised source. The input to duplicate detection. */
function normaliseBody(node: ts.Node, sf: ts.SourceFile): string {
  const text = node.getText(sf);
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function record(
  node: ts.Node,
  name: string,
  kind: SymbolKind,
  file: string,
  sf: ts.SourceFile,
  symbols: Map<string, CodeSymbol>,
  declToId: Map<ts.Node, string>,
  container?: string,
): void {
  const id = symbolId(file, name, container);
  if (symbols.has(id)) return; // First declaration wins; overloads collapse into one.
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  symbols.set(id, {
    id,
    name,
    kind,
    file,
    line: start.line + 1,
    endLine: end.line + 1,
    exported: isExported(node) || (!!container && !name.startsWith('#')),
    loc: end.line - start.line + 1,
    body: normaliseBody(node, sf),
    signature: signatureOf(node),
  });
  declToId.set(node, id);
}

/**
 * Only module-scope bindings are symbols. A local inside a function body is not
 * something anyone navigates to, and recording them floods the graph with
 * thousands of never-referenced nodes that every analysis then has to filter.
 */
function isModuleScope(node: ts.VariableDeclaration): boolean {
  const statement = node.parent?.parent;
  if (!statement || !ts.isVariableStatement(statement)) return false;
  const scope = statement.parent;
  return !!scope && (ts.isSourceFile(scope) || ts.isModuleBlock(scope));
}

function collectDeclarations(
  node: ts.Node,
  file: string,
  sf: ts.SourceFile,
  symbols: Map<string, CodeSymbol>,
  declToId: Map<ts.Node, string>,
  container?: string,
): void {
  if (ts.isFunctionDeclaration(node) && node.name) {
    record(node, node.name.text, 'function', file, sf, symbols, declToId, container);
  } else if (ts.isClassDeclaration(node) && node.name) {
    const className = node.name.text;
    record(node, className, 'class', file, sf, symbols, declToId, container);
    for (const member of node.members) {
      if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body) {
        const memberName = ts.isConstructorDeclaration(member)
          ? 'constructor'
          : member.name.getText(sf);
        record(member, memberName, 'method', file, sf, symbols, declToId, className);
      }
    }
    return; // Members are handled above; do not double-visit them.
  } else if (ts.isInterfaceDeclaration(node)) {
    record(node, node.name.text, 'interface', file, sf, symbols, declToId, container);
  } else if (ts.isTypeAliasDeclaration(node)) {
    record(node, node.name.text, 'type', file, sf, symbols, declToId, container);
  } else if (ts.isEnumDeclaration(node)) {
    record(node, node.name.text, 'enum', file, sf, symbols, declToId, container);
  } else if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    isModuleScope(node)
  ) {
    const init = node.initializer;
    const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
    // `const f = () => {}` is a function to every reader, so treat it as one.
    const target = isFn ? init : node;
    const statement = node.parent.parent;
    const exported = ts.isVariableStatement(statement) && isExported(statement);
    const id = symbolId(file, node.name.text, container);
    if (!symbols.has(id)) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const end = sf.getLineAndCharacterOfPosition(target.getEnd());
      symbols.set(id, {
        id,
        name: node.name.text,
        kind: isFn ? 'function' : 'variable',
        file,
        line: start.line + 1,
        endLine: end.line + 1,
        exported,
        loc: end.line - start.line + 1,
        body: normaliseBody(target, sf),
        signature: signatureOf(target),
      });
      declToId.set(node, id);
      if (isFn) declToId.set(init, id);
    }
  }

  ts.forEachChild(node, (child) =>
    collectDeclarations(child, file, sf, symbols, declToId, container),
  );
}

function collectEdges(
  node: ts.Node,
  file: string,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
  symbols: Map<string, CodeSymbol>,
  edges: Edge[],
  config: Config,
): void {
  const enclosing = enclosingSymbolId(node, declToId);

  if (ts.isIdentifier(node) && enclosing) {
    // Skip the identifier that *is* the declaration's own name.
    const parent = node.parent;
    const isOwnName =
      (ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isMethodDeclaration(parent)) &&
      (parent as { name?: ts.Node }).name === node;

    if (!isOwnName && !ts.isPropertyAccessExpression(parent && parent.parent ? parent : node)) {
      const target = resolveToSymbolId(node, checker, declToId);
      if (target && target !== enclosing) {
        const isCall =
          ts.isCallExpression(parent) && parent.expression === node
            ? true
            : ts.isPropertyAccessExpression(parent) &&
              ts.isCallExpression(parent.parent) &&
              parent.parent.expression === parent;
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        edges.push({
          from: enclosing,
          to: target,
          kind: isCall ? 'calls' : 'references',
          file,
          line: pos.line + 1,
        });
      }
    }
  }

  if (ts.isHeritageClause(node)) {
    const kind = node.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
    for (const type of node.types) {
      const target = resolveToSymbolId(type.expression, checker, declToId);
      const owner = enclosingSymbolId(node, declToId);
      if (target && owner) {
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        edges.push({ from: owner, to: target, kind, file, line: pos.line + 1 });
      }
    }
  }

  ts.forEachChild(node, (child) =>
    collectEdges(child, file, sf, checker, declToId, symbols, edges, config),
  );
}

/** Walk up to the nearest recorded declaration: the symbol this node lives inside. */
function enclosingSymbolId(node: ts.Node, declToId: Map<ts.Node, string>): string | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    const id = declToId.get(current);
    if (id) return id;
    current = current.parent;
  }
  return undefined;
}

/**
 * Resolve a reference to the id of the symbol it points at, following aliases
 * so that an imported name lands on the declaration in the file that owns it.
 */
function resolveToSymbolId(
  node: ts.Node,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
): string | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return undefined; // Unresolvable alias (missing dependency); not our problem to report.
    }
  }
  for (const decl of symbol.declarations ?? []) {
    const id = declToId.get(decl);
    if (id) return id;
    // A method's id is keyed on the declaration node itself; also try the parent
    // for cases like a variable declaration wrapping an arrow function.
    const parentId = decl.parent ? declToId.get(decl.parent) : undefined;
    if (parentId) return parentId;
  }
  return undefined;
}
