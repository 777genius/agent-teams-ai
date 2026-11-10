import { defineConfig } from 'i18next-cli';

import {
  DEFAULT_TRANSLATION_NAMESPACE,
  FALLBACK_APP_LOCALE,
  RESOLVED_APP_LOCALES,
} from './src/features/localization/contracts';

export default defineConfig({
  locales: [...RESOLVED_APP_LOCALES],
  extract: {
    defaultNS: DEFAULT_TRANSLATION_NAMESPACE,
    input: ['src/**/*.{ts,tsx}'],
    ignore: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**'],
    output: 'src/features/localization/renderer/locales/{{language}}/{{namespace}}.json',
    primaryLanguage: FALLBACK_APP_LOCALE,
    sort: true,
    useTranslationNames: ['useTranslation', { name: 'useAppTranslation', nsArg: 0 }],
  },
  lint: {
    ignore: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**'],
  },
  types: {
    basePath: `src/features/localization/renderer/locales/${FALLBACK_APP_LOCALE}`,
    input: [`src/features/localization/renderer/locales/${FALLBACK_APP_LOCALE}/*.json`],
    output: 'src/features/localization/renderer/i18next.d.ts',
    resourcesFile: 'src/features/localization/renderer/resources.d.ts',
  },
});
