import enTeam from '@features/localization/renderer/locales/en/team.json';
import ruTeam from '@features/localization/renderer/locales/ru/team.json';
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Minimal real i18next instance over the shipped catalogs. */
async function translator(lng: string): Promise<Translate> {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    defaultNS: 'team',
    ns: ['team'],
    resources: {
      en: { team: enTeam },
      ru: { team: ruTeam },
    },
    interpolation: { escapeValue: false },
  });
  // The app-wide CustomTypeOptions augmentation targets the composed instance;
  // this test harness resolves keys against the raw shipped catalogs instead.
  return instance.t as unknown as Translate;
}

describe('custom template count-based messages', () => {
  it('selects the English singular and plural forms from the count option', async () => {
    const t = await translator('en');

    expect(t('customTemplates.library.unreadableRecords', { count: 1 })).toBe(
      '1 stored template could not be read and is missing from this list.'
    );
    expect(t('customTemplates.library.unreadableRecords', { count: 3 })).toBe(
      '3 stored templates could not be read and are missing from this list.'
    );
    expect(t('customTemplates.warnings.removedMembersExcluded', { count: 1 })).toBe(
      '1 removed team member was excluded.'
    );
    expect(t('customTemplates.warnings.removedMembersExcluded', { count: 12 })).toBe(
      '12 removed team members were excluded.'
    );
  });

  it('selects the Russian one/few/many forms from the count option', async () => {
    const t = await translator('ru');
    const unreadable = (count: number): string =>
      t('customTemplates.library.unreadableRecords', { count });
    const excluded = (count: number): string =>
      t('customTemplates.warnings.removedMembersExcluded', { count });

    // Nominative singular for 1 and 21, genitive singular for 2–4, genitive
    // plural for 5+ — the forms i18next's Russian plural rule must pick.
    expect(unreadable(1)).toBe(
      '1 сохранённый шаблон не удалось прочитать, и его нет в этом списке.'
    );
    expect(unreadable(2)).toBe(
      '2 сохранённых шаблона не удалось прочитать, и их нет в этом списке.'
    );
    expect(unreadable(5)).toBe(
      '5 сохранённых шаблонов не удалось прочитать, и их нет в этом списке.'
    );
    expect(unreadable(21)).toBe(
      '21 сохранённый шаблон не удалось прочитать, и его нет в этом списке.'
    );

    expect(excluded(1)).toBe('Исключён 1 удалённый участник.');
    expect(excluded(3)).toBe('Исключено 3 удалённых участника.');
    expect(excluded(7)).toBe('Исключено 7 удалённых участников.');
    expect(excluded(22)).toBe('Исключено 22 удалённых участника.');
  });

  it('falls back to English when a locale lacks the message', async () => {
    const t = await translator('de');
    expect(t('customTemplates.library.unreadableRecords', { count: 1 })).toBe(
      '1 stored template could not be read and is missing from this list.'
    );
  });
});
