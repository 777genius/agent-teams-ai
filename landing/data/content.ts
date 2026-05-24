import en from '~/content/en.json';
import ru from '~/content/ru.json';
import zh from '~/content/zh.json';
import es from '~/content/es.json';
import hi from '~/content/hi.json';
import ar from '~/content/ar.json';
import pt from '~/content/pt.json';
import fr from '~/content/fr.json';
import ja from '~/content/ja.json';
import ko from '~/content/ko.json';
import de from '~/content/de.json';
import bn from '~/content/bn.json';
import ur from '~/content/ur.json';
import id from '~/content/id.json';
import type { LandingContent, LocalizedContent } from '~/types/content';
import type { LocaleCode } from '~/data/i18n';

export const contentByLocale: LocalizedContent = {
  en,
  ru,
  zh,
  es,
  hi,
  ar,
  pt,
  fr,
  ja,
  ko,
  de,
  bn,
  ur,
  id,
};

export const getContent = (locale: LocaleCode): LandingContent => {
  return contentByLocale[locale] ?? contentByLocale.en;
};
