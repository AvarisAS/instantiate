function readable(): string { return 'r'; }
function writable(): string { return 'w'; }
function duplex(): string { return 'd'; }

export function streams(): Record<string, unknown> {
  // Shorthand: `{ readable }` means `{ readable: readable }`.
  return { readable, writable, duplex };
}
