export type LocaleCode =
  | 'en'
  | 'ru'
  | 'zh'
  | 'es'
  | 'hi'
  | 'ar'
  | 'pt'
  | 'fr'
  | 'ja'
  | 'ko'
  | 'de'
  | 'bn'
  | 'ur'
  | 'id'
  | 'it'
  | 'tr'
  | 'vi'
  | 'pl'
  | 'fa'
  | 'th'
  | 'uk'
  | 'nl'
  | 'ta'
  | 'te'
  | 'mr'
  | 'fil'
  | 'ms'
  | 'sw'
  | 'ro';

export const supportedLocales = [
  { code: 'en', iso: 'en-US', name: 'English', flag: '\u{1F1FA}\u{1F1F8}', file: 'en.json' },
  { code: 'zh', iso: 'zh-CN', name: '中文', flag: '\u{1F1E8}\u{1F1F3}', file: 'zh.json' },
  { code: 'es', iso: 'es-ES', name: 'Español', flag: '\u{1F1EA}\u{1F1F8}', file: 'es.json' },
  { code: 'hi', iso: 'hi-IN', name: 'हिन्दी', flag: '\u{1F1EE}\u{1F1F3}', file: 'hi.json' },
  { code: 'bn', iso: 'bn-BD', name: 'বাংলা', flag: '\u{1F1E7}\u{1F1E9}', file: 'bn.json' },
  {
    code: 'ar',
    iso: 'ar-SA',
    name: 'العربية',
    flag: '\u{1F1F8}\u{1F1E6}',
    file: 'ar.json',
    dir: 'rtl',
  },
  { code: 'pt', iso: 'pt-BR', name: 'Português', flag: '\u{1F1E7}\u{1F1F7}', file: 'pt.json' },
  { code: 'fr', iso: 'fr-FR', name: 'Français', flag: '\u{1F1EB}\u{1F1F7}', file: 'fr.json' },
  { code: 'ja', iso: 'ja-JP', name: '日本語', flag: '\u{1F1EF}\u{1F1F5}', file: 'ja.json' },
  { code: 'ko', iso: 'ko-KR', name: '한국어', flag: '\u{1F1F0}\u{1F1F7}', file: 'ko.json' },
  {
    code: 'ur',
    iso: 'ur-PK',
    name: 'اردو',
    flag: '\u{1F1F5}\u{1F1F0}',
    file: 'ur.json',
    dir: 'rtl',
  },
  { code: 'id', iso: 'id-ID', name: 'Indonesia', flag: '\u{1F1EE}\u{1F1E9}', file: 'id.json' },
  { code: 'de', iso: 'de-DE', name: 'Deutsch', flag: '\u{1F1E9}\u{1F1EA}', file: 'de.json' },
  { code: 'ru', iso: 'ru-RU', name: 'Русский', flag: '\u{1F1F7}\u{1F1FA}', file: 'ru.json' },
  { code: 'it', iso: 'it-IT', name: 'Italiano', flag: '\u{1F1EE}\u{1F1F9}', file: 'it.json' },
  { code: 'tr', iso: 'tr-TR', name: 'Türkçe', flag: '\u{1F1F9}\u{1F1F7}', file: 'tr.json' },
  { code: 'vi', iso: 'vi-VN', name: 'Tiếng Việt', flag: '\u{1F1FB}\u{1F1F3}', file: 'vi.json' },
  { code: 'pl', iso: 'pl-PL', name: 'Polski', flag: '\u{1F1F5}\u{1F1F1}', file: 'pl.json' },
  {
    code: 'fa',
    iso: 'fa-IR',
    name: 'فارسی',
    flag: '\u{1F1EE}\u{1F1F7}',
    file: 'fa.json',
    dir: 'rtl',
  },
  { code: 'th', iso: 'th-TH', name: 'ไทย', flag: '\u{1F1F9}\u{1F1ED}', file: 'th.json' },
  { code: 'uk', iso: 'uk-UA', name: 'Українська', flag: '\u{1F1FA}\u{1F1E6}', file: 'uk.json' },
  { code: 'nl', iso: 'nl-NL', name: 'Nederlands', flag: '\u{1F1F3}\u{1F1F1}', file: 'nl.json' },
  { code: 'ta', iso: 'ta-IN', name: 'தமிழ்', flag: '\u{1F1EE}\u{1F1F3}', file: 'ta.json' },
  { code: 'te', iso: 'te-IN', name: 'తెలుగు', flag: '\u{1F1EE}\u{1F1F3}', file: 'te.json' },
  { code: 'mr', iso: 'mr-IN', name: 'मराठी', flag: '\u{1F1EE}\u{1F1F3}', file: 'mr.json' },
  { code: 'fil', iso: 'fil-PH', name: 'Filipino', flag: '\u{1F1F5}\u{1F1ED}', file: 'fil.json' },
  { code: 'ms', iso: 'ms-MY', name: 'Bahasa Melayu', flag: '\u{1F1F2}\u{1F1FE}', file: 'ms.json' },
  { code: 'sw', iso: 'sw-KE', name: 'Kiswahili', flag: '\u{1F1F0}\u{1F1EA}', file: 'sw.json' },
  { code: 'ro', iso: 'ro-RO', name: 'Română', flag: '\u{1F1F7}\u{1F1F4}', file: 'ro.json' },
] as const;

export const defaultLocale: LocaleCode = 'en';

export const pages = ['/', '/download'] as const;

/** Pages for sitemap */
export const sitemapPages = ['/', '/download'] as const;

export type SitemapPagePath = (typeof sitemapPages)[number];

export const getLocaleMeta = (localeCode: LocaleCode) =>
  supportedLocales.find((locale) => locale.code === localeCode) ?? supportedLocales[0];

export const getLocalizedPagePath = (page: SitemapPagePath, localeCode: LocaleCode): string => {
  if (localeCode === defaultLocale) return page;
  return page === '/' ? `/${localeCode}` : `/${localeCode}${page}`;
};

/** Generates i18n routes for a given list of pages */
const buildI18nRoutes = (source: readonly string[]): string[] => {
  const routes: string[] = [];
  for (const page of source) {
    routes.push(page);
    for (const locale of supportedLocales) {
      if (locale.code === defaultLocale) continue;
      routes.push(page === '/' ? `/${locale.code}` : `/${locale.code}${page}`);
    }
  }
  return routes;
};

/** All i18n routes (for prerender) */
export const generateI18nRoutes = (): string[] => buildI18nRoutes(pages);

/** i18n routes for sitemap only */
export const generateSitemapRoutes = (): string[] => buildI18nRoutes(sitemapPages);
