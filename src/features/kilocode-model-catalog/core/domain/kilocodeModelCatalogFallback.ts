import type { KilocodeModelCatalogItemDto } from '../../contracts';

export function createStaticKilocodeModelCatalogModels(): KilocodeModelCatalogItemDto[] {
  return [
    {
      id: 'claude-sonnet-4-5',
      launchModel: 'claude-sonnet-4-5',
      displayName: 'Claude Sonnet 4.5',
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ['text'],
      supportsPersonality: false,
      isDefault: true,
      upgrade: false,
      source: 'static-fallback',
    },
    {
      id: 'claude-opus-4-5',
      launchModel: 'claude-opus-4-5',
      displayName: 'Claude Opus 4.5',
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ['text'],
      supportsPersonality: false,
      isDefault: false,
      upgrade: false,
      source: 'static-fallback',
    },
  ];
}
