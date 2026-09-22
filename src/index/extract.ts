import ts from 'typescript';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  const sources = new Map<string, string>();
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
    declareModule(sf, rel, text, symbols, declToId);
    sources.set(rel, stripComments(text));
    collectDeclarations(sf, rel, sf, symbols, declToId);
  }

  // Pass two: connect.
  const byFileName = new Map(sourceFiles.map((sf) => [sf.fileName, sf]));
  for (const sf of sourceFiles) {
    const rel = relPath(config.root, sf.fileName);
    collectEdges(sf, rel, sf, checker, declToId, symbols, edges, config, program, byFileName);
  }

  linkClassMembers(symbols, edges);
  collectSatelliteEdges(config, byFileName, checker, declToId, edges);

  return {
    root: config.root,
    sources,
    symbols,
    edges,
    files: fileRecords,
    entrypoints: [],
    createdAt: Date.now(),
  };
}

/**
 * Two things the graph cannot see by reference alone.
 *
 * `new Context(opts)` resolves to the class, never to its constructor, so the
 * constructor — and everything only it touches, such as the type of its own
 * parameter — looked unreachable. And a call through a base or abstract method
 * names only that declaration, while the code that actually runs is an override
 * in a subclass the caller never mentions.
 *
 * Both are real edges in the running program, so both are edges here.
 */
function linkClassMembers(symbols: Map<string, CodeSymbol>, edges: Edge[]): void {
  const methodsOf = new Map<string, Map<string, string>>();
  for (const symbol of symbols.values()) {
    if (symbol.kind !== 'method') continue;
    const [file, qualified] = symbol.id.split('#');
    const dot = qualified.lastIndexOf('.');
    if (dot === -1) continue;
    const classId = `${file}#${qualified.slice(0, dot)}`;
    const name = qualified.slice(dot + 1);
    const map = methodsOf.get(classId);
    if (map) map.set(name, symbol.id);
    else methodsOf.set(classId, new Map([[name, symbol.id]]));
  }

  // Constructing a class runs its constructor.
  for (const [classId, methods] of methodsOf) {
    const constructor = methods.get('constructor');
    const owner = symbols.get(classId);
    if (constructor && owner) {
      edges.push({ from: classId, to: constructor, kind: 'calls', file: owner.file, line: owner.line });
    }
  }

  // A reached base member reaches every override of it, in either direction of
  // the relationship: `extends` links the subclass to the base.
  const hierarchy = edges.filter((e) => e.kind === 'extends' || e.kind === 'implements');
  for (const edge of hierarchy) {
    const derived = methodsOf.get(edge.from);
    const base = methodsOf.get(edge.to);
    if (!derived || !base) continue;
    for (const [name, baseId] of base) {
      const override = derived.get(name);
      if (override && override !== baseId) {
        edges.push({ from: baseId, to: override, kind: 'calls', file: edge.file, line: edge.line });
      }
    }
  }
}

/**
 * Imports written in files we do not index: MDX pages, single-file components,
 * templates.
 *
 * A documentation site imports its React components from `.mdx`, and a Vue app
 * imports helpers from `.vue`. Neither is TypeScript, so neither appears in the
 * program, and everything they use looks unreachable. Reading just the import
 * statements is cheap and turns a large class of false positives into edges.
 */
function collectSatelliteEdges(
  config: Config,
  byFileName: Map<string, ts.SourceFile>,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
  edges: Edge[],
): void {
  const importPattern = /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

  for (const file of discoverFiles(config, config.satellites)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relPath(config.root, file);
    let match: RegExpExecArray | null;
    importPattern.lastIndex = 0;

    while ((match = importPattern.exec(text)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith('.') && !specifier.startsWith('#') && !specifier.startsWith('@/')) {
        continue; // A package import cannot reach code in this repository.
      }
      const target = resolveSatellite(specifier, file, config.root, byFileName);
      if (!target) continue;

      const line = text.slice(0, match.index).split('\n').length;
      const from = `${rel}#<satellite>`;
      // Which named export is used cannot be told apart reliably here, so treat
      // the whole module as used — the same over-approximation as `import()`.
      for (const exported of exportsOf(target, checker, declToId)) {
        edges.push({ from, to: exported, kind: 'references', file: rel, line });
      }
      edges.push({
        from,
        to: `${relPath(config.root, target.fileName)}#<module>`,
        kind: 'imports',
        file: rel,
        line,
      });
    }
  }
}

function resolveSatellite(
  specifier: string,
  from: string,
  root: string,
  byFileName: Map<string, ts.SourceFile>,
): ts.SourceFile | undefined {
  // `@/x` is the near-universal alias for the project root or its src directory.
  const bases = specifier.startsWith('@/')
    ? [join(root, specifier.slice(2)), join(root, 'src', specifier.slice(2))]
    : [join(dirname(from), specifier)];

  for (const base of bases) {
    const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
    for (const extension of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
      const hit = byFileName.get(stem + extension);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Every file gets a symbol standing for the module itself.
 *
 * Without one, any reference in top-level code — an import specifier, a
 * re-export clause, a call at module scope — has no enclosing symbol, so it
 * produces no edge at all. That single gap made reachability near-vacuous:
 * a test file whose whole body sits inside a `describe()` callback rooted
 * nothing, and a barrel of `export … from` rooted nothing either.
 *
 * Registering the SourceFile node itself means enclosingSymbolId() walks up to
 * the module and attributes the reference to it, with no other change needed.
 */
function declareModule(
  sf: ts.SourceFile,
  file: string,
  text: string,
  symbols: Map<string, CodeSymbol>,
  declToId: Map<ts.Node, string>,
): void {
  const id = `${file}#<module>`;
  symbols.set(id, {
    id,
    name: file,
    kind: 'module',
    file,
    line: 1,
    endLine: countLines(text),
    // Importing a module runs it, so it is reachable from outside by definition.
    exported: true,
    // Lines belong to the declarations inside, not to the module wrapper, or
    // every file would be counted twice in every total.
    loc: 0,
    body: '',
    signature: 'module',
  });
  declToId.set(sf, id);
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

export function discoverFiles(config: Config, include: string[] = config.include): string[] {
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
      } else if (matchesAny(rel, include)) {
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

/** Inside `declare module '…'` or `declare global`. */
function isAmbient(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isModuleDeclaration(current)) return true;
    current = current.parent;
  }
  return false;
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

/** Comments removed, line structure kept, so line numbers still mean something. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(Math.max(0, m.length - p.length)));
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
    ambient: isAmbient(node),
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
      // An `abstract` member has no body, and neither does an overload
      // signature. Skipping them meant a polymorphic `this.method()` resolved
      // to nothing at all, so every override looked unreachable.
      const isMethodLike =
        ts.isMethodDeclaration(member) ||
        ts.isConstructorDeclaration(member) ||
        ts.isMethodSignature(member) ||
        ts.isGetAccessor(member) ||
        ts.isSetAccessor(member);
      if (!isMethodLike) continue;

      const memberName = ts.isConstructorDeclaration(member)
        ? 'constructor'
        : member.name.getText(sf);
      record(member, memberName, 'method', file, sf, symbols, declToId, className);
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
  program: ts.Program,
  byFileName: Map<string, ts.SourceFile>,
): void {
  const enclosing = enclosingSymbolId(node, declToId);

  // `await import('./x')` is invisible to symbol resolution: the reference is a
  // string. Without this, every lazily loaded module looks like dead code — the
  // exact way a static graph lies about a codebase that is in fact fully alive.
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
    node.arguments.length > 0 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    enclosing
  ) {
    const target = resolveModule(node.arguments[0].text, sf, program, byFileName, config.root);
    if (target) {
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      // We cannot tell which export is used, so every export of the module is
      // reachable. Over-approximating here is correct: a false "alive" costs a
      // missed finding, a false "dead" costs the user's trust in all of them.
      for (const exported of exportsOf(target, checker, declToId)) {
        edges.push({ from: enclosing, to: exported, kind: 'calls', file, line: pos.line + 1 });
      }
    }
  }

  if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && enclosing) {
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

    // Both halves of `store.save()` matter: `store` references a declaration and
    // `save` resolves to the method, which is the only way a class member ever
    // gets a caller. Anything that resolves to nothing we index is dropped below,
    // so letting the checker decide is cheaper than guessing syntactically.
    const isPropertyName =
      (ts.isPropertyAssignment(parent) && parent.name === node) || ts.isPropertySignature(parent);

    if (!isOwnName && !isPropertyName) {
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

  // `import './x'`, `export { y } from './x'`, `export * from './x'`.
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier) &&
    enclosing
  ) {
    const specifier = node.moduleSpecifier.text;
    const targets = specifier.startsWith('#')
      ? resolveSubpath(specifier, config.root, byFileName)
      : [resolveModule(specifier, sf, program, byFileName, config.root)];

    for (const target of targets) {
      if (!target) continue;
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const targetModule = `${relPath(config.root, target.fileName)}#<module>`;
      edges.push({ from: enclosing, to: targetModule, kind: 'imports', file, line: pos.line + 1 });

      // `export * from './x'` names nothing, so no identifier resolves and the
      // re-exported symbols would look unreferenced. Expand it explicitly.
      const starred =
        ts.isExportDeclaration(node) &&
        (!node.exportClause || ts.isNamespaceExport(node.exportClause));
      // `import * as tags from './x'` is almost always followed by `tags[key]`,
      // a dynamic lookup no static graph can trace. Every export of the module
      // is therefore potentially used, and hono's entire JSX intrinsic-element
      // set looked dead because of exactly this pattern.
      const namespaceImport =
        ts.isImportDeclaration(node) &&
        !!node.importClause?.namedBindings &&
        ts.isNamespaceImport(node.importClause.namedBindings);

      if (starred || namespaceImport || specifier.startsWith('#')) {
        for (const exported of exportsOf(target, checker, declToId)) {
          edges.push({ from: enclosing, to: exported, kind: 'references', file, line: pos.line + 1 });
        }
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
    collectEdges(child, file, sf, checker, declToId, symbols, edges, config, program, byFileName),
  );
}

/**
 * Node subpath imports (`#supports-color`), declared in package.json `imports`.
 * Resolution does not follow them without the right module settings, so a
 * package that vendors code behind a `#` alias looks entirely unreachable —
 * which is exactly what happened to chalk's bundled supports-color.
 */
function subpathImports(root: string): Map<string, string[]> {
  const cached = subpathCache.get(root);
  if (cached) return cached;

  const map = new Map<string, string[]>();
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const collect = (key: string, value: unknown): void => {
      if (typeof value === 'string') {
        const list = map.get(key) ?? [];
        const path = value.replace(/^\.\//, '');
        if (!list.includes(path)) list.push(path);
        map.set(key, list);
        return;
      }
      if (value && typeof value === 'object') {
        for (const nested of Object.values(value as Record<string, unknown>)) collect(key, nested);
      }
    };
    for (const [key, value] of Object.entries(pkg.imports ?? {})) collect(key, value);
  } catch {
    // No package.json, or no imports field: nothing to resolve.
  }
  subpathCache.set(root, map);
  return map;
}

const subpathCache = new Map<string, Map<string, string[]>>();

/**
 * Every file a subpath import can select, across conditions.
 *
 * `#supports-color` resolves to the node build or the browser build depending
 * on the consumer, so both are reachable. Returning only the first left the
 * browser variant looking entirely dead.
 */
function resolveSubpath(
  specifier: string,
  root: string,
  byFileName: Map<string, ts.SourceFile>,
): ts.SourceFile[] {
  const out: ts.SourceFile[] = [];
  for (const mapped of subpathImports(root).get(specifier) ?? []) {
    const base = join(root, mapped).replace(/\.(js|mjs|cjs)$/, '');
    let hit: ts.SourceFile | undefined;
    for (const extension of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
      hit = byFileName.get(base + extension);
      if (hit) break;
    }
    hit ??= byFileName.get(join(root, mapped));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Resolve a module specifier to an indexed source file, if it is one of ours. */
function resolveModule(
  specifier: string,
  from: ts.SourceFile,
  program: ts.Program,
  byFileName: Map<string, ts.SourceFile>,
  root: string,
): ts.SourceFile | undefined {
  if (specifier.startsWith('#')) return resolveSubpath(specifier, root, byFileName)[0];

  const resolved = ts.resolveModuleName(
    specifier,
    from.fileName,
    program.getCompilerOptions(),
    ts.sys,
  ).resolvedModule;
  if (resolved) {
    const hit = byFileName.get(resolved.resolvedFileName);
    if (hit) return hit;
  }
  // Resolution fails for `./x.js` pointing at `x.ts` under some configurations,
  // so fall back to matching the path we would have written on disk.
  if (specifier.startsWith('.')) {
    const base = join(dirname(from.fileName), specifier).replace(/\.(js|mjs|cjs)$/, '');
    for (const extension of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
      const hit = byFileName.get(base + extension);
      if (hit) return hit;
    }
  }
  return undefined;
}

function exportsOf(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
): string[] {
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) return [];
  const ids: string[] = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const resolved = unalias(exported, checker);
    if (!resolved) continue;
    const id = idOfDeclaration(resolved, declToId);
    if (id) ids.push(id);
  }
  return ids;
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
  const found = checker.getSymbolAtLocation(node);
  if (!found) return undefined;
  const symbol = unalias(found, checker);
  if (!symbol) return undefined;
  return idOfDeclaration(symbol, declToId);
}

/**
 * A symbol's declaration, mapped to the id we recorded for it.
 *
 * The method's id is keyed on the declaration node itself, so the parent is
 * tried too: a variable declaration wrapping an arrow function is recorded
 * against the declaration, not the function expression.
 */
function idOfDeclaration(symbol: ts.Symbol, declToId: Map<ts.Node, string>): string | undefined {
  for (const decl of symbol.declarations ?? []) {
    const id = declToId.get(decl) ?? (decl.parent ? declToId.get(decl.parent) : undefined);
    if (id) return id;
  }
  return undefined;
}

/** Follow an alias to the symbol it actually names. */
function unalias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return undefined; // Unresolvable alias (a missing dependency); not ours to report.
  }
}
