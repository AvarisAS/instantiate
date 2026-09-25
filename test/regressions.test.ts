import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { scan } from '../src/api.js';
import { parserFor } from '../src/index/treesitter.js';
import { withoutDirectives } from '../src/index/swift.js';

/**
 * False positives found by running instantiate on a real application, each
 * reduced to its smallest shape.
 */
const here = dirname(fileURLToPath(import.meta.url));
const mixed = await scan({ root: join(here, 'fixtures', 'regressions') });
const swift = await scan({ root: join(here, 'fixtures', 'swift') });
const reported = (result: typeof mixed, name: string): boolean =>
  result.findings.some((f) => f.score >= 0.5 && (f.title.startsWith(`${name} `) || f.title.includes(name)));

test('swift: #if around type members parses once directives are blanked', async () => {
  // Raw, the grammar turns the whole type into a parse error; in a real app that
  // lost every reference inside the type.
  const parser = await parserFor('swift');
  const text = readFileSync(join(here, 'fixtures', 'swift', 'Sources', 'App', 'Settings.swift'), 'utf8');
  assert.equal(parser.parse(text)!.rootNode.hasError, true, 'the grammar fails on the raw file');
  assert.equal(parser.parse(withoutDirectives(text))!.rootNode.hasError, false, 'and parses it prepared');
  assert.equal(withoutDirectives(text).split('\n').length, text.split('\n').length, 'line numbers are kept');
});

test('swift: macros, selectors and availability checks parse', async () => {
  const parser = await parserFor('swift');
  const code = [
    'final class V {',
    '    func a() { let t = T(target: self, action: #selector(tapped(_:))) }',
    '    func b() { if #available(iOS 17, *) { go() } }',
    '    func c(file: StaticString = #filePath) { #expect(file != nil) }',
    '    nonisolated(unsafe) static var shared = 0',
    '}',
  ].join('\n');
  assert.equal(parser.parse(withoutDirectives(code))!.rootNode.hasError, false);
});

test('swift: references inside #if around type members are seen', () => {
  // The grammar cannot parse #if around members; the type became one parse
  // error and its references were attributed to nothing.
  const linked = swift.graph.edges.some(
    (e) => e.from === 'Sources/App/Settings.swift#Settings' && e.to === 'Sources/App/Settings.swift#NavigationPanel',
  );
  assert.ok(linked, 'Settings reaches NavigationPanel');
  assert.ok(!reported(swift, 'NavigationPanel'));
});

test('swift: members of different types sharing a name are not a contradiction', () => {
  assert.ok(!swift.findings.some((f) => f.kind === 'contradiction'));
});

test('python: a module-level call in __init__ runs when the package is used', () => {
  assert.ok(!reported(mixed, '_read_local_env'));
});

test('python: a property read without a call is a use', () => {
  assert.ok(!reported(mixed, 'overall'), 'including after a parenthesised multi-line import');
});

test('cloudflare: wrangler main is an entrypoint', () => {
  assert.ok(!mixed.findings.some((f) => f.kind === 'orphan-file' && f.file.startsWith('worker/')));
  assert.ok(!reported(mixed, 'ENCODING'));
});
