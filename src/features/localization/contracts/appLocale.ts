export const APP_LOCALE_PREFERENCES = [
  'system',
  'en',
  'ru',
  'zh',
  'ja',
  'ko',
  'es',
  'hi',
  'pt',
  'fr',
  'ar',
  'bn',
  'ur',
  'id',
  'de',
] as const;

export const RESOLVED_APP_LOCALES = [
  'en',
  'ru',
  'zh',
  'ja',
  'ko',
  'es',
  'hi',
  'pt',
  'fr',
  'ar',
  'bn',
  'ur',
  'id',
  'de',
] as const;

export type AppLocalePreference = (typeof APP_LOCALE_PREFERENCES)[number];

export type ResolvedAppLocale = (typeof RESOLVED_APP_LOCALES)[number];

export const DEFAULT_APP_LOCALE_PREFERENCE: AppLocalePreference = 'system';

export const FALLBACK_APP_LOCALE: ResolvedAppLocale = 'en';

export function isAppLocalePreference(value: unknown): value is AppLocalePreference {
  return typeof value === 'string' && APP_LOCALE_PREFERENCES.includes(value as AppLocalePreference);
}

export function isResolvedAppLocale(value: unknown): value is ResolvedAppLocale {
  return typeof value === 'string' && RESOLVED_APP_LOCALES.includes(value as ResolvedAppLocale);
}
