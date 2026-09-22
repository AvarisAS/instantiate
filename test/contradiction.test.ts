import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const conflicted = join(here, 'fixtures', 'conflicted');
const clean = join(here, 'fixtures', 'messy');

const result = scan({ root: conflicted });
const conflicts = result.findings.filter((f) => f.kind === 'contradiction');

test('one env var with two fallbacks is reported with high confidence', () => {
  const finding = conflicts.find((f) => f.id === 'contradiction:default:DB_HOST');
  assert.ok(finding, 'expected DB_HOST to be flagged');
  // Two literal defaults for one key is about as unambiguous as this gets.
  assert.ok(finding.score >= 0.8, `expected high confidence, got ${finding.score}`);
  assert.equal(finding.severity, 'high');

  const values = (finding.evidence!.variants as Array<{ value: string }>).map((v) => v.value);
  assert.ok(values.includes('localhost') && values.includes('db.internal'));
});

test('one named number with two values across files is reported', () => {
  const finding = conflicts.find((f) => f.id === 'contradiction:constant:timeout');
  assert.ok(finding, 'expected the timeout disagreement to be flagged');
  const values = new Set((finding.evidence!.variants as Array<{ value: string }>).map((v) => v.value));
  assert.deepEqual([...values].sort(), ['3000', '30000']);
});

test('UTC and local date handling in one codebase is reported', () => {
  const finding = conflicts.find((f) => f.id === 'contradiction:time-semantics');
  assert.ok(finding, 'expected the UTC/local split to be flagged');
  assert.ok((finding.evidence!.utc as unknown[]).length >= 2);
  assert.ok((finding.evidence!.local as unknown[]).length >= 2);
});

test('a codebase without conflicts reports none', () => {
  // The precision that matters: a false contradiction sends someone hunting
  // for a bug that does not exist.
  const other = scan({ root: clean });
  assert.equal(other.findings.filter((f) => f.kind === 'contradiction').length, 0);
});

test('contradiction severity ignores size, since loc counts sites', () => {
  for (const finding of conflicts) {
    const expected = finding.score >= 0.8 ? 'high' : finding.score >= 0.5 ? 'medium' : 'low';
    assert.equal(finding.severity, expected, `${finding.title} has the wrong severity`);
  }
});
