export function prettyTime(milliseconds: number): string {
  const secs = Math.floor(milliseconds / 1000);
  const mins = Math.floor(secs / 60);
  if (mins > 0) {
    return mins + "m " + (secs % 60) + "s";
  }
  return secs + "s";
}

export function humanizeMs(value: number): string {
  const totalSeconds = Math.floor(value / 1000);
  const wholeMinutes = Math.floor(totalSeconds / 60);
  if (wholeMinutes > 0) {
    return wholeMinutes + "m " + (totalSeconds % 60) + "s";
  }
  return totalSeconds + "s";
}

export function unusedLegacyFormatter(bytes: number): string {
  const kilobytes = bytes / 1024;
  const megabytes = kilobytes / 1024;
  if (megabytes > 1) return megabytes.toFixed(1) + "MB";
  return kilobytes.toFixed(1) + "KB";
}
