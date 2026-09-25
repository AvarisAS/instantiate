import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scan } from '../src/api.js';
import { readCoverage } from '../src/analysis/coverage.js';
import { activePlugins, rootingPlugin } from '../src/plugins.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'fixtures', 'dynamic');
const result = await scan({ root });

const dead = result.findings.filter((f) => f.kind === 'dead' || f.kind === 'orphan-file');
const verdictOf = (name: string): string | undefined => {
  const finding = dead.find((f) => f.symbols.some((s) => s.split('#')[1].split('.').pop() === name));
  return finding ? String(finding.evidence?.verdict ?? 'orphan') : undefined;
};

test('a framework plugin turns on only when the project depends on it', () => {
  const names = result.config.plugins.map((p) => p.name);
  assert.ok(names.includes('nestjs'), 'package.json depends on @nestjs/core');
  assert.ok(names.includes('flask'), 'requirements.txt lists flask');
  assert.ok(!names.includes('django'), 'nothing depends on django');
});

test('decorated framework code is alive though nothing names it', () => {
  assert.equal(verdictOf('CatsController'), undefined);
  assert.equal(verdictOf('findAll'), undefined, '@Get() registers the method');
  assert.equal(verdictOf('listCats'), undefined, 'reached through the rooted method');
  assert.equal(verdictOf('health'), undefined, '@app.route registers the view');
});

test('undecorated code beside framework code is still reported', () => {
  assert.equal(verdictOf('forgotten_view'), 'dead');
});

test('a project rule roots a one-off symbol and what it calls', () => {
  assert.equal(verdictOf('loadedByTheOldShell'), undefined);
  assert.equal(verdictOf('helperOnlyTheShellPathUses'), undefined);
});

test('a key typed as a union of literals reaches exactly those members', () => {
  assert.equal(verdictOf('get'), undefined);
  assert.equal(verdictOf('post'), undefined);
  assert.equal(verdictOf('purge'), 'dead', 'not a value the key can take');
});

test('a computed import reaches every file its prefix completes to', () => {
  assert.equal(verdictOf('greetEnglish'), undefined);
  assert.equal(verdictOf('greetNorwegian'), undefined);
});

test('python reflection: literal getattr and prefixed import_module resolve', () => {
  assert.equal(verdictOf('refresh'), undefined, 'getattr(obj, "refresh")');
  assert.equal(verdictOf('export_csv'), undefined, 'import_module(f"app.plugins.{name}")');
  assert.equal(verdictOf('unused_task'), 'dead');
});

test('a name written in a data file is a question, not a verdict', () => {
  const finding = dead.find((f) => f.title.startsWith('NightlyInvoiceJob'));
  assert.ok(finding, 'still shown');
  assert.equal(finding.evidence?.verdict, 'unknown');
  assert.equal(finding.evidence?.nameAppearsIn, 'jobs.yml');
  assert.ok(finding.score < 0.5, 'kept out of the headline number');
  // Its members go wherever the class goes, and the file is not rolled up
  // into a confident "delete this file".
  assert.equal(verdictOf('run'), 'unknown');
  assert.ok(!dead.some((f) => f.kind === 'orphan-file' && f.file === 'src/jobs.ts'));
});

test('what cannot be followed is listed, not silently hedged', () => {
  const places = result.graph.dynamicSites.map((s) => `${s.file}:${s.kind}`);
  assert.ok(places.includes('src/handlers.ts:member'), 'handlers[kind]()');
  assert.ok(places.includes('app/web.py:reflection'), 'getattr(plugin, name)');
  assert.ok(result.warnings.some((w) => w.includes('computed at run time')));
});

test('plugin names match functions and methods, never variables', () => {
  const [react] = activePlugins(root, [{ name: 'react', names: ['render'] }]).filter((p) => p.name === 'react');
  const symbol = { id: 'a.ts#render', name: 'render', file: 'a.ts', line: 1, endLine: 1, exported: false, loc: 1, body: '', signature: '' };
  assert.ok(rootingPlugin({ ...symbol, kind: 'function' }, [react]));
  assert.equal(rootingPlugin({ ...symbol, kind: 'variable' }, [react]), undefined);
});

test('a raw V8 trace from a real run counts as coverage', async () => {
  // A production trace is the same idea as test coverage with better data:
  // whatever users exercised is alive, including paths no test tried.
  const project = mkdtempSync(join(tmpdir(), 'instantiate-v8-'));
  writeFileSync(join(project, 'package.json'), '{ "name": "v8", "private": true }\n');
  writeFileSync(join(project, '.instantiate.yml'), 'entrypoints: ["main.js"]\n');
  writeFileSync(
    join(project, 'lib.js'),
    [
      'function used() {',
      "  return 'ran';",
      '}',
      'function unused() {',
      "  return 'never';",
      '}',
      'module.exports = { used };',
      '',
    ].join('\n'),
  );
  writeFileSync(join(project, 'main.js'), "const lib = require('./lib.js');\nlib[process.argv[2]]();\n");
  const traces = join(project, 'traces');
  execFileSync(process.execPath, ['main.js', 'used'], { cwd: project, env: { ...process.env, NODE_V8_COVERAGE: traces } });

  const coverage = readCoverage(project, traces);
  assert.equal(coverage.format, 'v8');
  assert.ok(coverage.executed.get('lib.js')?.has(2), 'the body of used() ran');
  assert.ok(!coverage.executed.get('lib.js')?.has(5), 'the body of unused() did not');

  const traced = await scan({ root: project, coverage });
  const names = traced.findings.filter((f) => f.kind === 'dead').map((f) => f.title);
  assert.ok(!names.some((t) => t.startsWith('used ')), 'used() ran in the trace');
  const unused = traced.findings.find((f) => f.title.startsWith('unused '));
  assert.ok(unused && unused.score > 0.9, 'unused() was watched and never ran');
});
