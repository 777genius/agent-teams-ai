export type LocaleCode = "en" | "ru" | "zh" | "es" | "hi" | "ar" | "pt" | "fr" | "ja" | "de";

export const supportedLocales = [
  { code: "en", iso: "en-US", name: "English", flag: "\u{1F1FA}\u{1F1F8}", file: "en.json" },
  { code: "zh", iso: "zh-CN", name: "中文", flag: "\u{1F1E8}\u{1F1F3}", file: "zh.json" },
  { code: "es", iso: "es-ES", name: "Español", flag: "\u{1F1EA}\u{1F1F8}", file: "es.json" },
  { code: "hi", iso: "hi-IN", name: "हिन्दी", flag: "\u{1F1EE}\u{1F1F3}", file: "hi.json" },
  { code: "ar", iso: "ar-SA", name: "العربية", flag: "\u{1F1F8}\u{1F1E6}", file: "ar.json", dir: "rtl" },
  { code: "pt", iso: "pt-BR", name: "Português", flag: "\u{1F1E7}\u{1F1F7}", file: "pt.json" },
  { code: "fr", iso: "fr-FR", name: "Français", flag: "\u{1F1EB}\u{1F1F7}", file: "fr.json" },
  { code: "ja", iso: "ja-JP", name: "日本語", flag: "\u{1F1EF}\u{1F1F5}", file: "ja.json" },
  { code: "de", iso: "de-DE", name: "Deutsch", flag: "\u{1F1E9}\u{1F1EA}", file: "de.json" },
  { code: "ru", iso: "ru-RU", name: "Русский", flag: "\u{1F1F7}\u{1F1FA}", file: "ru.json" }
] as const;

export const defaultLocale: LocaleCode = "en";

export const pages = [
  "/",
  "/download"
] as const;

/** Pages for sitemap */
export const sitemapPages = [
  "/",
  "/download"
] as const;

/** Generates i18n routes for a given list of pages */
const buildI18nRoutes = (source: readonly string[]): string[] => {
  const routes: string[] = [];
  for (const page of source) {
    routes.push(page);
    for (const locale of supportedLocales) {
      if (locale.code === defaultLocale) continue;
      routes.push(page === "/" ? `/${locale.code}` : `/${locale.code}${page}`);
    }
  }
  return routes;
};

/** All i18n routes (for prerender) */
export const generateI18nRoutes = (): string[] => buildI18nRoutes(pages);

/** i18n routes for sitemap only */
export const generateSitemapRoutes = (): string[] => buildI18nRoutes(sitemapPages);
