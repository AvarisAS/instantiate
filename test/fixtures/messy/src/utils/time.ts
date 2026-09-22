export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) {
    return minutes + "m " + (seconds % 60) + "s";
  }
  return seconds + "s";
}

export function parseIsoDate(input: string): Date {
  const parsed = new Date(input);
  if (isNaN(parsed.getTime())) {
    throw new Error("bad date: " + input);
  }
  return parsed;
}
