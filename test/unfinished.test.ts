import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const result = await scan({ root: join(here, 'fixtures', 'unfinished') });
const unfinished = result.findings.filter((f) => f.kind === 'unfinished');
const titles = unfinished.map((f) => f.title).sort();

test('state read in a condition and never set is reported', () => {
  assert.ok(titles.includes('searchQuery is read but never set'));
  const finding = unfinished.find((f) => f.title.startsWith('searchQuery'))!;
  assert.equal(finding.file, 'src/index.ts');
  assert.match(finding.detail, /always ''/);
});

test('a private field nothing assigns is reported, one that is assigned is not', () => {
  assert.ok(titles.includes('collapsed is read but never set'));
  assert.ok(!titles.some((t) => t.startsWith('pinned')));
});

test('variables that change, or that nothing branches on, are left alone', () => {
  for (const name of ['factor', 'count', 'left', 'right', 'ready']) {
    assert.ok(!titles.some((t) => t.startsWith(`${name} `)), `${name} should not be reported`);
  }
});

test('stubs are reported, abstract members and overridden hooks are not', () => {
  assert.ok(titles.includes('exportPdf is not implemented'));
  assert.ok(titles.includes('syncToCloud is not implemented'));
  assert.ok(!titles.some((t) => t.startsWith('noop') || t.startsWith('area') || t.startsWith('describe')));
});

test('scripts inside HTML pages are read too', () => {
  const finding = unfinished.find((f) => f.title.startsWith('filterText'));
  assert.ok(finding, 'inline <script> is checked');
  assert.equal(finding.file, 'web/page.html');
  assert.equal(finding.line, 7, 'line numbers are the page, not the script');
});

test('python stubs: raise NotImplementedError and TODO bodies, not abstract or overridden', () => {
  assert.ok(titles.includes('compress is not implemented'));
  assert.ok(titles.includes('migrate is not implemented'));
  assert.ok(!titles.some((t) => /^(save|load|reserved) /.test(t)));
});

test('nothing else is reported', () => {
  assert.deepEqual(titles, [
    'collapsed is read but never set',
    'compress is not implemented',
    'exportPdf is not implemented',
    'filterText is read but never set',
    'migrate is not implemented',
    'searchQuery is read but never set',
    'syncToCloud is not implemented',
  ]);
  assert.equal(result.stats.unfinishedCount, 7);
});
