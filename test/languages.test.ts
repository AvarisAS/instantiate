import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const go = await scan({ root: join(here, 'fixtures', 'golang') });
const swift = await scan({ root: join(here, 'fixtures', 'swift') });

const deadIn = (result: typeof go): string[] =>
  result.findings
    .filter((f) => (f.kind === 'dead' || f.kind === 'orphan-file') && f.score >= 0.5)
    .map((f) => f.title.split(' ')[0])
    .sort();

test('go: exactly the unused code is reported', () => {
  assert.deepEqual(deadIn(go), ['forgotten', 'notImplemented', 'retry', 'unusedInMain']);
});

test('go: packages, files and methods resolve the way the compiler does', () => {
  const alive = (name: string): boolean => !deadIn(go).includes(name);
  assert.ok(alive('describe'), 'same package, different file');
  assert.ok(alive('Name'), 'method in a different file from its type');
  assert.ok(alive('normalise'), 'called on a receiver');
  assert.ok(alive('String'), 'satisfies fmt.Stringer implicitly');
  assert.ok(alive('flush'), 'required by an interface in this repository');
  assert.ok(alive('exportCSV'), 'reached from init(), which a blank import runs');
  assert.ok(alive('Get'), 'exported from a public package');
});

test('go: stubs are unfinished', () => {
  assert.ok(go.findings.some((f) => f.kind === 'unfinished' && f.title === 'notImplemented is not implemented'));
});

test('swift: exactly the unused code is reported', () => {
  assert.deepEqual(deadIn(swift), [
    'Screen', 'configure', 'debugLabel', 'exportPDF', 'leftover', 'purge', 'viewDidLoad', 'whisper',
  ]);
});

test('swift: framework and protocol obligations are honoured', () => {
  const alive = (name: string): boolean => !deadIn(swift).includes(name);
  assert.ok(alive('App') && alive('main'), '@main');
  assert.ok(alive('normalise'), 'implicit self call');
  assert.ok(alive('description'), 'CustomStringConvertible requires it');
  assert.ok(alive('shout'), 'static call through the type');
  assert.ok(alive('StoreTests'), 'test targets are entrypoints');
});

test('swift: fatalError("not implemented") is unfinished', () => {
  assert.ok(swift.findings.some((f) => f.kind === 'unfinished' && f.title === 'exportPDF is not implemented'));
});
