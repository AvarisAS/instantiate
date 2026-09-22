import * as locales from './locales/index.js';
export function translate(locale: string, issue: { code: string; path: string }) {
  return (locales as Record<string, { error: (i: { code: string; path: string }) => string }>)[locale]?.error(issue);
}
translate('en', { code: 'required', path: 'name' });
