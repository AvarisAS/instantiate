import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scan } from '../src/api.js';
import { readCoverage } from '../src/analysis/coverage.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'fixtures', 'patterns');
const scratch = mkdtempSync(join(tmpdir(), 'instantiate-coverage-'));

/** An Istanbul report saying whether the one dead function ever ran. */
const istanbul = (ran: boolean): string => {
  const path = join(scratch, `istanbul-${ran}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      [join(root, 'src/genuinely-dead.ts')]: {
        path: join(root, 'src/genuinely-dead.ts'),
        statementMap: { '0': { start: { line: 1 }, end: { line: 5 } } },
        s: { '0': ran ? 3 : 0 },
      },
    }),
  );
  return path;
};

test('a symbol the tests executed is alive, however it was reached', async () => {
  // The only honest answer to dynamic dispatch: a container resolving a name
  // from a string leaves no trace in the source and a clear one in a test run.
  const coverage = readCoverage(root, istanbul(true));
  const result = await scan({ root, coverage });
  assert.equal(result.findings.filter((f) => f.kind === 'dead').length, 0);
});

test('a symbol no test executed is reported with near-certainty', async () => {
  const coverage = readCoverage(root, istanbul(false));
  const result = await scan({ root, coverage });
  const dead = result.findings.filter((f) => f.kind === 'dead');
  assert.equal(dead.length, 1);
  // Without coverage this same finding sits at 0.70, hedged against dispatch
  // the graph cannot see. With it, the hedge is answered.
  assert.ok(dead[0].score > 0.9, `expected near-certainty, got ${dead[0].score}`);
  assert.match(dead[0].detail, /no test executed it/);
});

test('coverage.py reports are understood too', () => {
  const path = join(scratch, 'python.json');
  writeFileSync(
    path,
    JSON.stringify({ files: { 'src/pkg/base.py': { executed_lines: [1, 2, 3] } } }),
  );
  const coverage = readCoverage(join(here, 'fixtures', 'python2'), path);
  assert.equal(coverage.format, 'coverage.py');
  assert.deepEqual([...(coverage.executed.get('src/pkg/base.py') ?? [])], [1, 2, 3]);
});

test('an unreadable report fails with something actionable', () => {
  const path = join(scratch, 'nonsense.json');
  writeFileSync(path, JSON.stringify({ nothing: 'useful' }));
  assert.throws(() => readCoverage(root, path), /coverage-final\.json|coverage json/);
});
