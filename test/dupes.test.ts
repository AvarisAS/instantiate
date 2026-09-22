import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/api.js';

const here = dirname(fileURLToPath(import.meta.url));

const parallel = scan({ root: join(here, 'fixtures', 'parallel') });
const messy = scan({ root: join(here, 'fixtures', 'messy') });

test('one implementation per file is a parallel set, not redundancy', () => {
  // zod's sixty translations were reported as "60 implementations of the same
  // thing" at 98% confidence. Identical structure is the point of a locale file.
  const clusters = parallel.findings.filter((f) => f.kind === 'duplicate');
  assert.equal(clusters.length, 1, 'expected the translations to form one cluster');

  const cluster = clusters[0];
  assert.ok(cluster.score < 0.5, `expected low confidence, got ${cluster.score}`);
  assert.equal(cluster.severity, 'low');
  assert.match(cluster.title, /parallel implementations/);
});

test('a parallel set does not count towards the headline number', () => {
  // The headline drives the CI budget, so it must not be inflated by a finding
  // the analysis does not itself stand behind.
  assert.equal(parallel.stats.duplicateLoc, 0);
});

test('a title never lists more than a few names', () => {
  for (const finding of [...parallel.findings, ...messy.findings]) {
    assert.ok(finding.title.length < 140, `title too long: ${finding.title.slice(0, 80)}…`);
  }
});

test('genuine re-implementations are still caught at high confidence', () => {
  // Suppressing parallel sets must not suppress the case this tool exists for.
  const cluster = messy.findings.find((f) => f.kind === 'duplicate' && f.symbols.length >= 3);
  assert.ok(cluster, 'expected the three time formatters to still cluster');
  assert.ok(cluster.score >= 0.7, `expected high confidence, got ${cluster.score}`);
});

test('constructors are never duplicate candidates', () => {
  // Every Error subclass constructor is `super(message); this.name = '...'`.
  for (const finding of [...parallel.findings, ...messy.findings]) {
    if (finding.kind !== 'duplicate') continue;
    for (const id of finding.symbols) {
      assert.ok(!id.endsWith('.constructor'), `constructor reported as duplicate: ${id}`);
    }
  }
});
