type DocsLocale = string | undefined;

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');
const withTrailingSlash = (value: string) => `${trimTrailingSlash(value)}/`;

export function normalizeDocsSiteUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  return withTrailingSlash(trimmed);
}

export function buildDocsHref(args: {
  locale?: DocsLocale;
  docsSiteUrl?: unknown;
  embeddedBaseURL: string;
}): string {
  const localizedPath = args.locale === 'ru' ? 'ru/' : '';
  const externalDocsUrl = normalizeDocsSiteUrl(args.docsSiteUrl);

  if (externalDocsUrl) {
    return `${externalDocsUrl}${localizedPath}`;
  }

  const base = args.embeddedBaseURL.replace(/\/?$/, '/');
  return `${base}${args.locale === 'ru' ? 'docs/ru/' : 'docs/'}`;
}
