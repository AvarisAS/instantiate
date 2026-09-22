const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: string) => (text: string) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);

export const dim = wrap('2');
export const bold = wrap('1');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const magenta = wrap('35');
export const cyan = wrap('36');

export function severityColour(severity: string): (text: string) => string {
  return severity === 'high' ? red : severity === 'medium' ? yellow : dim;
}

/** A bar for a proportion, used for drift breakdowns and the summary. */
export function bar(fraction: number, width = 20): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return '█'.repeat(filled) + dim('░'.repeat(width - filled));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
