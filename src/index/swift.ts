import type { Node } from 'web-tree-sitter';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import type { CodeSymbol, DynamicSite, Edge, FileRecord, SymbolKind } from '../types.js';
import { record as recordSymbol, recordModule, moduleId } from './symbol.js';
import type { Config } from '../config.js';
import { parserFor, type Backend, type LanguageGraph } from './treesitter.js';

/**
 * Swift, through tree-sitter.
 *
 * Swift files in a target share one namespace with no imports between them,
 * so names resolve across every Swift file in the repository. As with Python,
 * `x.method()` reaches every method of that name, since there is no type
 * checker to say which.
 *
 * The hard part is what the frameworks call: UIKit calls `viewDidLoad`,
 * SwiftUI reads `body`, Codable calls `encode(to:)`. None of that is named in
 * the source. So a type that conforms to anything — a protocol, a superclass —
 * brings all its non-private members with it, `override` members are always
 * reached, and `@objc`, `@IBAction` and friends are roots via the Swift plugin.
 * It over-approximates on purpose: a false "alive" costs a missed finding, a
 * false "dead" on `viewDidLoad` costs every other finding its credibility.
 */
export const swift: Backend = {
  name: 'swift',
  globs: (config) => config.swift,
  build: buildSwiftGraph,
};

/**
 * What well-known protocols require, so conforming to one keeps only those
 * members rather than everything. A superclass or protocol not listed here,
 * and not declared in this repository, keeps every non-private member: its
 * requirements are unknown, and UIKit alone calls hundreds of methods by name.
 */
/**
 * Types the system finds by themselves: nothing constructs an App Intent, a
 * widget or a preview; the OS enumerates them from build metadata.
 */
const DISCOVERED = new Set([
  'AppIntent', 'AppShortcutsProvider', 'AppEntity', 'AppEnum', 'EntityQuery', 'Widget', 'WidgetBundle',
  'TimelineProvider', 'IntentTimelineProvider', 'AppIntentTimelineProvider', 'ControlWidget',
  'PreviewProvider', 'XCTestCase', 'NSExtensionRequestHandling', 'Tip',
]);

const KNOWN_REQUIREMENTS: Record<string, string[]> = {
  Equatable: ['=='],
  Hashable: ['hash', '=='],
  Comparable: ['<', '=='],
  Identifiable: ['id'],
  CustomStringConvertible: ['description'],
  CustomDebugStringConvertible: ['debugDescription'],
  LocalizedError: ['errorDescription', 'failureReason', 'recoverySuggestion', 'helpAnchor'],
  Error: [],
  Sendable: [],
  Codable: ['encode', 'init'],
  Encodable: ['encode'],
  Decodable: ['init'],
  Sequence: ['makeIterator'],
  IteratorProtocol: ['next'],
  Collection: ['startIndex', 'endIndex', 'index', 'subscript'],
  CaseIterable: ['allCases'],
  RawRepresentable: ['rawValue', 'init'],
  ExpressibleByStringLiteral: ['init'],
  ExpressibleByIntegerLiteral: ['init'],
  View: ['body'],
  App: ['body'],
  Scene: ['body'],
  ObservableObject: [],
};

async function buildSwiftGraph(config: Config, files: string[]): Promise<LanguageGraph> {
  const parser = await parserFor('swift');
  const symbols = new Map<string, CodeSymbol>();
  const edges: Edge[] = [];
  const records = new Map<string, FileRecord>();
  const sources = new Map<string, string>();
  const dynamicSites: DynamicSite[] = [];

  /** Top-level name -> ids: types, functions, globals. */
  const names = new Map<string, string[]>();
  /** Member name -> ids, for `x.member` and implicit-self calls. */
  const members = new Map<string, string[]>();
  /** Type name -> its member ids, gathered across the type and all its extensions. */
  const typeMembers = new Map<string, Array<{ id: string; name: string; isPrivate: boolean; override: boolean }>>();
  /** Type name -> what it conforms to or inherits from, across its declaration and extensions. */
  const conformances = new Map<string, Set<string>>();
  /** Member names some protocol in this repository requires. */
  const required = new Set<string>();
  /** Declaration node id -> symbol id, to attribute references to their owner. */
  const owners = new Map<number, string>();
  const trees: Array<{ file: string; root: Node }> = [];
  const roots: string[] = [];

  const add = (map: Map<string, string[]>, key: string, id: string): void => {
    const list = map.get(key) ?? [];
    if (!list.includes(id)) list.push(id);
    map.set(key, list);
  };

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
    records.set(file, {
      path: file,
      loc: text.split('\n').length,
      hash: createHash('sha1').update(text).digest('hex').slice(0, 16),
      indexedAt: Date.now(),
    });
    sources.set(file, stripComments(text));
    recordModule(symbols, file, text.split('\n').length);
    trees.push({ file, root: tree.rootNode });

    const declareType = (node: Node, outer?: string): void => {
      const nameNode = node.childForFieldName('name');
      // `extension Store` names its type through a user_type.
      const name = nameNode?.type === 'user_type' ? nameNode.text : nameNode?.text;
      if (!name) return;
      const isExtension = nameNode?.type === 'user_type';
      const qualified = outer ? `${outer}.${name}` : name;
      const kind: SymbolKind = node.type === 'protocol_declaration' ? 'interface' : 'class';

      if (!isExtension) {
        const id = record(node, qualified, kind, file, symbols);
        owners.set(node.id, id);
        add(names, name, id);
      }
      for (const spec of node.namedChildren) {
        if (spec?.type !== 'inheritance_specifier') continue;
        const set = conformances.get(name) ?? new Set<string>();
        set.add(spec.text.replace(/<.*$/, '').trim());
        conformances.set(name, set);
      }

      const body = node.childForFieldName('body');
      for (const member of body?.namedChildren ?? []) {
        if (!member) continue;
        if (member.type === 'class_declaration' || member.type === 'protocol_declaration') {
          declareType(member, qualified);
          continue;
        }
        if (member.type === 'protocol_function_declaration') {
          const required_ = member.childForFieldName('name')?.text;
          if (required_) required.add(required_);
          continue;
        }
        const memberName =
          member.type === 'init_declaration'
            ? 'init'
            : member.type === 'function_declaration'
              ? member.childForFieldName('name')?.text
              : undefined;
        if (!memberName) continue;
        const id = record(member, memberName, 'method', file, symbols, qualified);
        owners.set(member.id, id);
        // `static func ==` is used through the operator, never by its name.
        if (!/^[A-Za-z_]/.test(memberName)) roots.push(id);
        add(members, memberName, id);
        const modifiers = modifierText(member);
        const list = typeMembers.get(name) ?? [];
        list.push({
          id,
          name: memberName,
          isPrivate: /\b(private|fileprivate)\b/.test(modifiers),
          override: /\boverride\b/.test(modifiers),
        });
        typeMembers.set(name, list);
      }
    };

    for (const node of tree.rootNode.namedChildren) {
      if (!node) continue;
      if (node.type === 'class_declaration' || node.type === 'protocol_declaration') {
        declareType(node);
      } else if (node.type === 'function_declaration') {
        const name = node.childForFieldName('name')?.text;
        if (!name) continue;
        const id = record(node, name, 'function', file, symbols);
        owners.set(node.id, id);
        if (!/^[A-Za-z_]/.test(name)) roots.push(id);
        add(names, name, id);
      } else if (node.type === 'property_declaration') {
        const name = node.childForFieldName('name')?.text;
        // `let (a, b) = pair` binds a tuple; it is not one name.
        if (!name || !/^[A-Za-z_]\w*$/.test(name)) continue;
        const id = record(node, name, 'variable', file, symbols);
        owners.set(node.id, id);
        add(names, name, id);
      } else if (node.type === 'typealias_declaration') {
        const name = node.childForFieldName('name')?.text;
        if (!name) continue;
        const id = record(node, name, 'type', file, symbols);
        owners.set(node.id, id);
        add(names, name, id);
      }
    }
  }

  // A type brings the members it is obliged to have: initialisers always,
  // overrides always, and everything non-private once it conforms to
  // something, because a framework may call any of it by its protocol.
  for (const [typeName, list] of typeMembers) {
    const parents = [...(conformances.get(typeName) ?? [])];
    // A parent declared here has its requirements in `required`; a known one
    // has them in the table; anything else is taken on trust.
    const unknownParent = parents.some((p) => !names.has(p) && !(p in KNOWN_REQUIREMENTS));
    const known = new Set(parents.flatMap((p) => KNOWN_REQUIREMENTS[p] ?? []));
    for (const typeId of names.get(typeName) ?? []) {
      const owner = symbols.get(typeId)!;
      for (const member of list) {
        const obliged =
          member.name === 'init' ||
          member.override ||
          required.has(member.name) ||
          known.has(member.name) ||
          (unknownParent && !member.isPrivate);
        if (obliged) edges.push({ from: typeId, to: member.id, kind: 'calls', file: owner.file, line: owner.line });
      }
    }
  }

  for (const { file, root } of trees) {
    const visit = (node: Node, owner: string): void => {
      const here = owners.get(node.id) ?? owner;
      if ((node.type === 'simple_identifier' || node.type === 'type_identifier') && !isDeclarationName(node)) {
        const targets = [...(names.get(node.text) ?? []), ...(members.get(node.text) ?? [])];
        const call = node.parent?.type === 'call_expression' || node.parent?.parent?.parent?.type === 'call_expression';
        for (const target of targets) {
          if (target !== here) {
            edges.push({ from: here, to: target, kind: call ? 'calls' : 'references', file, line: node.startPosition.row + 1 });
          }
        }
      }
      // `perform(NSSelectorFromString(name))` and `value(forKey:)` look members up by string.
      if (node.type === 'call_expression' && /^(NSSelectorFromString|NSClassFromString)\b|\.value\(forKey/.test(node.text)) {
        const literal = /"([A-Za-z_]\w*)[:"]/.exec(node.text)?.[1];
        if (literal) {
          for (const target of members.get(literal) ?? []) {
            edges.push({ from: here, to: target, kind: 'calls', file, line: node.startPosition.row + 1 });
          }
        } else {
          dynamicSites.push({ file, line: node.startPosition.row + 1, kind: 'reflection', text: node.text.slice(0, 120) });
        }
      }
      for (const child of node.namedChildren) if (child) visit(child, here);
    };
    visit(root, moduleId(file));
  }

  for (const [typeName, parents] of conformances) {
    if (![...parents].some((p) => DISCOVERED.has(p))) continue;
    for (const typeId of names.get(typeName) ?? []) roots.push(typeId);
  }

  // `public` and `open` are the contract of a library target.
  return { symbols, edges, files: records, sources, scripts: [], dynamicSites, publicApi: [...records.keys()], roots };
}

function modifierText(node: Node): string {
  return node.namedChildren.find((c) => c?.type === 'modifiers')?.text ?? '';
}

function attributes(node: Node): string[] | undefined {
  const modifiers = node.namedChildren.find((c) => c?.type === 'modifiers');
  const out = (modifiers?.namedChildren ?? [])
    .filter((c) => c?.type === 'attribute')
    .map((c) => c!.text.replace(/^@/, '').split('(')[0].trim());
  return out.length ? out : undefined;
}

function isExported(node: Node): boolean {
  return /\b(public|open)\b/.test(modifierText(node));
}

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
      exported: isExported(node),
      decorators: attributes(node),
      body: stripComments(node.text).replace(/\s+/g, ' ').trim(),
      signature: `${kind}:${node.namedChildren.filter((c) => c?.type === 'parameter').length}`,
    },
    container,
  );
}

/** The identifier a declaration introduces, or a label, rather than a use of a name. */
function isDeclarationName(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'pattern' || parent.type === 'value_argument_label') return true;
  if (parent.type === 'parameter') return true;
  const declaring = ['function_declaration', 'class_declaration', 'protocol_declaration', 'typealias_declaration', 'protocol_function_declaration'];
  if (declaring.includes(parent.type) && parent.childForFieldName('name')?.id === node.id) return true;
  // The type named by `extension Store` is a use, but it is also how members
  // reach their type, so it is not counted as a reference from the file.
  if (parent.type === 'user_type' && parent.parent?.type === 'class_declaration' && parent.parent.childForFieldName('name')?.id === parent.id) {
    return true;
  }
  return false;
}

/** Line-preserving: comments become blanks, so line numbers still match the file. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}
