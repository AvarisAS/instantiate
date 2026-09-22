import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/api.js';
import { checkBudget } from '../src/analysis/budget.js';

const here = dirname(fileURLToPath(import.meta.url));
const messy = join(here, 'fixtures', 'messy');

// One scan, reused: indexing is the slow part and the fixture does not change.
const result = await scan({ root: messy });

test('the fixture indexes and resolves cross-file edges', () => {
  assert.ok(result.stats.files >= 4, `indexed ${result.stats.files} files`);
  assert.ok(result.stats.symbols >= 8);
  const crossFile = result.graph.edges.filter(
    (e) => e.from.split('#')[0] !== e.to.split('#')[0],
  );
  assert.ok(crossFile.length > 0, 'expected imports to resolve across files');
});

test('unused exports are reported as dead', () => {
  const dead = result.findings.filter((f) => f.kind === 'dead').map((f) => f.symbols[0]);
  for (const expected of ['unusedLegacyFormatter', 'parseIsoDate', 'fetchAccount']) {
    assert.ok(
      dead.some((id) => id.endsWith(`#${expected}`)),
      `expected ${expected} to be reported dead`,
    );
  }
});

test('reachable code is never reported as dead', () => {
  const dead = result.findings.filter((f) => f.kind === 'dead').map((f) => f.symbols[0]);
  // These are called from the entrypoint, directly or one hop down.
  for (const alive of ['main', 'formatDuration', 'fetchUser', 'prettyTime']) {
    assert.ok(
      !dead.some((id) => id.endsWith(`#${alive}`)),
      `${alive} is reachable and must not be reported dead`,
    );
  }
});

test('the three time formatters cluster as one duplicate finding', () => {
  const clusters = result.findings.filter((f) => f.kind === 'duplicate');
  const names = clusters.flatMap((f) => f.symbols.map((s) => s.split('.').pop()!.split('#').pop()!));
  for (const expected of ['formatDuration', 'prettyTime', 'humanizeMs']) {
    assert.ok(names.some((n) => n.endsWith(expected)), `expected ${expected} in a duplicate cluster`);
  }
  // One cluster, not three pairs: a human should see one decision, not three.
  const timeCluster = clusters.find((f) => f.symbols.length >= 3);
  assert.ok(timeCluster, 'expected the three formatters in a single cluster');
});

test('unrelated functions are not clustered together', () => {
  const clusters = result.findings.filter((f) => f.kind === 'duplicate');
  for (const cluster of clusters) {
    const names = cluster.symbols.map((s) => s.split('#')[1]);
    const hasTime = names.some((n) => /Duration|Time|Ms/i.test(n));
    const hasFetch = names.some((n) => /fetch|load/i.test(n));
    assert.ok(!(hasTime && hasFetch), `time and fetch functions must not cluster: ${names.join(', ')}`);
  }
});

test('severity never outranks confidence', () => {
  for (const finding of result.findings) {
    if (finding.severity === 'high') {
      assert.ok(
        finding.score >= 0.4,
        `"${finding.title}" is high severity at only ${finding.score} confidence`,
      );
    }
  }
});

test('headline metrics ignore low-confidence findings', () => {
  const confidentDead = result.findings
    .filter((f) => f.kind === 'dead' && f.score >= 0.5)
    .reduce((sum, f) => sum + f.loc, 0);
  assert.equal(result.stats.deadLoc, confidentDead);
});

test('the budget ratchets on increase only', () => {
  const budget = { dead: 10, duplicate: 10, drift: 1, createdAt: 0 };
  assert.ok(checkBudget(budget, { ...result.stats, deadLoc: 5, duplicateLoc: 5, driftCount: 0 }).ok);
  assert.ok(checkBudget(budget, { ...result.stats, deadLoc: 10, duplicateLoc: 10, driftCount: 1 }).ok,
    'sitting exactly at the budget must pass');
  assert.ok(!checkBudget(budget, { ...result.stats, deadLoc: 11, duplicateLoc: 10, driftCount: 1 }).ok,
    'one line over must fail');
});

test('concepts cover every symbol exactly once', () => {
  const seen = new Set<string>();
  for (const concept of result.concepts) {
    for (const id of concept.symbols) {
      assert.ok(!seen.has(id), `${id} appears in two concepts`);
      seen.add(id);
    }
  }
  assert.equal(seen.size, result.graph.symbols.size);
});

test('scanning twice gives identical findings', async () => {
  // Determinism matters: a report that reshuffles between runs cannot be trusted
  // or diffed, and the concept map has to be recognisable from week to week.
  const again = await scan({ root: messy });
  assert.deepEqual(
    again.findings.map((f) => f.id),
    result.findings.map((f) => f.id),
  );
  assert.deepEqual(again.concepts.map((c) => c.name), result.concepts.map((c) => c.name));
});
