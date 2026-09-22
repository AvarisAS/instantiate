// The published description of an API whose implementation lives elsewhere.
// Calls resolve to this, never through it.
export declare class Widget {
  render(): string;
  resize(width: number): void;
}

declare module './registry.js' {
  interface Registry {
    widget: string;
  }
}
