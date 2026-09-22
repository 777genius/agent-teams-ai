import {
  extractPrimaryLocaleSubtag,
  normalizeAppLocalePreference,
  resolveAppLocale,
} from '@features/localization/core/domain/localePolicy';
import { describe, expect, it } from 'vitest';

describe('localePolicy', () => {
  it('normalizes unsupported preferences to system', () => {
    expect(normalizeAppLocalePreference('sv')).toBe('system');
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
    expect(normalizeAppLocalePreference('it')).toBe('it');
    expect(normalizeAppLocalePreference('tr')).toBe('tr');
    expect(normalizeAppLocalePreference('vi')).toBe('vi');
    expect(normalizeAppLocalePreference('pl')).toBe('pl');
    expect(normalizeAppLocalePreference('fa')).toBe('fa');
    expect(normalizeAppLocalePreference('th')).toBe('th');
    expect(normalizeAppLocalePreference('uk')).toBe('uk');
    expect(normalizeAppLocalePreference('nl')).toBe('nl');
    expect(normalizeAppLocalePreference('ta')).toBe('ta');
    expect(normalizeAppLocalePreference('te')).toBe('te');
    expect(normalizeAppLocalePreference('mr')).toBe('mr');
    expect(normalizeAppLocalePreference('fil')).toBe('fil');
    expect(normalizeAppLocalePreference('ms')).toBe('ms');
    expect(normalizeAppLocalePreference('sw')).toBe('sw');
    expect(normalizeAppLocalePreference('ro')).toBe('ro');
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
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'it-IT' })).toBe('it');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'tr-TR' })).toBe('tr');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'vi-VN' })).toBe('vi');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'pl-PL' })).toBe('pl');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'fa-IR' })).toBe('fa');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'th-TH' })).toBe('th');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'uk-UA' })).toBe('uk');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'nl-NL' })).toBe('nl');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'ta-IN' })).toBe('ta');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'te-IN' })).toBe('te');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'mr-IN' })).toBe('mr');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'fil-PH' })).toBe('fil');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'ms-MY' })).toBe('ms');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'sw-KE' })).toBe('sw');
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'ro-RO' })).toBe('ro');
  });

  it('falls back when the system locale is not supported yet', () => {
    expect(resolveAppLocale({ preference: 'system', systemLocale: 'sv-SE' })).toBe('en');
  });
});
