import { initReactI18next } from 'react-i18next';

import i18next from 'i18next';

import {
  DEFAULT_TRANSLATION_NAMESPACE,
  FALLBACK_APP_LOCALE,
  RESOLVED_APP_LOCALES,
  TRANSLATION_NAMESPACES,
} from '../../contracts';

import { localizationResources } from './localizationResources';

export function createI18nextInstance(initialLocale = FALLBACK_APP_LOCALE): typeof i18next {
  const instance = i18next.createInstance();

  void instance.use(initReactI18next).init({
    debug: false,
    defaultNS: DEFAULT_TRANSLATION_NAMESPACE,
    fallbackLng: FALLBACK_APP_LOCALE,
    initAsync: false,
    interpolation: {
      escapeValue: false,
    },
    lng: initialLocale,
    ns: [...TRANSLATION_NAMESPACES],
    resources: localizationResources,
    returnEmptyString: false,
    supportedLngs: [...RESOLVED_APP_LOCALES],
  });

  return instance;
}

export const appI18n = createI18nextInstance();
