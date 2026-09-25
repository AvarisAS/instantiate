import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeGraph, CodeSymbol, Finding } from '../types.js';
import type { Config } from '../config.js';
import { discoverFiles } from '../index/extract.js';
import { relPath } from '../config.js';

/**
 * Work that was started and not finished.
 *
 * Nothing here is unreachable or duplicated, so the other analyses pass it:
 * the code is called and it runs. It just does not do anything yet. Two
 * shapes are reliable enough to report:
 *
 * - **State nothing sets.** A `let` or private field that is read in a
 *   condition and never assigned. Every branch on it always goes the same
 *   way, so whatever was meant to change it — an input handler, a setter —
 *   is missing. This is how a search box that filtered nothing shipped: its
 *   listener had been deleted, and `query` stayed `''` forever.
 * - **Stubs.** A body that only says it is not implemented. Abstract methods
 *   and base-class hooks that something overrides are left alone; those are
 *   meant to be empty.
 *
 * Both are read from the syntax of one file at a time, which is also what
 * lets this run on scripts embedded in HTML that no indexer ever sees.
 */
export interface UnfinishedResult {
  findings: Finding[];
  count: number;
}

interface Site {
  file: string;
  line: number;
  name: string;
  kind: 'unset' | 'stub';
  /** Lines where the unset value is read, or the stub's size. */
  loc: number;
  detail: string;
  reads?: number[];
}

/** An inline script in an HTML page: code no indexer reads. */
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

export function findUnfinished(graph: CodeGraph, config: Config): UnfinishedResult {
  const overridden = namesDefinedTwice(graph);
  const sites: Site[] = [];

  for (const file of graph.files.keys()) {
    let text: string;
    try {
      text = readFileSync(join(config.root, file), 'utf8');
    } catch {
      continue;
    }
    if (file.endsWith('.py')) {
      sites.push(...pythonStubs(graph, file, text, overridden));
    } else if (/\.(go|swift)$/.test(file)) {
      sites.push(...braceStubs(graph, file, text, overridden));
    } else if (/\.[cm]?[jt]sx?$/.test(file)) {
      sites.push(...scriptSites(file, text, 0, overridden));
    }
  }

  for (const absolute of discoverFiles(config, ['**/*.html', '**/*.htm'])) {
    const file = relPath(config.root, absolute);
    let html: string;
    try {
      html = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    for (const match of html.matchAll(SCRIPT_TAG)) {
      const attributes = match[1];
      // External scripts have no body, and JSON or template blocks are data.
      if (/\bsrc\s*=/.test(attributes)) continue;
      if (/\btype\s*=\s*["']?(?!(text\/javascript|module|application\/javascript)["'\s>])/i.test(attributes)) continue;
      const offset = html.slice(0, match.index! + match[0].indexOf('>') + 1).split('\n').length - 1;
      sites.push(...scriptSites(file, match[2], offset, overridden));
    }
  }

  const findings = sites.map(toFinding);
  return { findings, count: findings.filter((f) => f.score >= 0.5).length };
}

/** Method names defined in more than one place: overridable hooks, not stubs. */
function namesDefinedTwice(graph: CodeGraph): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const symbol of graph.symbols.values()) {
    if (symbol.kind !== 'method') continue;
    if (seen.has(symbol.name)) twice.add(symbol.name);
    seen.add(symbol.name);
  }
  return twice;
}

function scriptSites(file: string, text: string, lineOffset: number, overridden: Set<string>): Site[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + lineOffset;
  const sites: Site[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.Const) && !isLoopHead(node)) {
      for (const declaration of node.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const unset = unsetVariable(declaration, declaration.name.text, sf, lineOf);
        if (unset) sites.push({ ...unset, file });
      }
    }

    if (ts.isPropertyDeclaration(node) && isPrivateMutable(node) && !node.questionToken) {
      const name = node.name.getText(sf);
      const unset = unsetField(node, name, sf, lineOf);
      if (unset) sites.push({ ...unset, file });
    }

    if (isFunctionWithBody(node)) {
      const stub = stubOf(node, sf, overridden);
      if (stub) {
        const start = lineOf(node);
        const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1 + lineOffset;
        sites.push({ file, line: start, name: stub.name, kind: 'stub', loc: end - start + 1, detail: stub.detail });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function isLoopHead(list: ts.VariableDeclarationList): boolean {
  const parent = list.parent;
  return ts.isForStatement(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent);
}

/**
 * A variable read in a condition and assigned nowhere in its scope.
 *
 * Reads outside conditions are not enough: `let x = 5; return x * 2` is a
 * missing `const`, not missing work. It is the branch that gives it away —
 * code written to react to a change that never comes.
 */
function unsetVariable(
  declaration: ts.VariableDeclaration,
  name: string,
  sf: ts.SourceFile,
  lineOf: (node: ts.Node) => number,
): Omit<Site, 'file'> | undefined {
  // `let x!: T` promises an assignment the checker cannot see; take it at its word.
  if (declaration.exclamationToken) return undefined;
  const scope = scopeOf(declaration);
  let writes = 0;
  const conditions: number[] = [];
  let reads = 0;

  const scan = (node: ts.Node): void => {
    // A nested function with its own `name` is talking about something else.
    if (node !== scope && ts.isFunctionLike(node) && declaresOwn(node, name, declaration)) return;
    if (ts.isIdentifier(node) && node.text === name && node !== declaration.name && !isPropertyName(node)) {
      if (isWrite(node)) writes++;
      else {
        reads++;
        if (inCondition(node)) conditions.push(lineOf(node));
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(scope);

  if (writes > 0 || reads === 0) return undefined;
  // Declared with no value and read anyway: it is always `undefined`.
  const neverGiven = !declaration.initializer;
  if (conditions.length === 0 && !neverGiven) return undefined;

  const initial = declaration.initializer ? declaration.initializer.getText(sf).slice(0, 40) : 'undefined';
  return {
    line: lineOf(declaration),
    name,
    kind: 'unset',
    loc: Math.max(conditions.length, 1),
    reads: conditions,
    detail:
      `\`${name}\` is declared to change (\`let\`) and nothing ever assigns it, so it is always ${initial}. ` +
      (conditions.length
        ? `${conditions.length === 1 ? 'The condition' : `All ${conditions.length} conditions`} reading it ` +
          `(line${conditions.length === 1 ? '' : 's'} ${conditions.join(', ')}) always go the same way.`
        : 'Every read of it gets the same value.'),
  };
}

/** A private, writable class field: only this file can assign it, so absent writes are conclusive. */
function isPrivateMutable(node: ts.PropertyDeclaration): boolean {
  const modifiers = ts.getModifiers(node) ?? [];
  if (modifiers.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword || m.kind === ts.SyntaxKind.DeclareKeyword)) {
    return false;
  }
  return ts.isPrivateIdentifier(node.name) || modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
}

function unsetField(
  field: ts.PropertyDeclaration,
  name: string,
  sf: ts.SourceFile,
  lineOf: (node: ts.Node) => number,
): Omit<Site, 'file'> | undefined {
  const owner = field.parent;
  let writes = 0;
  let reads = 0;
  const conditions: number[] = [];

  const scan = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.getText(sf) === name) {
      if (isWrite(node)) writes++;
      else {
        reads++;
        if (inCondition(node)) conditions.push(lineOf(node));
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(owner);

  if (writes > 0 || conditions.length === 0) return undefined;
  const initial = field.initializer ? field.initializer.getText(sf).slice(0, 40) : 'undefined';
  return {
    line: lineOf(field),
    name,
    kind: 'unset',
    loc: conditions.length,
    reads: conditions,
    detail:
      `\`${name}\` is a private, writable field that nothing assigns, so it is always ${initial}. ` +
      `The condition${conditions.length === 1 ? '' : 's'} reading it (line${conditions.length === 1 ? '' : 's'} ` +
      `${conditions.join(', ')}) always go the same way.`,
  };
}

/** Whether a function binds `name` itself, as a parameter or a local, shadowing the outer one. */
function declaresOwn(fn: ts.SignatureDeclaration, name: string, outer: ts.VariableDeclaration): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) &&
      node !== outer &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = true;
      return;
    }
    // Deeper functions shadow only their own bodies, and are checked when reached.
    if (node !== fn && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return found;
}

/** `let` is block-scoped and `var` function-scoped; the enclosing function covers both, erring towards finding writes. */
function scopeOf(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isSourceFile(current) || ts.isFunctionLike(current) || ts.isModuleBlock(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node)
  );
}

const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken,
]);

/** Assigned, incremented, destructured into, or the target of a `for…of`. */
function isWrite(node: ts.Expression): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  // Climb out of destructuring patterns: `[a, b] = pair`, `({ a } = obj)`.
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === child) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent)
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (ts.isBinaryExpression(parent) && parent.left === child && ASSIGNMENTS.has(parent.operatorToken.kind)) return true;
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === child) return true;
  return false;
}

/** Whether a read decides which way the code goes. */
function inCondition(node: ts.Node): boolean {
  let child = node;
  let parent = node.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    (ts.isPropertyAccessExpression(parent) && parent.expression === child) ||
    (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isBinaryExpression(parent) && isTest(parent.operatorToken.kind))
  ) {
    child = parent;
    parent = parent.parent;
  }
  return (
    (ts.isIfStatement(parent) && parent.expression === child) ||
    (ts.isWhileStatement(parent) && parent.expression === child) ||
    (ts.isDoStatement(parent) && parent.expression === child) ||
    (ts.isForStatement(parent) && parent.condition === child) ||
    (ts.isConditionalExpression(parent) && parent.condition === child) ||
    (ts.isSwitchStatement(parent) && parent.expression === child) ||
    // `query && render()` decides as surely as an `if`.
    (ts.isBinaryExpression(parent) &&
      parent.left === child &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken))
  );
}

function isTest(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken ||
    kind === ts.SyntaxKind.LessThanToken ||
    kind === ts.SyntaxKind.GreaterThanToken ||
    kind === ts.SyntaxKind.LessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanEqualsToken
  );
}

type FunctionWithBody = ts.FunctionLikeDeclaration & { body: ts.Block };

function isFunctionWithBody(node: ts.Node): node is FunctionWithBody {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    !!node.body &&
    ts.isBlock(node.body)
  );
}

const NOT_DONE = /\b(not\s+(yet\s+)?implemented|unimplemented|todo|tbd|fixme|stub)\b/i;
const MARKER = /\b(TODO|FIXME|XXX|HACK)\b/;

/**
 * A body that is nothing but a refusal: `throw new Error('not implemented')`,
 * or empty apart from a TODO. An empty body with no marker is left alone —
 * no-op callbacks are everywhere and deliberate.
 */
function stubOf(
  node: FunctionWithBody,
  sf: ts.SourceFile,
  overridden: Set<string>,
): { name: string; detail: string } | undefined {
  const name = functionName(node, sf);
  if (!name) return undefined;
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  if (modifiers.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)) return undefined;
  // A hook subclasses fill in is empty on purpose.
  if (ts.isMethodDeclaration(node) && overridden.has(name)) return undefined;

  const statements = node.body.statements;
  if (statements.length === 1 && ts.isThrowStatement(statements[0])) {
    const thrown = statements[0].expression?.getText(sf) ?? '';
    if (NOT_DONE.test(thrown) || /NotImplemented/.test(thrown)) {
      return { name, detail: `\`${name}\` only throws: ${thrown.slice(0, 80)}. Anything that calls it fails.` };
    }
  }
  if (statements.length === 0) {
    const inside = node.body.getFullText(sf);
    const marker = MARKER.exec(inside);
    if (marker) {
      const note = inside.slice(marker.index).split('\n')[0].replace(/\*\/.*/, '').trim();
      return { name, detail: `\`${name}\` has an empty body with a note left in it: "${note.slice(0, 80)}".` };
    }
  }
  return undefined;
}

function functionName(node: FunctionWithBody, sf: ts.SourceFile): string | undefined {
  if (node.name) return node.name.getText(sf);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.name.getText(sf);
  }
  return undefined;
}

/**
 * Python stubs: `raise NotImplementedError`, or `pass` / `...` beside a TODO.
 * Read from the raw lines, since the indexed body has its comments removed.
 */
function pythonStubs(graph: CodeGraph, file: string, text: string, overridden: Set<string>): Site[] {
  const lines = text.split('\n');
  const sites: Site[] = [];
  for (const symbol of graph.symbols.values()) {
    if (symbol.file !== file || (symbol.kind !== 'function' && symbol.kind !== 'method')) continue;
    if (symbol.kind === 'method' && overridden.has(symbol.name)) continue;
    if (symbol.decorators?.some((d) => /abstract/.test(d))) continue;
    const body = bodyLines(lines, symbol);
    const code = body.filter((l) => l && !l.startsWith('#'));
    if (code.length === 1 && /^raise\s+NotImplemented(Error)?\b/.test(code[0])) {
      sites.push(stubSite(symbol, `\`${symbol.name}\` only raises ${code[0]}. Anything that calls it fails.`));
    } else if (code.length === 1 && /^(pass|\.\.\.)$/.test(code[0]) && body.some((l) => MARKER.test(l))) {
      const note = body.find((l) => MARKER.test(l))!;
      sites.push(stubSite(symbol, `\`${symbol.name}\` does nothing and carries a note: "${note.slice(0, 80)}".`));
    }
  }
  return sites;
}

/** A body that only refuses: Go's `panic("not implemented")`, Swift's `fatalError("TODO")`. */
const REFUSAL = /^(panic|fatalError|preconditionFailure)\(\s*"[^"]*\b(not\s+(yet\s+)?implemented|unimplemented|todo|tbd|stub)\b[^"]*"\s*\)$/i;

/**
 * Go and Swift stubs, read from the raw lines between the braces: the same two
 * shapes as elsewhere, a refusal or an empty body holding a TODO.
 */
function braceStubs(graph: CodeGraph, file: string, text: string, overridden: Set<string>): Site[] {
  const lines = text.split('\n');
  const sites: Site[] = [];
  for (const symbol of graph.symbols.values()) {
    if (symbol.file !== file || (symbol.kind !== 'function' && symbol.kind !== 'method')) continue;
    if (symbol.kind === 'method' && overridden.has(symbol.name)) continue;
    const raw = lines.slice(symbol.line - 1, symbol.endLine).join('\n');
    const open = raw.indexOf('{');
    const close = raw.lastIndexOf('}');
    if (open === -1 || close <= open) continue;
    const body = raw.slice(open + 1, close).split('\n').map((l) => l.trim()).filter(Boolean);
    const code = body.filter((l) => !l.startsWith('//'));
    if (code.length === 1 && REFUSAL.test(code[0])) {
      sites.push(stubSite(symbol, `\`${symbol.name}\` only calls ${code[0]}. Anything that calls it stops there.`));
    } else if (code.length === 0 && body.some((l) => MARKER.test(l))) {
      const note = body.find((l) => MARKER.test(l))!.replace(/^\/\/\s*/, '');
      sites.push(stubSite(symbol, `\`${symbol.name}\` has an empty body with a note left in it: "${note.slice(0, 80)}".`));
    }
  }
  return sites;
}

/** The statements after the `def` line, trimmed, with a leading docstring removed. */
function bodyLines(lines: string[], symbol: CodeSymbol): string[] {
  const raw = lines.slice(symbol.line - 1, symbol.endLine).join('\n');
  const afterSignature = raw.replace(/^[\s\S]*?\)\s*(->[^:]*)?:/, '');
  return afterSignature
    .replace(/^\s*("""[\s\S]*?"""|'''[\s\S]*?''')/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function stubSite(symbol: CodeSymbol, detail: string): Site {
  return { file: symbol.file, line: symbol.line, name: symbol.name, kind: 'stub', loc: symbol.loc, detail };
}

function toFinding(site: Site): Finding {
  if (site.kind === 'unset') {
    return {
      id: `unfinished:${site.file}#${site.name}@unset`,
      kind: 'unfinished',
      severity: 'medium',
      title: `${site.name} is read but never set`,
      detail: site.detail,
      action: `Find what was meant to set ${site.name} (an input handler, a setter, a callback) and wire it up, or make it a constant if it should never change.`,
      file: site.file,
      line: site.line,
      symbols: [],
      loc: site.loc,
      score: 0.85,
      evidence: { reads: site.reads ?? [] },
    };
  }
  return {
    id: `unfinished:${site.file}#${site.name}@stub`,
    kind: 'unfinished',
    severity: 'medium',
    title: `${site.name} is not implemented`,
    detail: site.detail,
    action: `Implement ${site.name}, or remove it and whatever calls it.`,
    file: site.file,
    line: site.line,
    symbols: [],
    loc: site.loc,
    score: 0.9,
  };
}
