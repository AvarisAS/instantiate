export function stamp(event: string) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  return event + ':' + year + '-' + month + '-' + day;
}

export function auditWindow() {
  const start = new Date();
  return start.toISOString();
}
