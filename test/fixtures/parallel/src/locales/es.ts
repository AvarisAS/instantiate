export function error(issue: { code: string; path: string }): string {
  if (issue.code === 'required') {
    return 'MSG_REQUIRED_es' + issue.path;
  }
  if (issue.code === 'invalid') {
    return 'MSG_INVALID_es' + issue.path;
  }
  return 'MSG_UNKNOWN_es';
}
