export function createClient() {
  // Same variable, a different fallback. Whichever loads first wins.
  const host = process.env.DB_HOST ?? 'db.internal';
  const timeout = 30000;
  return { host, timeout };
}
