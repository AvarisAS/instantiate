export async function load(lang: string): Promise<unknown> {
  return import(`./locales/${lang}`);
}
