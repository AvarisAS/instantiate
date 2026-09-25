import type { Node } from 'web-tree-sitter';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { CodeSymbol, DynamicSite, Edge, FileRecord, SymbolKind } from '../types.js';
import { record as recordSymbol, recordModule, symbolId, moduleId } from './symbol.js';
import type { Config } from '../config.js';
import { fileRecord, parserFor, stripCStyleComments, type Backend, type LanguageGraph } from './treesitter.js';

/**
 * Go, through tree-sitter.
 *
 * Go makes most of this easy: a package is a directory, an import is a path,
 * and "exported" is a capital letter. Two things it makes hard are handled by
 * over-approximating, as the Python indexer does:
 *
 * - `x.Method()` says nothing about x's type without a checker, so it reaches
 *   every method of that name in the repository.
 * - Interfaces are satisfied implicitly. A type's exported methods may be
 *   called through any interface anywhere, the standard library included, so
 *   using a type reaches all of them; an unexported method is reached when an
 *   interface in this repository names it.
 */
export const go: Backend = {
  name: 'go',
  globs: (config) => config.go,
  build: buildGoGraph,
};

interface FileIndex {
  file: string;
  tree: Node;
  /** `dir|package`, so an external `foo_test` package is kept apart from `foo`. */
  pkg: string;
  packageName: string;
  /** Import alias -> directory of that package, for this repository's packages. */
  imports: Map<string, string>;
}

/**
 * Package key -> name -> symbol ids, for package-level declarations.
 *
 * Several ids per name, because `x_unix.go` and `x_windows.go` both declare
 * it and the build picks one. A reference reaches every variant: which one is
 * compiled depends on the platform, not on this repository.
 */
type Scope = Map<string, Map<string, string[]>>;

function bind(names: Map<string, string[]>, name: string, id: string): void {
  const list = names.get(name) ?? [];
  if (!list.includes(id)) list.push(id);
  names.set(name, list);
}

async function buildGoGraph(config: Config, files: string[]): Promise<LanguageGraph> {
  const parser = await parserFor('go');
  const symbols = new Map<string, CodeSymbol>();
  const edges: Edge[] = [];
  const records = new Map<string, FileRecord>();
  const sources = new Map<string, string>();
  const dynamicSites: DynamicSite[] = [];
  const scripts: string[] = [];
  const publicApi: string[] = [];
  const modules = goModules(config.root);

  const indexes: FileIndex[] = [];
  const scope: Scope = new Map();
  /** Directory -> package keys in it, for resolving an import to its files. */
  const byDir = new Map<string, Set<string>>();
  /** Receiver type -> (method name -> id), across every file of a package. */
  const methods = new Map<string, Map<string, string>>();
  /** Method names some interface in this repository requires. */
  const required = new Set<string>();

  for (const absolute of files) {
    let text: string;
    try {
      text = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const tree = parser.parse(text);
    if (!tree) continue;
    const file = relative(config.root, absolute).split('\\').join('/');
    const dir = dirname(file);
    const root = tree.rootNode;
    const packageName = root.namedChildren.find((n) => n?.type === 'package_clause')?.namedChild(0)?.text ?? '';
    const pkg = `${dir}|${packageName}`;

    records.set(file, fileRecord(file, text));
    sources.set(file, stripCStyleComments(text));
    recordModule(symbols, file, text.split('\n').length);
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir)!.add(pkg);
    if (!scope.has(pkg)) scope.set(pkg, new Map());

    const index: FileIndex = { file, tree: root, pkg, packageName, imports: new Map() };
    declare(index, symbols, scope.get(pkg)!, methods, required);
    indexes.push(index);

    // `package main` with a `func main` is a program: something runs it.
    if (packageName === 'main' && symbols.has(symbolId(file, 'main'))) scripts.push(file);
    // Exported names of a non-main package outside `internal/` are importable
    // by other modules: the package's contract, whether or not this repo uses them.
    const isTest = file.endsWith('_test.go');
    if (packageName !== 'main' && !isTest && !/(^|\/)internal(\/|$)/.test(dir)) publicApi.push(file);
  }

  for (const index of indexes) collectImports(index, modules, byDir);

  // Files of one package load together, and loading runs every init().
  const filesOf = new Map<string, string[]>();
  for (const index of indexes) {
    const list = filesOf.get(index.pkg) ?? [];
    list.push(index.file);
    filesOf.set(index.pkg, list);
  }
  for (const list of filesOf.values()) {
    for (const file of list) {
      for (const sibling of list) {
        if (sibling !== file) edges.push({ from: moduleId(file), to: moduleId(sibling), kind: 'imports', file, line: 1 });
      }
      const init = symbolId(file, 'init');
      if (symbols.has(init)) edges.push({ from: moduleId(file), to: init, kind: 'calls', file, line: 1 });
    }
  }

  // Using a type brings the methods that may satisfy an interface.
  for (const [key, members] of methods) {
    const cut = key.lastIndexOf('|');
    for (const typeId of scope.get(key.slice(0, cut))?.get(key.slice(cut + 1)) ?? []) {
      const owner = symbols.get(typeId);
      if (!owner) continue;
      for (const [name, id] of members) {
        if (isExported(name) || required.has(name)) {
          edges.push({ from: typeId, to: id, kind: 'calls', file: owner.file, line: owner.line });
        }
      }
    }
  }

  const methodsByName = new Map<string, string[]>();
  for (const members of methods.values()) {
    for (const [name, id] of members) methodsByName.set(name, [...(methodsByName.get(name) ?? []), id]);
  }

  for (const index of indexes) {
    connect(index, symbols, edges, scope, filesOf, methodsByName, dynamicSites);
  }

  return { symbols, edges, files: records, sources, scripts, dynamicSites, publicApi };
}

/** Every go.mod in the repository: module path -> its directory. */
function goModules(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      return;
    }
    if (entries.includes('go.mod')) {
      const text = readFileSync(join(root, dir, 'go.mod'), 'utf8');
      const name = /^module\s+(\S+)/m.exec(text)?.[1];
      if (name) out.set(name, dir === '.' ? '' : dir);
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'vendor' || entry === 'node_modules' || entry === 'testdata') continue;
      const next = dir === '.' ? entry : `${dir}/${entry}`;
      try {
        if (existsSync(join(root, next, '.')) && !entry.includes('.')) walk(next, depth + 1);
      } catch {
        // Unreadable: skip.
      }
    }
  };
  walk('.', 0);
  return out;
}

function declare(
  index: FileIndex,
  symbols: Map<string, CodeSymbol>,
  names: Map<string, string[]>,
  methods: Map<string, Map<string, string>>,
  required: Set<string>,
): void {
  for (const node of index.tree.namedChildren) {
    if (!node) continue;
    switch (node.type) {
      case 'function_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (!name) break;
        // Several init() functions may share a file; the first stands for them all.
        bind(names, name, record(node, name, 'function', index.file, symbols));
        break;
      }
      case 'method_declaration': {
        const name = node.childForFieldName('name')?.text;
        const receiver = receiverType(node);
        if (!name || !receiver) break;
        const id = record(node, name, 'method', index.file, symbols, receiver);
        // Methods may sit in a different file from their type, so they are
        // keyed by the type's name within the package and resolved later.
        const key = `${index.pkg}|${receiver}`;
        const map = methods.get(key) ?? new Map<string, string>();
        map.set(name, id);
        methods.set(key, map);
        break;
      }
      case 'type_declaration': {
        for (const spec of node.namedChildren) {
          if (spec?.type !== 'type_spec' && spec?.type !== 'type_alias') continue;
          const name = spec.childForFieldName('name')?.text;
          if (!name) continue;
          const type = spec.childForFieldName('type');
          const kind: SymbolKind = type?.type === 'interface_type' ? 'interface' : 'class';
          bind(names, name, record(spec, name, kind, index.file, symbols));
          if (type?.type === 'interface_type') {
            for (const element of type.namedChildren) {
              const method = element?.type === 'method_elem' ? element.childForFieldName('name')?.text : undefined;
              if (method) required.add(method);
            }
          }
        }
        break;
      }
      case 'var_declaration':
      case 'const_declaration': {
        for (const spec of specs(node)) {
          for (const nameNode of spec.childrenForFieldName('name')) {
            if (!nameNode || nameNode.text === '_') continue;
            bind(names, nameNode.text, record(spec, nameNode.text, 'variable', index.file, symbols));
          }
        }
        break;
      }
    }
  }
}

/** `var ( a = 1; b = 2 )` nests its specs in a list; `var a = 1` does not. */
function specs(node: Node): Node[] {
  const out: Node[] = [];
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'var_spec' || child.type === 'const_spec') out.push(child);
    else if (child.type === 'var_spec_list' || child.type === 'const_spec_list') out.push(...specs(child));
  }
  return out;
}

/** `func (s *Server[T]) ...` -> `Server`. */
function receiverType(method: Node): string | undefined {
  const receiver = method.childForFieldName('receiver');
  const type = receiver?.namedChildren.find((n) => n?.type === 'parameter_declaration')?.childForFieldName('type');
  const text = type?.text ?? '';
  return /\*?\s*([A-Za-z_]\w*)/.exec(text)?.[1];
}

function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

// instantiate-ignore duplicate: one per language by design, each reading its own syntax tree
function record(
  node: Node,
  name: string,
  kind: SymbolKind,
  file: string,
  symbols: Map<string, CodeSymbol>,
  container?: string,
): string {
  return recordSymbol(
    symbols,
    {
      name,
      kind,
      file,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: isExported(name),
      body: stripCStyleComments(node.text).replace(/\s+/g, ' ').trim(),
      signature: `${kind}:${node.childForFieldName('parameters')?.namedChildCount ?? 0}`,
    },
    container,
  );
}

function collectImports(index: FileIndex, modules: Map<string, string>, byDir: Map<string, Set<string>>): void {
  const visit = (node: Node): void => {
    if (node.type === 'import_spec') {
      const path = node.childForFieldName('path')?.text.replace(/^["`]|["`]$/g, '');
      if (!path) return;
      const dir = resolveImport(path, modules);
      if (!dir || !byDir.has(dir)) return;
      const alias = node.childForFieldName('name')?.text;
      // Without an alias a package is named by its clause, which is almost
      // always the last path element.
      const name = alias ?? path.split('/').pop()!.replace(/^go-/, '').replace(/[.-].*$/, '');
      index.imports.set(name, dir);
      return;
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  for (const child of index.tree.namedChildren) {
    if (child?.type === 'import_declaration') visit(child);
  }
}

/** An import path to a directory in this repository, through the longest matching go.mod. */
function resolveImport(path: string, modules: Map<string, string>): string | undefined {
  let best: [string, string] | undefined;
  for (const [module, dir] of modules) {
    if ((path === module || path.startsWith(`${module}/`)) && (!best || module.length > best[0].length)) {
      best = [module, dir];
    }
  }
  if (!best) return undefined;
  const rest = path.slice(best[0].length).replace(/^\//, '');
  return [best[1], rest].filter(Boolean).join('/') || '.';
}

function connect(
  index: FileIndex,
  symbols: Map<string, CodeSymbol>,
  edges: Edge[],
  scope: Scope,
  filesOf: Map<string, string[]>,
  methodsByName: Map<string, string[]>,
  sites: DynamicSite[],
): void {
  const own = scope.get(index.pkg)!;
  const file = index.file;
  const edge = (from: string, to: string, node: Node, kind: Edge['kind'] = 'references'): void => {
    if (from !== to) edges.push({ from, to, kind, file, line: node.startPosition.row + 1 });
  };
  /** The package at a directory: its declarations, and the module symbols of its files. */
  const packageAt = (dir: string): { names: Map<string, string[]>; files: string[] } | undefined => {
    for (const [key, names] of scope) {
      if (key.startsWith(`${dir}|`) && !key.endsWith('_test')) return { names, files: filesOf.get(key) ?? [] };
    }
    return undefined;
  };

  // Importing a package loads every file of it.
  for (const dir of new Set(index.imports.values())) {
    for (const target of packageAt(dir)?.files ?? []) edge(moduleId(file), moduleId(target), index.tree, 'imports');
  }
  // A blank import (`import _ "x"`) is covered too: it loads the package for
  // its init() alone, and `_` is simply never referenced.

  const visit = (node: Node, enclosing: string): void => {
    const owner = ownerOf(node, file, symbols) ?? enclosing;

    if (node.type === 'selector_expression' || node.type === 'qualified_type') {
      const left = node.childForFieldName(node.type === 'qualified_type' ? 'package' : 'operand');
      const right = node.childForFieldName(node.type === 'qualified_type' ? 'name' : 'field');
      const dir = left && (left.type === 'identifier' || left.type === 'package_identifier') ? index.imports.get(left.text) : undefined;
      if (dir && right) {
        for (const target of packageAt(dir)?.names.get(right.text) ?? []) {
          edge(owner, target, right, isCall(node) ? 'calls' : 'references');
        }
      } else if (right) {
        for (const id of methodsByName.get(right.text) ?? []) edge(owner, id, right, 'calls');
      }
      if (left) visit(left, owner);
      // `v.MethodByName("Save")` names a method with a string; a computed
      // name is a place the graph cannot follow.
      if (right && right.text === 'MethodByName') {
        const argument = node.parent?.childForFieldName('arguments')?.namedChild(0);
        if (argument && argument.type !== 'interpreted_string_literal') {
          sites.push({ file, line: node.startPosition.row + 1, kind: 'reflection', text: node.parent!.text.slice(0, 120) });
        } else if (argument) {
          const name = argument.text.replace(/^"|"$/g, '');
          for (const id of methodsByName.get(name) ?? []) edge(owner, id, argument, 'calls');
        }
      }
      return;
    }

    if ((node.type === 'identifier' || node.type === 'type_identifier') && !isDeclarationName(node)) {
      for (const target of own.get(node.text) ?? []) edge(owner, target, node, isCall(node) ? 'calls' : 'references');
    }

    for (const child of node.namedChildren) if (child) visit(child, owner);
  };
  visit(index.tree, moduleId(file));
}

/** The symbol a declaration node was recorded as, so references inside it are attributed to it. */
function ownerOf(node: Node, file: string, symbols: Map<string, CodeSymbol>): string | undefined {
  if (node.type === 'function_declaration' || node.type === 'type_spec' || node.type === 'type_alias') {
    const name = node.childForFieldName('name')?.text;
    return name && symbols.has(`${file}#${name}`) ? `${file}#${name}` : undefined;
  }
  if (node.type === 'method_declaration') {
    const name = node.childForFieldName('name')?.text;
    const receiver = receiverType(node);
    return name && receiver ? `${file}#${receiver}.${name}` : undefined;
  }
  if (node.type === 'var_spec' || node.type === 'const_spec') {
    const name = node.childForFieldName('name')?.text;
    return name && symbols.has(`${file}#${name}`) ? `${file}#${name}` : undefined;
  }
  return undefined;
}

function isDeclarationName(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const declares = ['function_declaration', 'type_spec', 'type_alias', 'var_spec', 'const_spec', 'method_declaration'];
  return declares.includes(parent.type) && parent.childForFieldName('name')?.id === node.id;
}

function isCall(node: Node): boolean {
  return node.parent?.type === 'call_expression' && node.parent.childForFieldName('function')?.id === node.id;
}
