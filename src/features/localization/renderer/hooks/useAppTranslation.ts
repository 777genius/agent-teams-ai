import { useTranslation } from 'react-i18next';

import type { TranslationNamespace } from '../../contracts';
import type { TFunction } from 'i18next';

export interface AppTranslationApi {
  readonly t: TFunction<TranslationNamespace, undefined>;
  readonly resolvedLanguage: string | undefined;
}

export function useAppTranslation(namespace: TranslationNamespace): AppTranslationApi {
  const { i18n, t } = useTranslation(namespace);
  return {
    t,
    resolvedLanguage: i18n.resolvedLanguage,
  };
}
