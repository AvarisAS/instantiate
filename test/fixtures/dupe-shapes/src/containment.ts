export function outerWithClosure(seed: number): number {
  // The closure's text is inside the parent's, so similarity is guaranteed and
  // meaningless. This is containment, not duplication.
  function innerHelper(value: number): number {
    const doubled = value * 2;
    const shifted = doubled + seed;
    return shifted - 1;
  }
  const doubled = seed * 2;
  const shifted = doubled + seed;
  return innerHelper(shifted - 1);
}
