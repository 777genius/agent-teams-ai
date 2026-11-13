import {
  FALLBACK_APP_LOCALE,
  isAppLocalePreference,
  isResolvedAppLocale,
  RESOLVED_APP_LOCALES,
} from '../../contracts';

import type { AppLocalePreference, ResolvedAppLocale } from '../../contracts';

export interface LocaleResolutionInput {
  readonly preference: unknown;
  readonly systemLocale?: string | null;
  readonly supportedLocales?: readonly ResolvedAppLocale[];
  readonly fallbackLocale?: ResolvedAppLocale;
}

export function normalizeAppLocalePreference(value: unknown): AppLocalePreference {
  return isAppLocalePreference(value) ? value : 'system';
}

export function extractPrimaryLocaleSubtag(locale: string | null | undefined): string | null {
  const trimmed = locale?.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace('_', '-').toLowerCase();
  const primary = normalized.split('-')[0]?.trim();
  return primary || null;
}

export function resolveAppLocale(input: LocaleResolutionInput): ResolvedAppLocale {
  const supportedLocales = input.supportedLocales ?? RESOLVED_APP_LOCALES;
  const fallbackLocale = input.fallbackLocale ?? FALLBACK_APP_LOCALE;
  const preference = normalizeAppLocalePreference(input.preference);

  if (preference !== 'system') {
    return supportedLocales.includes(preference) ? preference : fallbackLocale;
  }

  const systemAppLocale = isTraditionalChineseLocale(input.systemLocale)
    ? 'zh-TW'
    : extractPrimaryLocaleSubtag(input.systemLocale);
  return isResolvedAppLocale(systemAppLocale) && supportedLocales.includes(systemAppLocale)
    ? systemAppLocale
    : fallbackLocale;
}

const TRADITIONAL_CHINESE_REGIONS = new Set(['tw', 'hk', 'mo']);

/** zh-TW, zh-HK, zh-MO and zh-Hant-* use Traditional script unless zh-Hans is explicit. */
export function isTraditionalChineseLocale(locale: string | null | undefined): boolean {
  const subtags = locale?.trim().replaceAll('_', '-').toLowerCase().split('-') ?? [];
  if (subtags[0] !== 'zh' || subtags.includes('hans')) return false;
  return subtags
    .slice(1)
    .some((subtag) => subtag === 'hant' || TRADITIONAL_CHINESE_REGIONS.has(subtag));
}
