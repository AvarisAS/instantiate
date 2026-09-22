function send(verb: string, url: string): string {
  return verb + ' ' + url;
}
export function head(url: string): string {
  return send('head', url);
}
export function options(url: string): string {
  return send('options', url);
}
export function remove(url: string): string {
  return send('delete', url);
}
