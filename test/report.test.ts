import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scan } from '../src/api.js';
import { renderHtmlReport } from '../src/report/html.js';

const here = dirname(fileURLToPath(import.meta.url));
const result = await scan({ root: join(here, 'fixtures', 'patterns') });
const html = renderHtmlReport(result, result.findings);

test('both search boxes are wired to what they filter', () => {
  // Merging the toolbar once deleted the listener while leaving both inputs
  // on screen: they accepted typing and filtered nothing.
  assert.match(html, /addEventListener\('input'/);
  assert.match(html, /event\.target\.id === 'sym-filter'[\s\S]{0,80}symbolFilter = /);
  assert.match(html, /event\.target\.id !== 'ex-search'[\s\S]{0,40}query = /);
});
