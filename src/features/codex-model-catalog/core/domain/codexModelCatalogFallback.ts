import type { CliProviderModelCatalogItem, CliProviderReasoningEffort } from '@shared/types';

const DEFAULT_CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
const MINI_CODEX_EFFORTS = ['medium', 'high'] as const;

function createFallbackModel(options: {
  id: string;
  displayName: string;
  badgeLabel: string;
  isDefault?: boolean;
  efforts?: readonly CliProviderReasoningEffort[];
  defaultEffort?: CliProviderReasoningEffort;
}): CliProviderModelCatalogItem {
  const efforts = [...(options.efforts ?? DEFAULT_CODEX_EFFORTS)];
  return {
    id: options.id,
    launchModel: options.id,
    displayName: options.displayName,
    hidden: false,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: options.defaultEffort ?? 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    isDefault: options.isDefault === true,
    upgrade: false,
    source: 'static-fallback',
    badgeLabel: options.badgeLabel,
  };
}

export function createStaticCodexModelCatalogModels(): CliProviderModelCatalogItem[] {
  return [
    createFallbackModel({
      id: 'gpt-5.4',
      displayName: 'GPT-5.4',
      badgeLabel: '5.4',
      isDefault: true,
    }),
    createFallbackModel({
      id: 'gpt-5.4-mini',
      displayName: 'GPT-5.4 Mini',
      badgeLabel: '5.4-mini',
    }),
    createFallbackModel({
      id: 'gpt-5.3-codex',
      displayName: 'GPT-5.3 Codex',
      badgeLabel: '5.3-codex',
    }),
    createFallbackModel({
      id: 'gpt-5.2',
      displayName: 'GPT-5.2',
      badgeLabel: '5.2',
    }),
    createFallbackModel({
      id: 'gpt-5.1-codex-mini',
      displayName: 'GPT-5.1 Codex Mini',
      badgeLabel: '5.1-codex-mini',
      efforts: MINI_CODEX_EFFORTS,
    }),
  ];
}
