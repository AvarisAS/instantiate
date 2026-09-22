import Parser from 'web-tree-sitter';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { CodeSymbol, Edge, FileRecord, SymbolKind } from '../types.js';
import type { Config } from '../config.js';

/**
 * Python, through tree-sitter.
 *
 * There is no type checker here, so resolution is by name and scope rather than
 * by type. That is weaker than the TypeScript indexer and the analyses are told
 * so: where a call could mean several things, an edge is emitted to each
 * candidate. Over-approximating costs a missed finding; under-approximating
 * costs a false "this is dead", and trust is far harder to win back than a
 * finding is to re-run.
 */

export interface PythonGraph {
  sources: Map<string, string>;
  symbols: Map<string, CodeSymbol>;
  edges: Edge[];
  files: Map<string, FileRecord>;
  /** Files with a `__main__` guard: these are run, so they are entrypoints. */
  scripts: string[];
}

let parser: Parser | undefined;

async function getParser(): Promise<Parser> {
  if (parser) return parser;
  const require = createRequire(import.meta.url);
  const wasmDir = dirname(require.resolve('tree-sitter-wasms/package.json'));
  await Parser.init();
  const language = await Parser.Language.load(join(wasmDir, 'out', 'tree-sitter-python.wasm'));
  parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

interface FileIndex {
  file: string;
  tree: Parser.Tree;
  source: string;
  /** Module-level name -> symbol id, for resolving a bare call. */
  locals: Map<string, string>;
  /** Imported alias -> module path, for resolving across files. */
  imports: Map<string, { module: string; name?: string }>;
  /** Class name -> (method name -> symbol id). */
  classes: Map<string, Map<string, string>>;
}

export async function buildPythonGraph(config: Config, files: string[]): Promise<PythonGraph> {
  const p = await getParser();
  const symbols = new Map<string, CodeSymbol>();
  const edges: Edge[] = [];
  const fileRecords = new Map<string, FileRecord>();
  const sources = new Map<string, string>();
  const indexes: FileIndex[] = [];
  const scripts: string[] = [];

  // Pass one: declare everything, so any edge has something to point at.
  for (const absolute of files) {
    let source: string;
    try {
      source = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const file = relative(config.root, absolute).split('\\').join('/');
    const tree = p.parse(source);
    if (!tree) continue;

    fileRecords.set(file, {
      path: file,
      loc: source.split('\n').length,
      hash: createHash('sha1').update(source).digest('hex').slice(0, 16),
      indexedAt: Date.now(),
    });

    sources.set(file, source.replace(/#[^\n]*/g, ''));

    // `if __name__ == "__main__":` is Python's way of saying "this file is run".
    if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(source)) scripts.push(file);

    const index: FileIndex = {
      file,
      tree,
      source,
      locals: new Map(),
      imports: new Map(),
      classes: new Map(),
    };
    declareModule(index, symbols);
    declare(tree.rootNode, index, symbols);
    collectImports(tree.rootNode, index);
    indexes.push(index);
  }

  // A method name may belong to any class, since `obj.method()` says nothing
  // about obj's type without inference.
  const methodsByName = new Map<string, string[]>();
  for (const index of indexes) {
    for (const methods of index.classes.values()) {
      for (const [name, id] of methods) {
        const list = methodsByName.get(name);
        if (list) list.push(id);
        else methodsByName.set(name, [id]);
      }
    }
  }

  const byModule = new Map(indexes.map((i) => [moduleName(i.file), i]));

  // Pass two: connect.
  for (const index of indexes) {
    connect(index.tree.rootNode, index, symbols, edges, byModule, methodsByName, config);
  }

  return { sources, symbols, edges, files: fileRecords, scripts };
}

/** `pkg/sub/mod.py` -> `pkg.sub.mod`, which is how Python names it. */
function moduleName(file: string): string {
  return file
    .replace(/\.py$/, '')
    .replace(/\/__init__$/, '')
    .split('/')
    .filter((p) => p !== 'src')
    .join('.');
}

function declareModule(index: FileIndex, symbols: Map<string, CodeSymbol>): void {
  const id = `${index.file}#<module>`;
  symbols.set(id, {
    id,
    name: index.file,
    kind: 'module',
    file: index.file,
    line: 1,
    endLine: index.source.split('\n').length,
    exported: true,
    loc: 0,
    body: '',
    signature: 'module',
  });
}

function declare(
  node: Parser.SyntaxNode,
  index: FileIndex,
  symbols: Map<string, CodeSymbol>,
  className?: string,
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === 'class_definition') {
      const name = child.childForFieldName('name')?.text;
      if (name) {
        record(child, name, 'class', index, symbols);
        index.locals.set(name, symbolId(index.file, name));
        const methods = new Map<string, string>();
        index.classes.set(name, methods);
        const body = child.childForFieldName('body');
        if (body) declareMethods(body, name, index, symbols, methods);
      }
      continue;
    }

    if (child.type === 'function_definition') {
      const name = child.childForFieldName('name')?.text;
      if (name) {
        record(child, name, className ? 'method' : 'function', index, symbols, className);
        if (!className) index.locals.set(name, symbolId(index.file, name));
      }
      continue;
    }

    // A module-level assignment is a name other modules can import.
    if (child.type === 'expression_statement' && node.type === 'module') {
      const assignment = child.child(0);
      if (assignment?.type === 'assignment') {
        const left = assignment.childForFieldName('left');
        if (left?.type === 'identifier') {
          record(assignment, left.text, 'variable', index, symbols);
          index.locals.set(left.text, symbolId(index.file, left.text));
        }
      }
      continue;
    }

    // Decorated definitions wrap the real one.
    if (child.type === 'decorated_definition') {
      declare(child, index, symbols, className);
      continue;
    }

    if (child.type === 'if_statement' || child.type === 'try_statement') {
      declare(child, index, symbols, className);
    }
  }
}

function declareMethods(
  body: Parser.SyntaxNode,
  className: string,
  index: FileIndex,
  symbols: Map<string, CodeSymbol>,
  methods: Map<string, string>,
): void {
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child) continue;
    const definition = child.type === 'decorated_definition' ? child.childForFieldName('definition') : child;
    if (definition?.type === 'function_definition') {
      const name = definition.childForFieldName('name')?.text;
      if (name) {
        record(definition, name, 'method', index, symbols, className);
        methods.set(name, symbolId(index.file, name, className));
      }
    }
  }
}

function symbolId(file: string, name: string, container?: string): string {
  return container ? `${file}#${container}.${name}` : `${file}#${name}`;
}

function record(
  node: Parser.SyntaxNode,
  name: string,
  kind: SymbolKind,
  index: FileIndex,
  symbols: Map<string, CodeSymbol>,
  container?: string,
): void {
  const id = symbolId(index.file, name, container);
  if (symbols.has(id)) return;
  const text = node.text;
  symbols.set(id, {
    id,
    name,
    kind,
    file: index.file,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    // Python has no export keyword; a leading underscore is the convention for
    // "internal", and everything else is part of the module's surface.
    exported: !name.startsWith('_'),
    loc: node.endPosition.row - node.startPosition.row + 1,
    body: text.replace(/#[^\n]*/g, ' ').replace(/\s+/g, ' ').trim(),
    signature: signatureOf(node),
  });
}

function signatureOf(node: Parser.SyntaxNode): string {
  const params = node.childForFieldName('parameters');
  if (!params) return node.type;
  const names: string[] = [];
  for (let i = 0; i < params.namedChildCount; i++) {
    const child = params.namedChild(i);
    if (child) names.push(child.type === 'identifier' ? 'any' : child.type);
  }
  return `(${names.join(',')})`;
}

function collectImports(root: Parser.SyntaxNode, index: FileIndex): void {
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      const module = moduleNode ? resolveRelative(moduleNode.text, index.file) : '';
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child || child === moduleNode) continue;
        if (child.type === 'dotted_name' || child.type === 'identifier') {
          index.imports.set(child.text.split('.').pop()!, { module, name: child.text });
        } else if (child.type === 'aliased_import') {
          const original = child.childForFieldName('name')?.text;
          const alias = child.childForFieldName('alias')?.text;
          if (original && alias) index.imports.set(alias, { module, name: original });
        } else if (child.type === 'wildcard_import') {
          index.imports.set('*', { module });
        }
      }
    } else if (node.type === 'import_statement') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'dotted_name') {
          index.imports.set(child.text.split('.').pop()!, { module: child.text });
        } else if (child.type === 'aliased_import') {
          const original = child.childForFieldName('name')?.text;
          const alias = child.childForFieldName('alias')?.text;
          if (original && alias) index.imports.set(alias, { module: original });
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }
  };
  visit(root);
}

/** `from .sibling import x` and `from ..pkg import y` are relative to this file. */
function resolveRelative(module: string, file: string): string {
  if (!module.startsWith('.')) return module;
  const up = module.match(/^\.+/)![0].length;
  const parts = file.split('/').slice(0, -1);
  const base = parts.slice(0, parts.length - (up - 1)).filter((p) => p !== 'src');
  const rest = module.slice(up);
  return [...base, ...(rest ? rest.split('.') : [])].join('.');
}

function connect(
  root: Parser.SyntaxNode,
  index: FileIndex,
  symbols: Map<string, CodeSymbol>,
  edges: Edge[],
  byModule: Map<string, FileIndex>,
  methodsByName: Map<string, string[]>,
  config: Config,
): void {
  const moduleId = `${index.file}#<module>`;

  // The interpreter calls dunder methods itself: `__call__` on `auth(request)`,
  // `__enter__` on a `with` block, `__iter__` on a loop. Nothing in the source
  // names them, so a reachable class must be taken to reach its own.
  for (const [className, methods] of index.classes) {
    const classId = symbolId(index.file, className);
    for (const [name, methodId] of methods) {
      if (name.startsWith('__') && name.endsWith('__')) {
        edges.push({ from: classId, to: methodId, kind: 'calls', file: index.file, line: 1 });
      }
    }
  }

  // Importing a module runs it, and names what it brings in.
  for (const [alias, imported] of index.imports) {
    const target = byModule.get(imported.module);
    if (!target) continue;
    edges.push({ from: moduleId, to: `${target.file}#<module>`, kind: 'imports', file: index.file, line: 1 });

    const wanted = alias === '*' ? [...target.locals.keys()] : [imported.name?.split('.').pop() ?? alias];
    for (const name of wanted) {
      const id = target.locals.get(name);
      if (id) edges.push({ from: moduleId, to: id, kind: 'references', file: index.file, line: 1 });
    }
  }

  const visit = (node: Parser.SyntaxNode, enclosing: string, className?: string): void => {
    let scope = enclosing;
    let scopeClass = className;

    if (node.type === 'class_definition') {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        scope = symbolId(index.file, name);
        scopeClass = name;
      }
    } else if (node.type === 'function_definition') {
      const name = node.childForFieldName('name')?.text;
      if (name) scope = symbolId(index.file, name, className);
    } else if (node.type === 'call') {
      const callee = node.childForFieldName('function');
      if (callee) {
        for (const target of resolveCall(callee, index, byModule, methodsByName, scopeClass)) {
          edges.push({
            from: scope,
            to: target,
            kind: 'calls',
            file: index.file,
            line: node.startPosition.row + 1,
          });
        }
      }
    } else if (node.type === 'attribute' && scopeClass) {
      // `self.handler` used as a value, not called: `register_hook("x", self.handler)`
      // passes the method somewhere that will invoke it later. Without this edge
      // the method, and everything it reaches, looks unreachable.
      const object = node.childForFieldName('object');
      const attribute = node.childForFieldName('attribute')?.text;
      if (object?.type === 'identifier' && object.text === 'self' && attribute) {
        const own = index.classes.get(scopeClass)?.get(attribute);
        if (own && own !== scope) {
          edges.push({
            from: scope,
            to: own,
            kind: 'references',
            file: index.file,
            line: node.startPosition.row + 1,
          });
        }
      }
    } else if (node.type === 'identifier' && symbols.has(symbolId(index.file, node.text))) {
      const target = symbolId(index.file, node.text);
      if (target !== scope) {
        edges.push({
          from: scope,
          to: target,
          kind: 'references',
          file: index.file,
          line: node.startPosition.row + 1,
        });
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child, scope, scopeClass);
    }
  };

  visit(root, moduleId);
}

function resolveCall(
  callee: Parser.SyntaxNode,
  index: FileIndex,
  byModule: Map<string, FileIndex>,
  methodsByName: Map<string, string[]>,
  className?: string,
): string[] {
  if (callee.type === 'identifier') {
    const local = index.locals.get(callee.text);
    if (local) return [local];
    const imported = index.imports.get(callee.text);
    if (imported) {
      const target = byModule.get(imported.module);
      const id = target?.locals.get(imported.name?.split('.').pop() ?? callee.text);
      if (id) return [id];
    }
    return [];
  }

  if (callee.type === 'attribute') {
    const object = callee.childForFieldName('object');
    const attribute = callee.childForFieldName('attribute')?.text;
    if (!attribute) return [];

    // `self.method()` is unambiguous: it is this class, or one of its bases.
    if (object?.type === 'identifier' && object.text === 'self' && className) {
      const own = index.classes.get(className)?.get(attribute);
      if (own) return [own];
    }

    // `mod.function()` where mod was imported.
    if (object?.type === 'identifier') {
      const imported = index.imports.get(object.text);
      const target = imported ? byModule.get(imported.module) : undefined;
      const id = target?.locals.get(attribute);
      if (id) return [id];
    }

    // `obj.method()` with no type information. Every method of that name is a
    // candidate; claiming otherwise would invent a false "this is dead".
    return methodsByName.get(attribute) ?? [];
  }

  return [];
}
