export type { AppLocalePreference, ResolvedAppLocale, TranslationNamespace } from './contracts';
export {
  APP_LOCALE_PREFERENCES,
  DEFAULT_APP_LOCALE_PREFERENCE,
  FALLBACK_APP_LOCALE,
  isAppLocalePreference,
  isResolvedAppLocale,
  RESOLVED_APP_LOCALES,
  TRANSLATION_NAMESPACES,
} from './contracts';
export { normalizeAppLocalePreference, resolveAppLocale } from './core/domain/localePolicy';
