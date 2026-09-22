import { RESOLVED_APP_LOCALES, TRANSLATION_NAMESPACES } from '../../contracts';

import type { ResolvedAppLocale, TranslationNamespace } from '../../contracts';

type TranslationResource = Record<string, unknown>;
type TranslationResources = Record<
  ResolvedAppLocale,
  Record<TranslationNamespace, TranslationResource>
>;

const catalogModules = import.meta.glob<TranslationResource>('../locales/*/*.json', {
  eager: true,
  import: 'default',
});

export const localizationResources = buildLocalizationResources();

function buildLocalizationResources(): TranslationResources {
  const resources = {} as TranslationResources;

  for (const locale of RESOLVED_APP_LOCALES) {
    resources[locale] = {} as Record<TranslationNamespace, TranslationResource>;

    for (const namespace of TRANSLATION_NAMESPACES) {
      const resource = catalogModules[`../locales/${locale}/${namespace}.json`];
      if (!resource) {
        throw new Error(`Missing i18n catalog: ${locale}/${namespace}.json`);
      }
      resources[locale][namespace] = resource;
    }
  }

  return resources;
}
