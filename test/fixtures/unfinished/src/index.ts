import { Panel, Shape, Square } from './panel';

// Flagged: read in a condition, never assigned. The handler that set it is gone.
let searchQuery = '';

export function visible(items: string[]): string[] {
  if (!searchQuery) return items;
  return items.filter((i) => i.includes(searchQuery));
}

// Not flagged: never reassigned, but nothing branches on it. A missing const.
let factor = 5;
export function scale(n: number): number {
  return n * factor;
}

// Not flagged: incremented.
let count = 0;
export function tick(): number {
  count++;
  return count > 3 ? 1 : 0;
}

// Not flagged: written through destructuring.
let left = 0;
let right = 0;
export function swap(pair: [number, number]): number {
  [left, right] = pair;
  return left > right ? left : right;
}

// Not flagged: written inside a closure.
let ready = false;
export function onLoad(listen: (fn: () => void) => void): void {
  listen(() => {
    ready = true;
  });
  if (ready) console.log('loaded');
}

// Flagged: not implemented.
export function exportPdf(): Uint8Array {
  throw new Error('Not implemented yet');
}

// Flagged: an empty body with a note left in it.
export function syncToCloud(): void {
  // TODO: call the sync endpoint
}

// Not flagged: a deliberate no-op.
export const noop = (): void => {};

export { Panel, Shape, Square };

// Not flagged: the reads belong to a parameter that shadows it.
let theme = 'light';
export function paint(theme: string): string {
  return theme === 'dark' ? '#000' : '#fff';
}
export const initial = paint(theme);

// Not flagged: `!` promises an assignment elsewhere.
let typeProbe!: string;
export const probe = (): string => (typeProbe ? typeProbe : '');

// Not flagged: assigned in a callback that also holds an unrelated inner `secret` parameter.
let secret: string;
export function suite(run: (fn: () => void) => void): void {
  run(() => {
    secret = 'abc';
    const check = (secret: string): boolean => secret.length > 0;
    if (check(secret)) console.log(secret);
  });
  if (secret) console.log('set');
}
