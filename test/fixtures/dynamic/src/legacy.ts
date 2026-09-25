export function loadedByTheOldShell(): string {
  return helperOnlyTheShellPathUses();
}
function helperOnlyTheShellPathUses(): string {
  return 'legacy';
}
