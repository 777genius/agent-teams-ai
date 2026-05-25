import { useCallback, useMemo } from 'react';

import { Combobox } from '@renderer/components/ui/combobox';
import { Check } from 'lucide-react';

import { APP_LOCALE_PREFERENCES } from '../../contracts';
import { resolveAppLocale } from '../../core/domain/localePolicy';
import { getBrowserSystemLocale } from '../adapters/browserSystemLocaleAdapter';
import { useAppTranslation } from '../hooks/useAppTranslation';

import type { AppLocalePreference } from '../../contracts';

interface AppLanguageSelectProps {
  readonly value: AppLocalePreference;
  readonly disabled?: boolean;
  readonly onValueChange: (value: AppLocalePreference) => void;
}

export const AppLanguageSelect = ({
  value,
  disabled = false,
  onValueChange,
}: AppLanguageSelectProps): React.JSX.Element => {
  const { t } = useAppTranslation('common');
  const systemLocale = getBrowserSystemLocale();
  const resolvedSystemLocale = resolveAppLocale({ preference: 'system', systemLocale });
  const options = useMemo(
    () =>
      APP_LOCALE_PREFERENCES.map((preference) => ({
        label:
          preference === 'system'
            ? t('locales.systemWithResolved', {
                locale: t(`locales.names.${resolvedSystemLocale}`),
              })
            : t(`locales.names.${preference}`),
        value: preference,
      })),
    [resolvedSystemLocale, t]
  );

  const renderOption = useCallback(
    (option: { value: string; label: string }, isSelected: boolean) => (
      <>
        <Check className={`mr-2 size-3.5 shrink-0 ${isSelected ? 'opacity-100' : 'opacity-0'}`} />
        <span className="text-[var(--color-text)]">{option.label}</span>
      </>
    ),
    []
  );

  return (
    <Combobox
      options={options}
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as AppLocalePreference)}
      placeholder={t('locales.selectPlaceholder')}
      searchPlaceholder={t('locales.searchPlaceholder')}
      emptyMessage={t('locales.emptyMessage')}
      disabled={disabled}
      className="min-w-[180px]"
      renderOption={renderOption}
    />
  );
};
