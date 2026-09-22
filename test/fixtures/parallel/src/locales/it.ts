export function error(issue: { code: string; path: string }): string {
  if (issue.code === 'required') {
    return 'MSG_REQUIRED_it' + issue.path;
  }
  if (issue.code === 'invalid') {
    return 'MSG_INVALID_it' + issue.path;
  }
  return 'MSG_UNKNOWN_it';
}
