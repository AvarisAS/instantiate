const handlers: Record<string, () => string> = {
  a: () => 'a',
};

export function dispatch(kind: string): string {
  return handlers[kind]();
}
