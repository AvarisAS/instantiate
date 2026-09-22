import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuralBag, vocabularyBag, cosine, splitIdentifier } from '../src/analysis/similarity.js';

const combined = (name: string, body: string) => ({
  s: structuralBag(body),
  v: vocabularyBag(name, body),
});

const score = (a: ReturnType<typeof combined>, b: ReturnType<typeof combined>) =>
  0.5 * cosine(a.s, b.s) + 0.5 * cosine(a.v, b.v);

test('identifier splitting handles every common case', () => {
  assert.deepEqual(splitIdentifier('calculateLatency'), ['calculate', 'latency']);
  assert.deepEqual(splitIdentifier('HTTPServerError'), ['http', 'server', 'error']);
  assert.deepEqual(splitIdentifier('snake_case_name'), ['snake', 'case', 'name']);
});

test('the same job written twice with different names scores high', () => {
  // This is the actual target: not copy-paste, but a redundant re-implementation.
  const a = combined('formatDuration', `
    function formatDuration(ms) {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      if (minutes > 0) return minutes + "m " + (seconds % 60) + "s";
      return seconds + "s";
    }`);
  const b = combined('humanizeMs', `
    function humanizeMs(milliseconds) {
      const secs = Math.floor(milliseconds / 1000);
      const mins = Math.floor(secs / 60);
      if (mins > 0) return mins + "m " + (secs % 60) + "s";
      return secs + "s";
    }`);
  assert.ok(score(a, b) > 0.75, `expected a high score, got ${score(a, b)}`);
});

test('unrelated functions score low', () => {
  const a = combined('formatDuration', 'function formatDuration(ms) { return Math.floor(ms / 1000) + "s"; }');
  const b = combined('openDatabase', 'async function openDatabase(url) { const client = await connect(url); return client.db(); }');
  assert.ok(score(a, b) < 0.4, `expected a low score, got ${score(a, b)}`);
});

test('same shape but different domain is not a duplicate', () => {
  // Structure alone would call these identical; vocabulary is what saves us.
  const a = combined('sumPrices', 'function sumPrices(orders) { let total = 0; for (const order of orders) { total += order.price; } return total; }');
  const b = combined('countErrors', 'function countErrors(logs) { let tally = 0; for (const entry of logs) { tally += entry.failures; } return tally; }');
  assert.ok(score(a, b) < 0.7, `expected structure alone not to trigger, got ${score(a, b)}`);
});

test('cosine is bounded and symmetric', () => {
  const a = vocabularyBag('a', 'const x = compute(1)');
  const b = vocabularyBag('b', 'const y = compute(2)');
  assert.equal(cosine(a, b), cosine(b, a));
  assert.ok(cosine(a, a) > 0.999 && cosine(a, a) <= 1.0001);
});
