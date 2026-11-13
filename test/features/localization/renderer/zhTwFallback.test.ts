import { createI18nextInstance } from '@features/localization/renderer/composition/createI18nextInstance';
import { describe, expect, it } from 'vitest';

describe('zh-TW locale', () => {
  it('serves zh-TW catalog strings', () => {
    const i18n = createI18nextInstance('zh-TW');
    expect(i18n.language).toBe('zh-TW');
    expect(i18n.t('locales.names.zh-TW')).toBe('繁體中文');
  });

  it('falls back to English, not Simplified Chinese, for keys missing from zh-TW', () => {
    const i18n = createI18nextInstance('zh-TW');
    i18n.addResource('en', 'common', 'zhTwFallbackProbe', 'English value');
    i18n.addResource('zh', 'common', 'zhTwFallbackProbe', '简体值');

    expect(i18n.t('zhTwFallbackProbe' as never)).toBe('English value');
  });
});
