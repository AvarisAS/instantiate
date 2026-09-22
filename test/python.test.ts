import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const result = await scan({ root: join(here, 'fixtures', 'python') });

const deadNames = result.findings
  .filter((f) => f.kind === 'dead')
  .map((f) => f.symbols[0].split('#')[1].split('.').pop()!);

test('python files are indexed', () => {
  assert.ok(result.stats.files >= 3, `indexed ${result.stats.files} files`);
  assert.ok([...result.graph.symbols.values()].some((s) => s.file.endsWith('.py')));
});

test('a __main__ guard makes a file an entrypoint', () => {
  // Python has no manifest saying which file is run; the guard is the signal.
  assert.ok(!deadNames.includes('run'), 'run() is called under the __main__ guard');
});

test('imports resolve across modules', () => {
  assert.ok(!deadNames.includes('format_duration'), 'imported with `from .util import`');
});

test('self.method() resolves within its class', () => {
  assert.ok(!deadNames.includes('_decorate'), 'called as self._decorate()');
});

test('obj.method() resolves by name, since there is no type information', () => {
  assert.ok(!deadNames.includes('report'), 'called as reporter.report()');
});

test('genuinely unused python code is reported', () => {
  for (const expected of ['pretty_time', 'never_called_anywhere', 'unused_method']) {
    assert.ok(deadNames.includes(expected), `expected ${expected} to be reported dead`);
  }
});

test('duplicates are found across snake_case names', () => {
  const cluster = result.findings.find((f) => f.kind === 'duplicate');
  assert.ok(cluster, 'expected format_duration and pretty_time to cluster');
  const names = cluster.symbols.map((s) => s.split('#')[1]);
  assert.ok(names.includes('format_duration') && names.includes('pretty_time'));
});

test('a repository with no python pays no cost for the grammar', async () => {
  // Loading a wasm grammar is not free, so it must not happen speculatively.
  const started = Date.now();
  await scan({ root: join(here, 'fixtures', 'messy') });
  assert.ok(Date.now() - started < 5000, 'a TypeScript-only scan should not load the python grammar');
});
