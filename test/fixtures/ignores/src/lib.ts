export function a(): number {
  return 1;
}

// instantiate-ignore dead: required by path from the deploy script
function loadedByPath(): string {
  return 'deploy';
}

/**
 * A docblock between the comment and the declaration is fine.
 */
// instantiate-ignore dead, unfinished: kept for the v2 exporter, which lands next
function exportV2(): void {
  // TODO: write it
}

function reallyDead(): string {
  return 'nobody calls this';
}

// instantiate-ignore dead
function noReason(): string {
  return 'a reason is required';
}

// instantiate-ignore everything: not a kind
function badKind(): string {
  return 'unknown kinds hide nothing';
}

// instantiate-ignore duplicate: this one is not a duplicate of anything
export function stale(): number {
  return a() + 1;
}

// instantiate-ignore duplicate: nothing duplicates it, but it is still dead
function wrongKind(): string {
  return 'hidden from duplicate, not from dead';
}
