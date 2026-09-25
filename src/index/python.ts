import type { Node, Tree } from 'web-tree-sitter';
import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { CodeSymbol, DynamicSite, Edge, FileRecord, SymbolKind } from '../types.js';
import { record as recordSymbol, recordModule, symbolId, moduleId } from './symbol.js';
import type { Config } from '../config.js';
import { fileRecord, parserFor, type Backend, type LanguageGraph } from './treesitter.js';

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

interface FileIndex {
  file: string;
  tree: Tree;
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

export const python: Backend = {
  name: 'python',
  globs: (config) => config.python,
  build: buildPythonGraph,
};

async function buildPythonGraph(config: Config, files: string[]): Promise<LanguageGraph> {
  const p = await parserFor('python');
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

    fileRecords.set(file, fileRecord(file, source));

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

  const dynamicSites: DynamicSite[] = [];
  for (const index of indexes) {
    connectDynamic(index.file, sources.get(index.file) ?? '', symbols, edges, byModule, methodsByName, dynamicSites);
  }

  return { sources, symbols, edges, files: fileRecords, scripts, dynamicSites };
}

/** `pkg/sub/mod.py` -> `pkg.sub.mod`, which is how Python names it. */
/**
 * Reflection, read from the text rather than the tree: the patterns are few
 * and fixed, and each one only ever adds edges or records a site.
 *
 * - `getattr(obj, "name")` names a member with a string; it is a call to every
 *   method of that name, exactly like `obj.name`.
 * - `import_module(f"app.plugins.{name}")` has a fixed prefix, and every module
 *   under it is one this may load.
 * - Anything else computed — `getattr(obj, name)`, `globals()[name]`, `eval` —
 *   is recorded as a place the graph cannot follow.
 */
function connectDynamic(
  file: string,
  source: string,
  symbols: Map<string, CodeSymbol>,
  edges: Edge[],
  byModule: Map<string, FileIndex>,
  methodsByName: Map<string, string[]>,
  sites: DynamicSite[],
): void {
  const from = moduleId(file);
  const lines = source.split('\n');
  lines.forEach((text, i) => {
    const line = i + 1;
    const site = (kind: DynamicSite['kind'], match: string): void => {
      sites.push({ file, line, kind, text: match.trim().slice(0, 120) });
    };

    for (const m of text.matchAll(/\b(?:getattr|hasattr)\(\s*[^,]+?,\s*([^,)]+)/g)) {
      const literal = /^(['"])([A-Za-z_]\w*)\1$/.exec(m[1].trim());
      if (!literal) {
        site('reflection', m[0]);
        continue;
      }
      for (const id of methodsByName.get(literal[2]) ?? []) {
        edges.push({ from, to: id, kind: 'calls', file, line });
      }
    }

    for (const m of text.matchAll(/\b(?:import_module|__import__)\(\s*([^,)]+)/g)) {
      const argument = m[1].trim();
      if (/^(['"])[\w.]+\1$/.test(argument)) continue; // A literal is an ordinary import.
      const prefix =
        /^f(['"])([\w.]+)\{/.exec(argument)?.[2] ?? /^(['"])([\w.]+)\1\s*\+/.exec(argument)?.[2];
      const targets = prefix
        ? [...byModule.entries()].filter(([name]) => `.${name}`.includes(`.${prefix}`) && name !== prefix.replace(/\.$/, ''))
        : [];
      if (targets.length === 0) {
        site('import', m[0]);
        continue;
      }
      for (const [, target] of targets) {
        edges.push({ from, to: moduleId(target.file), kind: 'imports', file, line });
        for (const symbol of symbols.values()) {
          // Loading a module by name is followed by using what it defines.
          if (symbol.file === target.file && symbol.kind !== 'module' && !symbol.id.split('#')[1].includes('.')) {
            edges.push({ from, to: symbol.id, kind: 'references', file, line });
          }
        }
      }
    }

    for (const m of text.matchAll(/\b(?:globals|locals|vars)\(\)\s*\[[^\]]*\]|\b(?:eval|exec)\([^)]*\)?/g)) {
      site('reflection', m[0]);
    }
  });
}

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
  node: Node,
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
function baseNames(node: Node): string[] {
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
  body: Node,
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

// instantiate-ignore duplicate: one per language by design, each reading its own syntax tree
function record(
  node: Node,
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
      decorators: decoratorsOf(node),
      body: normaliseBody(node.text),
      signature: signatureOf(node),
    },
    container,
  );
}

/** `@app.route("/")` -> `app.route`, `@pytest.fixture` -> `pytest.fixture`. */
function decoratorsOf(node: Node): string[] | undefined {
  const wrapper = node.parent;
  if (wrapper?.type !== 'decorated_definition') return undefined;
  const out: string[] = [];
  for (let i = 0; i < wrapper.namedChildCount; i++) {
    const child = wrapper.namedChild(i);
    if (child?.type !== 'decorator') continue;
    const name = child.text.replace(/^@\s*/, '').split('(')[0].trim();
    if (name) out.push(name);
  }
  return out.length ? out : undefined;
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

function signatureOf(node: Node): string {
  const params = node.childForFieldName('parameters');
  if (!params) return node.type;
  const names: string[] = [];
  for (let i = 0; i < params.namedChildCount; i++) {
    const child = params.namedChild(i);
    if (child) names.push(child.type === 'identifier' ? 'any' : child.type);
  }
  return `(${names.join(',')})`;
}

function collectImports(root: Node, index: FileIndex): void {
  const visit = (node: Node): void => {
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
  root: Node,
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

  const visit = (node: Node, enclosing: string, className?: string): void => {
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
  callee: Node,
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
