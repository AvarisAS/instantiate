import Parser from 'web-tree-sitter';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { CodeSymbol, Edge, FileRecord, SymbolKind } from '../types.js';
import { record as recordSymbol, recordModule, symbolId, moduleId } from './symbol.js';
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
  /** Class name -> the names it inherits from. */
  bases: Map<string, string[]>;
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
      bases: new Map(),
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
  recordModule(symbols, index.file, index.source.split('\n').length);
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
        index.bases.set(name, baseNames(child));
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

/** The names in `class Option(Parameter):`. */
function baseNames(node: Parser.SyntaxNode): string[] {
  const args = node.childForFieldName('superclasses');
  if (!args) return [];
  const out: string[] = [];
  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (!child) continue;
    // `class X(Base)` and `class X(module.Base)` both name a base.
    const text = child.type === 'attribute' ? child.text.split('.').pop()! : child.text;
    if (/^[A-Za-z_]\w*$/.test(text)) out.push(text);
  }
  return out;
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

function record(
  node: Parser.SyntaxNode,
  name: string,
  kind: SymbolKind,
  index: FileIndex,
  symbols: Map<string, CodeSymbol>,
  container?: string,
): void {
  recordSymbol(
    symbols,
    {
      name,
      kind,
      file: index.file,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      // Python has no export keyword; a leading underscore is the convention
      // for "internal", and everything else is part of the module's surface.
      exported: !name.startsWith('_'),
      body: normaliseBody(node.text),
      signature: signatureOf(node),
    },
    container,
  );
}

/**
 * Strip docstrings as well as comments.
 *
 * A docstring is prose, not behaviour, and Python puts a great deal of it
 * inside the function body. Left in, it dominated both similarity signals: two
 * unrelated methods with long typed signatures and thorough documentation
 * scored 81% on their prose alone, which is the opposite of what this measures.
 */
function normaliseBody(text: string): string {
  return text
    .replace(/'''[\s\S]*?'''/g, ' ')
    .replace(/"""[\s\S]*?"""/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  const ownModuleId = moduleId(index.file);

  // `__getattr__` at module level is Python's module attribute hook, and
  // `__all__` and friends are read by the import machinery. Nothing names them.
  for (const [name, id] of index.locals) {
    if (name.startsWith('__') && name.endsWith('__')) {
      edges.push({ from: ownModuleId, to: id, kind: 'calls', file: index.file, line: 1 });
    }
  }

  // A reached base method reaches every override of it.
  //
  // `self.consume_value()` in `Parameter` resolves to `Parameter.consume_value`,
  // but what runs for an `Option` is the override — which nothing else names,
  // so every subclass implementation looked unreachable.
  for (const [className, bases] of index.bases) {
    const own = index.classes.get(className);
    if (!own) continue;
    for (const baseName of bases) {
      // `class TextWrapper(textwrap.TextWrapper)` shadows its base's name, so a
      // lookup finds the subclass itself and concludes the base is local when
      // it is in fact the standard library's.
      const candidates = allClasses(byModule, baseName).filter((m) => m !== own);
      for (const candidate of candidates) {
        for (const [methodName, baseId] of candidate) {
          const override = own.get(methodName);
          if (override && override !== baseId) {
            edges.push({ from: baseId, to: override, kind: 'calls', file: index.file, line: 1 });
          }
        }
      }
      // A base outside this repository — `textwrap.TextWrapper` — still calls
      // the override, so an override of an unknown base is reached by its class.
      if (candidates.length === 0) {
        const classId = symbolId(index.file, className);
        for (const methodId of own.values()) {
          edges.push({ from: classId, to: methodId, kind: 'calls', file: index.file, line: 1 });
        }
      }
    }
  }

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
    const target = importedModule(imported, alias, byModule);
    if (!target) continue;
    edges.push({ from: ownModuleId, to: moduleId(target.file), kind: 'imports', file: index.file, line: 1 });

    const wanted = alias === '*' ? [...target.locals.keys()] : [imported.name?.split('.').pop() ?? alias];
    for (const name of wanted) {
      const id = target.locals.get(name);
      if (id) edges.push({ from: ownModuleId, to: id, kind: 'references', file: index.file, line: 1 });
    }
  }

  const visit = (node: Parser.SyntaxNode, enclosing: string, className?: string): void => {
    let scope = enclosing;
    let scopeClass = className;

    // Only descend into a scope we actually recorded. A nested `def` — the
    // inner function a decorator factory returns — is not a symbol, so keying
    // edges on its name attributed them to something that does not exist, and
    // everything it called looked unreachable.
    if (node.type === 'class_definition') {
      const name = node.childForFieldName('name')?.text;
      const candidate = name ? symbolId(index.file, name) : undefined;
      if (name && candidate && symbols.has(candidate)) {
        scope = candidate;
        scopeClass = name;
      }
    } else if (node.type === 'function_definition') {
      const name = node.childForFieldName('name')?.text;
      const candidate = name ? symbolId(index.file, name, className) : undefined;
      if (candidate && symbols.has(candidate)) scope = candidate;
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
    } else if (node.type === 'attribute') {
      // `types.OptionHelpExtra` in a type annotation names a symbol in another
      // module without calling it, so the call path never saw it.
      const object = node.childForFieldName('object');
      const attribute = node.childForFieldName('attribute')?.text;
      if (object?.type === 'identifier' && attribute) {
        const imported = index.imports.get(object.text);
        const target = imported ? importedModule(imported, object.text, byModule) : undefined;
        const id = target?.locals.get(attribute);
        if (id && id !== scope) {
          edges.push({
            from: scope,
            to: id,
            kind: 'references',
            file: index.file,
            line: node.startPosition.row + 1,
          });
        }
      }
    }

    if (node.type === 'attribute' && scopeClass) {
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

  visit(root, ownModuleId);
}

/** Every class of this name across the project, since Python has no types here. */
function allClasses(
  byModule: Map<string, FileIndex>,
  className: string,
): Array<Map<string, string>> {
  const out: Array<Map<string, string>> = [];
  for (const index of byModule.values()) {
    const methods = index.classes.get(className);
    if (methods) out.push(methods);
  }
  return out;
}

/**
 * `from . import types` imports a submodule, not a name.
 *
 * Treating it as a name looked for `types` inside the package's `__init__`,
 * found nothing, and left every reference through that alias unresolved.
 */
function importedModule(
  imported: { module: string; name?: string },
  alias: string,
  byModule: Map<string, FileIndex>,
): FileIndex | undefined {
  const submodule = `${imported.module}.${imported.name ?? alias}`.replace(/^\./, '');
  return byModule.get(submodule) ?? byModule.get(imported.module);
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
      // Declared on a base, or supplied by a subclass: either way `self.x()`
      // runs something named x, and the override linking above carries it on.
      const inherited = methodsByName.get(attribute);
      if (inherited && inherited.length > 0) return inherited;
    }

    // `super().method()` runs the base implementation.
    if (object?.type === 'call' && object.childForFieldName('function')?.text === 'super') {
      return methodsByName.get(attribute) ?? [];
    }

    // `mod.function()` where mod was imported.
    if (object?.type === 'identifier') {
      const imported = index.imports.get(object.text);
      const target = imported ? importedModule(imported, object.text, byModule) : undefined;
      const id = target?.locals.get(attribute);
      if (id) return [id];
    }

    // `obj.method()` with no type information. Every method of that name is a
    // candidate; claiming otherwise would invent a false "this is dead".
    return methodsByName.get(attribute) ?? [];
  }

  return [];
}
