import type { CapturedCodexMetadata } from './capturedCodexMetadata';
import type { CliProviderModelCatalog, CliProviderReasoningEffort } from '@shared/types';

const knownEfforts: CliProviderReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

export function projectCapturedCodexCatalog(
  value: CapturedCodexMetadata,
  includeHidden: boolean
): CliProviderModelCatalog {
  const models = value.models
    .filter((model) => includeHidden || !model.hidden)
    .map((model) => ({
      id: model.id,
      launchModel: model.model,
      displayName: model.displayName,
      hidden: model.hidden,
      supportedReasoningEfforts: model.supportedReasoningEfforts.filter(
        (effort): effort is CliProviderReasoningEffort =>
          knownEfforts.includes(effort as CliProviderReasoningEffort)
      ),
      defaultReasoningEffort: knownEfforts.includes(
        model.defaultReasoningEffort as CliProviderReasoningEffort
      )
        ? (model.defaultReasoningEffort as CliProviderReasoningEffort)
        : null,
      inputModalities: [...model.inputModalities],
      supportsPersonality: model.supportsPersonality,
      isDefault:
        model.model === value.configuration.model || model.id === value.configuration.model,
      upgrade: false,
      source: 'app-server' as const,
    }));
  const selected =
    models.find((model) => model.isDefault) ??
    models.find((model) => value.models.find((native) => native.id === model.id)?.isDefault);
  const now = Date.now();
  return {
    schemaVersion: 1,
    providerId: 'codex',
    source: 'app-server',
    status: models.length ? 'ready' : 'unavailable',
    fetchedAt: new Date(now).toISOString(),
    staleAt: new Date(now + 30000).toISOString(),
    defaultModelId: selected?.id ?? null,
    defaultLaunchModel: selected?.launchModel ?? null,
    models,
    diagnostics: { appServerState: 'healthy', configReadState: 'ready' },
  };
}
