export function connect() {
  const host = process.env.DB_HOST ?? 'localhost';
  const timeout = 3000;
  return { host, timeout };
}
