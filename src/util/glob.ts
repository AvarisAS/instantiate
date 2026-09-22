/**
 * Minimal glob matcher: `**`, `*`, `?`, `{a,b}`, character classes.
 * Paths are always `/`-separated and relative to the project root.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;

  let re = '';
  let i = 0;
  const braces: number[] = [];

  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may match zero directories, so the slash is part of the optional group.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      braces.push(i);
      re += '(?:';
      i++;
    } else if (c === '}') {
      braces.pop();
      re += ')';
      i++;
    } else if (c === ',' && braces.length > 0) {
      re += '|';
      i++;
    } else if (c === '[') {
      const close = glob.indexOf(']', i);
      if (close === -1) {
        re += '\\[';
        i++;
      } else {
        re += glob.slice(i, close + 1);
        i = close + 1;
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }

  const compiled = new RegExp(`^${re}$`);
  cache.set(glob, compiled);
  return compiled;
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
