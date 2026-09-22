export function error(issue: { code: string; path: string }): string {
  if (issue.code === 'required') {
    return 'MSG_REQUIRED_en' + issue.path;
  }
  if (issue.code === 'invalid') {
    return 'MSG_INVALID_en' + issue.path;
  }
  return 'MSG_UNKNOWN_en';
}
