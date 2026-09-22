export class Widget {
  render(): string {
    return this['~internalRender']();
  }
  resize(width: number): void {
    this.lastWidth = width;
  }
  private lastWidth = 0;

  // Named with a string, so no identifier ever refers to it.
  ['~internalRender'](): string {
    return 'widget:' + this.lastWidth;
  }

  // Called by the runtime when the value is serialised.
  toJSON(): object {
    return { width: this.lastWidth };
  }
}
