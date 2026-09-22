export function error(issue: { code: string; path: string }): string {
  if (issue.code === 'required') {
    return 'MSG_REQUIRED_de' + issue.path;
  }
  if (issue.code === 'invalid') {
    return 'MSG_INVALID_de' + issue.path;
  }
  return 'MSG_UNKNOWN_de';
}
