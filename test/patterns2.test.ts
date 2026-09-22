import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/api.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The third validation round used three repositories the tool had never seen
 * and scored 1/26, because it had been fitted to the ones it was tuned against.
 * Every pattern below is one of those false positives.
 */
const ts = await scan({ root: join(here, 'fixtures', 'patterns2') });
const py = await scan({ root: join(here, 'fixtures', 'python2') });

const deadIn = (result: typeof ts): string[] =>
  result.findings.filter((f) => f.kind === 'dead').map((f) => f.symbols[0].split('#')[1]);

const tsDead = deadIn(ts);
const pyDead = deadIn(py);

const alive = (result: 'ts' | 'py', member: string, why: string): void => {
  test(`${result}: ${member} is reachable — ${why}`, () => {
    const dead = result === 'ts' ? tsDead : pyDead;
    assert.ok(
      !dead.some((d) => d === member || d.endsWith(`.${member}`)),
      `${member} was reported dead; ${why}`,
    );
  });
};

alive('ts', 'readable', 'object shorthand: `{ readable }` means `{ readable: readable }`');
alive('ts', 'writable', 'object shorthand');
alive('ts', 'duplex', 'object shorthand');
alive('ts', '~internalRender', 'named with a string, so no identifier refers to it');
alive('ts', 'toJSON', 'the runtime calls it when the value is serialised');
alive('ts', 'render', 'calls resolve to the ambient declaration, not this implementation');
alive('ts', 'resize', 'calls resolve to the ambient declaration, not this implementation');
alive('ts', 'Registry', 'augmented by a `declare module` block');

alive('py', 'format', 'an override; the base calls self.format() and that is what runs');
alive('py', 'register', 'called from a nested function inside a decorator factory');
alive('py', 'shorten', 'reached through `from . import helpers`, a submodule import');
alive('py', '__getattr__', "Python's module attribute hook, called by the import machinery");
alive('py', 'example_only', 'examples are run directly, and the glob must cover .py');
alive('py', 'entry', 'called under the __main__ guard');

test('each fixture still reports its one genuinely dead symbol', () => {
  // Suppressing false positives must never suppress the true ones.
  assert.deepEqual(tsDead, ['trulyUnreachable']);
  assert.deepEqual(pyDead, ['never_used_at_all']);
});

test('a file where nothing is reachable is one finding, not one per symbol', () => {
  // Seventeen of zod's top twenty findings were two dead files between them,
  // reported per symbol, which pushed every independent finding out of view.
  const orphans = ts.findings.filter((f) => f.kind === 'orphan-file');
  assert.equal(orphans.length, 1, `expected one orphan file, got ${orphans.length}`);
  assert.match(orphans[0].file, /unused-module\.ts$/);
  assert.ok(orphans[0].symbols.length >= 3, 'the finding should carry every symbol in the file');

  // And its symbols must not also appear as separate findings.
  for (const name of ['abandonedBuild', 'abandonedParse']) {
    assert.ok(!tsDead.includes(name), `${name} should be rolled up into the file finding`);
  }
});
