import { useEffect, useMemo } from 'react';
import { I18nextProvider } from 'react-i18next';

import { resolveRuntimeLocale } from '../../core/application/resolveRuntimeLocale';
import { normalizeAppLocalePreference } from '../../core/domain/localePolicy';
import { getBrowserSystemLocale } from '../adapters/browserSystemLocaleAdapter';
import { appI18n } from '../composition/createI18nextInstance';

import type { AppConfig } from '@shared/types';

interface LocalizationProviderProps {
  readonly appConfig: AppConfig | null;
  readonly children: React.ReactNode;
}

export const LocalizationProvider = ({
  appConfig,
  children,
}: LocalizationProviderProps): React.JSX.Element => {
  const resolvedLocale = useMemo(
    () =>
      resolveRuntimeLocale({
        preference: normalizeAppLocalePreference(appConfig?.general.appLocale),
        systemLocale: getBrowserSystemLocale(),
      }),
    [appConfig?.general.appLocale]
  );

  useEffect(() => {
    if (appI18n.language !== resolvedLocale) {
      void appI18n.changeLanguage(resolvedLocale);
    }
  }, [resolvedLocale]);

  useEffect(() => {
    document.documentElement.lang = resolvedLocale;
  }, [resolvedLocale]);

  return <I18nextProvider i18n={appI18n}>{children}</I18nextProvider>;
};
