// Nothing imports this file, and nothing in it is reachable. That is one
// decision — delete the file — not one row per symbol.
export interface AbandonedShape {
  id: string;
  label: string;
}

export function abandonedBuild(shape: AbandonedShape): string {
  return shape.id + ':' + shape.label;
}

export function abandonedParse(raw: string): AbandonedShape {
  const [id, label] = raw.split(':');
  return { id, label };
}
