export const TRANSLATION_NAMESPACES = [
  'common',
  'settings',
  'errors',
  'report',
  'dashboard',
  'extensions',
  'team',
] as const;

export type TranslationNamespace = (typeof TRANSLATION_NAMESPACES)[number];

export const DEFAULT_TRANSLATION_NAMESPACE: TranslationNamespace = 'common';
