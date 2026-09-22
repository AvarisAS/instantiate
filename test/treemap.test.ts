import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, treeFromPaths, type LaidOut } from '../src/report/treemap.js';

const leaves = (node: LaidOut): LaidOut[] =>
  node.children ? node.children.flatMap(leaves) : [node];

test('paths become a nested tree with rolled-up values', () => {
  const tree = treeFromPaths('root', [
    { path: 'src/a.ts', value: 10, heat: 1, findings: 1 },
    { path: 'src/deep/b.ts', value: 30, heat: 0, findings: 0 },
    { path: 'top.ts', value: 60, heat: 0, findings: 0 },
  ]);
  assert.equal(tree.value, 100);
  const src = tree.children!.find((c) => c.name === 'src')!;
  assert.equal(src.value, 40);
  // Heat is size-weighted, so the small hot file does not redden the folder.
  assert.ok(src.heat! < 0.3, `expected weighted heat, got ${src.heat}`);
});

test('layout fills the rectangle without overlapping', () => {
  const tree = treeFromPaths('root', [
    { path: 'a.ts', value: 50, heat: 0, findings: 0 },
    { path: 'b.ts', value: 30, heat: 0, findings: 0 },
    { path: 'c.ts', value: 20, heat: 0, findings: 0 },
  ]);
  const out = layout(tree, { x: 0, y: 0, width: 400, height: 300 });
  const boxes = leaves(out);
  assert.equal(boxes.length, 3);

  const area = boxes.reduce((sum, b) => sum + b.width * b.height, 0);
  assert.ok(Math.abs(area - 400 * 300) < 1, `expected full coverage, got ${area}`);

  for (const box of boxes) {
    assert.ok(box.x >= -0.01 && box.y >= -0.01);
    assert.ok(box.x + box.width <= 400.01 && box.y + box.height <= 300.01);
  }
});

test('bigger values get bigger boxes', () => {
  const tree = treeFromPaths('root', [
    { path: 'big.ts', value: 90, heat: 0, findings: 0 },
    { path: 'small.ts', value: 10, heat: 0, findings: 0 },
  ]);
  const boxes = leaves(layout(tree, { x: 0, y: 0, width: 200, height: 200 }));
  const big = boxes.find((b) => b.name === 'big.ts')!;
  const small = boxes.find((b) => b.name === 'small.ts')!;
  assert.ok(big.width * big.height > small.width * small.height * 5);
});

test('squarified boxes stay close to square', () => {
  const files = Array.from({ length: 24 }, (_, i) => ({
    path: `f${i}.ts`, value: 100 - i * 3, heat: 0, findings: 0,
  }));
  const boxes = leaves(layout(treeFromPaths('root', files), { x: 0, y: 0, width: 600, height: 400 }));
  const ratios = boxes.map((b) => Math.max(b.width / b.height, b.height / b.width));
  const median = ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)];
  // Slivers are unreadable and unclickable; this is the property that matters.
  assert.ok(median < 3, `median aspect ratio ${median} is too extreme`);
});
