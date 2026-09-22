export class BaseThing {
  run(_input?: string): string {
    throw new Error('not implemented');
  }
  describe(_input?: string): string {
    throw new Error('not implemented');
  }
}

export class ConcreteThing extends BaseThing {
  run(): string {
    const parts = ['a', 'b', 'c'];
    const joined = parts.join('-');
    return joined.toUpperCase();
  }
}
