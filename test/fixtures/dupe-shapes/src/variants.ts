function baseOption(name: string, flag: boolean): string {
  return name + ':' + flag;
}

// A designed set differing in exactly one word. Merging them deletes the API.
export function helpOption(name: string): string {
  return baseOption(name, true);
}
export function versionOption(name: string): string {
  return baseOption(name, false);
}
