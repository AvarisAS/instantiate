export class Panel {
  // Flagged: private, writable, branched on, never assigned.
  private collapsed = false;
  // Not flagged: assigned in a method.
  private pinned = false;

  toggle(): void {
    this.pinned = !this.pinned;
  }

  render(): string {
    if (this.collapsed) return '';
    return this.pinned ? 'pinned' : 'open';
  }
}

export abstract class Shape {
  // Not flagged: abstract.
  abstract area(): number;

  // Not flagged: a hook the subclass fills in.
  describe(): string {
    throw new Error('not implemented');
  }
}

export class Square extends Shape {
  area(): number {
    return 4;
  }
  describe(): string {
    return 'square';
  }
}
