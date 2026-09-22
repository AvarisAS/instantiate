import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const result = await scan({ root: join(here, 'fixtures', 'dupe-shapes') });
const clusters = result.findings.filter((f) => f.kind === 'duplicate');
const names = clusters.map((c) => c.symbols.map((s) => s.split('#')[1].split('.').pop()!));

const noCluster = (member: string, why: string): void => {
  test(`${member} is not reported as a duplicate: ${why}`, () => {
    const hit = names.find((group) => group.includes(member));
    assert.ok(!hit, `${member} clustered with ${hit?.join(', ')} — ${why}`);
  });
};

// Each of these was a false positive on a real repository.
noCluster('innerHelper', 'a closure inside the function whose text contains it');
noCluster('describe', 'a stub implements nothing, and every stub resembles every other');
noCluster('head', 'a named door onto one shared function');
noCluster('options', 'a named door onto one shared function');
noCluster('checksRequired', 'a test file repeats its scaffolding on purpose');
noCluster('helpOption', 'a designed set differing in exactly one word');

test('mirrored API surfaces are demoted, not reported as redundancy', () => {
  // Two directories sharing most of their symbol names are two views of one
  // idea — zod's classic and mini — where matching structure is the design.
  const parallel = clusters.filter((c) => c.title.includes('parallel'));
  assert.ok(parallel.length > 0, 'expected the mirrored directories to be recognised');
  for (const cluster of parallel) {
    assert.ok(cluster.score < 0.5, `${cluster.title} should be low confidence, got ${cluster.score}`);
  }
});

test('a genuine accidental duplicate is still caught', () => {
  // Suppressing all of the above must not suppress the case this tool is for.
  const genuine = names.find(
    (group) => group.includes('renderInvoiceTotal') && group.includes('formatReceiptTotal'),
  );
  assert.ok(genuine, `expected the real duplicate to be found; got ${JSON.stringify(names)}`);
  const finding = clusters.find((c) => c.symbols.some((s) => s.endsWith('#renderInvoiceTotal')))!;
  assert.ok(finding.score >= 0.6, `expected reasonable confidence, got ${finding.score}`);
});

test('one name implemented by several classes is polymorphism', () => {
  // Each class must supply its own; that is the design, not a repetition.
  const finding = clusters.find((c) => c.symbols.every((s) => s.endsWith('.extract')));
  assert.ok(finding, 'expected the two extract implementations to be recognised');
  assert.ok(finding.score < 0.4, `expected strong demotion, got ${finding.score}`);
});

test('test files are excluded by default and surfaced on request', async () => {
  const { scan: rescan } = await import('../src/api.js');
  const { loadConfig } = await import('../src/config.js');
  const root = join(here, 'fixtures', 'dupe-shapes');
  const withTests = await rescan({
    root,
    config: { ...loadConfig(root), includeTests: true },
  });
  const named = (r: typeof withTests): string[] =>
    r.findings.filter((f) => f.kind === 'duplicate').flatMap((f) => f.symbols.map((s) => s.split('#')[1]));

  assert.ok(!named(result).includes('checksRequired'), 'tests should be hidden by default');
  assert.ok(named(withTests).includes('checksRequired'), '--include-tests should surface them');
});

test('parallel sets do not inflate the headline number', () => {
  // Only the genuine duplicate should count towards the CI budget.
  assert.ok(result.stats.duplicateLoc > 0, 'the genuine duplicate should count');
  assert.ok(result.stats.duplicateLoc < 30, `parallel sets leaked into the total: ${result.stats.duplicateLoc}`);
});
