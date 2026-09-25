import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/api.js';
import { checkBudget } from '../src/analysis/budget.js';

const here = dirname(fileURLToPath(import.meta.url));
const result = await scan({ root: join(here, 'fixtures', 'ignores') });
const shown = (name: string): boolean =>
  result.findings.some((f) => f.title.startsWith(`${name} `) || f.symbols.some((s) => s.endsWith(`#${name}`)));

test('an ignore with a kind and a reason hides that finding', () => {
  assert.ok(!shown('loadedByPath'));
  assert.ok(!shown('hourly'), 'python comments work the same way');
});

test('one comment can name several kinds, and sit above a docblock', () => {
  assert.ok(!shown('exportV2'), 'both its dead and its unfinished findings are hidden');
});

test('findings nobody commented on are untouched', () => {
  assert.ok(shown('reallyDead'));
});

test('an ignore without a reason, or with an unknown kind, hides nothing and is reported', () => {
  assert.ok(shown('noReason'));
  assert.ok(shown('badKind'));
  const warning = result.warnings.find((w) => w.includes('missing a kind or a reason'));
  assert.ok(warning, 'reported');
  assert.match(warning, /src\/lib\.ts:22/);
  assert.match(warning, /src\/lib\.ts:27/);
});

test('an ignore only hides the kinds it names', () => {
  assert.ok(shown('wrongKind'), 'says duplicate, finding is dead');
});

test('an ignore that no longer hides anything is reported as stale', () => {
  const warning = result.warnings.find((w) => w.includes('no longer hide'));
  assert.ok(warning);
  assert.match(warning, /src\/lib\.ts:32/, 'stale() is not a duplicate');
  assert.match(warning, /src\/lib\.ts:37/, 'wrongKind() has no duplicate finding either');
  // A file with a __main__ guard is run, so everything in it is used already.
  assert.match(warning, /py\/tasks\.py:5/);
});

test('ignored findings leave the headline numbers, and are counted instead', () => {
  assert.equal(result.stats.ignoredCount, 3, 'loadedByPath, exportV2 (one comment, two kinds), hourly');
  const deadNames = result.findings.filter((f) => f.kind === 'dead').map((f) => f.title.split(' ')[0]);
  const expected = result.findings
    .filter((f) => (f.kind === 'dead' || f.kind === 'orphan-file') && f.score >= 0.5)
    .reduce((n, f) => n + f.loc, 0);
  assert.equal(result.stats.deadLoc, expected, `deadLoc matches what is shown: ${deadNames}`);
});

test('more ignores than the budget allows fails the check', () => {
  const budget = { dead: 1e6, duplicate: 1e6, drift: 1e6, contradiction: 1e6, unfinished: 1e6, ignored: 2, createdAt: 0 };
  const check = checkBudget(budget, result.stats);
  assert.equal(check.ok, false);
  assert.ok(check.lines.some((l) => l.includes('ignored in code') && l.includes('+1')));
});
