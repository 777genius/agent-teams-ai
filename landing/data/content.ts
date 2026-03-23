import en from "~/content/en.json";
import ru from "~/content/ru.json";
import zh from "~/content/zh.json";
import es from "~/content/es.json";
import hi from "~/content/hi.json";
import ar from "~/content/ar.json";
import pt from "~/content/pt.json";
import type { LandingContent, LocalizedContent } from "~/types/content";
import type { LocaleCode } from "~/data/i18n";

export const contentByLocale: LocalizedContent = {
  en,
  ru,
  zh,
  es,
  hi,
  ar,
  pt
};

export const getContent = (locale: LocaleCode): LandingContent => {
  return contentByLocale[locale] ?? contentByLocale.en;
};
