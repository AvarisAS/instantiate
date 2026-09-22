/**
 * Squarified treemap layout.
 *
 * The one whole-codebase picture that survives scale. 50,000 symbols as a
 * node-link graph is a hairball; as nested rectangles sized by lines and
 * coloured by severity it is a picture someone reads in a second, using a
 * mental model — the folder tree — they already have.
 */

export interface TreeNode {
  name: string;
  path: string;
  value: number;
  children?: TreeNode[];
  /** 0..1, drives colour. */
  heat?: number;
  findings?: number;
}

export interface LaidOut extends TreeNode {
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  children?: LaidOut[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function layout(node: TreeNode, rect: Rect, depth = 0): LaidOut {
  const self: LaidOut = { ...node, ...rect, depth, children: undefined };
  if (!node.children || node.children.length === 0) return self;

  // Leave room for the folder label, but only when the box can spare it.
  const padding = depth === 0 ? 0 : 1;
  const header = depth > 0 && rect.height > 22 && rect.width > 40 ? 15 : 0;
  const inner: Rect = {
    x: rect.x + padding,
    y: rect.y + padding + header,
    width: Math.max(0, rect.width - padding * 2),
    height: Math.max(0, rect.height - padding * 2 - header),
  };

  const children = node.children
    .filter((c) => c.value > 0)
    .slice()
    .sort((a, b) => b.value - a.value);

  if (children.length === 0 || inner.width <= 0 || inner.height <= 0) return self;

  const total = children.reduce((sum, c) => sum + c.value, 0);
  const area = inner.width * inner.height;
  const scaled = children.map((c) => ({ node: c, area: (c.value / total) * area }));

  self.children = squarify(scaled, inner, depth + 1);
  return self;
}

interface Scaled {
  node: TreeNode;
  area: number;
}

/**
 * Bruls, Huizing and van Wijk's squarified treemap: fill the shorter side with
 * a row, extending it while the worst aspect ratio keeps improving. Boxes close
 * to square are the whole point — long slivers are unreadable and unclickable.
 */
function squarify(items: Scaled[], rect: Rect, depth: number): LaidOut[] {
  const out: LaidOut[] = [];
  let remaining = rect;
  let queue = items.slice();

  while (queue.length > 0) {
    const short = Math.min(remaining.width, remaining.height);
    if (short <= 0) break;

    const row: Scaled[] = [];
    let best = Infinity;

    for (const item of queue) {
      const candidate = [...row, item];
      const ratio = worstRatio(candidate, short);
      if (row.length > 0 && ratio > best) break;
      row.push(item);
      best = ratio;
    }

    const rowArea = row.reduce((sum, item) => sum + item.area, 0);
    const horizontal = remaining.width >= remaining.height;
    const thickness = rowArea / short || 0;

    let offset = horizontal ? remaining.y : remaining.x;
    for (const item of row) {
      const length = (item.area / rowArea) * short || 0;
      const box: Rect = horizontal
        ? { x: remaining.x, y: offset, width: thickness, height: length }
        : { x: offset, y: remaining.y, width: length, height: thickness };
      out.push(layout(item.node, box, depth));
      offset += length;
    }

    remaining = horizontal
      ? { x: remaining.x + thickness, y: remaining.y, width: remaining.width - thickness, height: remaining.height }
      : { x: remaining.x, y: remaining.y + thickness, width: remaining.width, height: remaining.height - thickness };
    queue = queue.slice(row.length);
  }

  return out;
}

function worstRatio(row: Scaled[], short: number): number {
  const sum = row.reduce((total, item) => total + item.area, 0);
  if (sum === 0) return Infinity;
  const max = Math.max(...row.map((item) => item.area));
  const min = Math.min(...row.map((item) => item.area));
  const side = short * short;
  return Math.max((side * max) / (sum * sum), (sum * sum) / (side * min));
}

/** Build a folder tree from flat file paths. */
export function treeFromPaths(
  root: string,
  files: Array<{ path: string; value: number; heat: number; findings: number }>,
): TreeNode {
  const tree: TreeNode = { name: root, path: '', value: 0, children: [] };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let next = current.children!.find((c) => c.path === path);
      if (!next) {
        next = { name: parts[i], path, value: 0, children: [] };
        current.children!.push(next);
      }
      current = next;
    }
    current.children!.push({
      name: parts[parts.length - 1],
      path: file.path,
      value: file.value,
      heat: file.heat,
      findings: file.findings,
    });
  }

  rollUp(tree);
  return tree;
}

function rollUp(node: TreeNode): number {
  if (!node.children || node.children.length === 0) return node.value;
  let total = 0;
  let weighted = 0;
  let findings = 0;
  for (const child of node.children) {
    const value = rollUp(child);
    total += value;
    weighted += (child.heat ?? 0) * value;
    findings += child.findings ?? 0;
  }
  node.value = total;
  // A folder's heat is the size-weighted mean of its children, so one bad file
  // in a large clean folder does not paint the whole folder red.
  node.heat = total > 0 ? weighted / total : 0;
  node.findings = findings;
  return total;
}
