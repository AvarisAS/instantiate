import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchesAny } from '../src/util/glob.js';

test('star does not cross directory boundaries', () => {
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/deep/a.ts'));
});

test('globstar matches zero or more directories', () => {
  const re = globToRegExp('src/**/*.ts');
  assert.ok(re.test('src/a.ts'), 'zero directories');
  assert.ok(re.test('src/deep/nested/a.ts'), 'several directories');
});

test('braces expand to alternatives', () => {
  const re = globToRegExp('**/*.{test,spec}.ts');
  assert.ok(re.test('test/glob.test.ts'));
  assert.ok(re.test('a/b/x.spec.ts'));
  assert.ok(!re.test('a/b/x.ts'));
});

test('exclude globs match node_modules at any depth', () => {
  assert.ok(matchesAny('node_modules/foo/index.js', ['**/node_modules/**']));
  assert.ok(matchesAny('packages/a/node_modules/b/i.js', ['**/node_modules/**']));
});

test('dots in the pattern are literal', () => {
  assert.ok(!globToRegExp('*.ts').test('axts'));
});
