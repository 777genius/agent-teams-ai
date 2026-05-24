import {
  extractPrimaryLocaleSubtag,
  normalizeAppLocalePreference,
  resolveAppLocale,
} from '@features/localization/core/domain/localePolicy';
import { describe, expect, it } from 'vitest';

describe('localePolicy', () => {
  it('normalizes unsupported preferences to system', () => {
    expect(normalizeAppLocalePreference('uk')).toBe('system');
    expect(normalizeAppLocalePreference(null)).toBe('system');
    expect(normalizeAppLocalePreference('en')).toBe('en');
    expect(normalizeAppLocalePreference('ru')).toBe('ru');
    expect(normalizeAppLocalePreference('zh')).toBe('zh');
    expect(normalizeAppLocalePreference('ja')).toBe('ja');
    expect(normalizeAppLocalePreference('ko')).toBe('ko');
    expect(normalizeAppLocalePreference('es')).toBe('es');
    expect(normalizeAppLocalePreference('hi')).toBe('hi');
    expect(normalizeAppLocalePreference('pt')).toBe('pt');
    expect(normalizeAppLocalePreference('fr')).toBe('fr');
    expect(normalizeAppLocalePreference('ar')).toBe('ar');
    expect(normalizeAppLocalePreference('bn')).toBe('bn');
    expect(normalizeAppLocalePreference('ur')).toBe('ur');
    expect(normalizeAppLocalePreference('id')).toBe('id');
    expect(normalizeAppLocalePreference('de')).toBe('de');
  });

  it('extracts the primary locale subtag', () => {
    expect(extractPrimaryLocaleSubtag('en-US')).toBe('en');
    expect(extractPrimaryLocaleSubtag('EN_us')).toBe('en');
    expect(extractPrimaryLocaleSubtag('')).toBeNull();
  });

  it('resolves system locale to supported primary locale', () => {
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'en-US' })).toBe('en');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'ru-RU' })).toBe('ru');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'zh-CN' })).toBe('zh');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'ja-JP' })).toBe('ja');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'ko-KR' })).toBe('ko');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'es-ES' })).toBe('es');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'hi-IN' })).toBe('hi');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'pt-BR' })).toBe('pt');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'fr-FR' })).toBe('fr');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'ar-SA' })).toBe('ar');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'bn-BD' })).toBe('bn');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'ur-PK' })).toBe('ur');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'id-ID' })).toBe('id');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'de-DE' })).toBe('de');
  });

  it('falls back when the system locale is not supported yet', () => {
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'uk-UA' })).toBe('en');
  });
});
