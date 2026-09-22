import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const patterns = join(here, 'fixtures', 'patterns');

/**
 * Every pattern here caused a real false positive on a real repository.
 * Validation against hono, chalk and zod put dead-code precision at 0%, and
 * each of these is one of the reasons why.
 */
const result = scan({ root: patterns });
const dead = result.findings.filter((f) => f.kind === 'dead');
const deadNames = dead.map((f) => f.symbols[0].split('#')[1]);

const alive = (name: string, why: string): void => {
  test(`${name} is reachable: ${why}`, () => {
    assert.ok(!deadNames.includes(name), `${name} was wrongly reported dead — ${why}`);
  });
};

alive('calledAtTopLevel', 'called from module scope, which has no enclosing function');
alive('wrapper', 'called from module scope');
alive('reachedOnlyViaWrapper', 'reached only transitively, through a top-level call');
alive('viaNamedBarrel', 're-exported through `export { x } from`');
alive('viaStarBarrel', 're-exported through `export *`, which names nothing');
alive('alpha', 'namespace-imported and indexed by a runtime key');
alive('beta', 'namespace-imported and indexed by a runtime key');
alive('Machine', 'constructed at module scope');
alive('privateStep', 'called as this.#privateStep(), a PrivateIdentifier not an Identifier');
alive('DocsOnlyComponent', 'imported from an .mdx page that is never itself indexed');
alive('neverUsedButVendored', 'vendored code is somebody else\'s contract, not our finding');

test('genuinely unreachable code is still reported', () => {
  // The whole point: suppressing false positives must not suppress true ones.
  assert.ok(
    deadNames.includes('nothingCallsThisAtAll'),
    `expected the one dead function to be found, got: ${deadNames.join(', ') || 'nothing'}`,
  );
});

test('this fixture yields exactly one dead finding', () => {
  assert.equal(dead.length, 1, `unexpected findings: ${deadNames.join(', ')}`);
});

test('a subpath import resolves through package.json imports', () => {
  const edges = result.graph.edges.filter((e) => e.to.startsWith('vendor/lib/index.ts#'));
  assert.ok(edges.length > 0, 'expected #vendored to resolve to the vendored module');
});

test('satellite files become graph roots', () => {
  const satellite = result.graph.edges.filter((e) => e.from.endsWith('#<satellite>'));
  assert.ok(satellite.length > 0, 'expected the .mdx page to contribute edges');
});
