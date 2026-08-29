import type {
  EffortLevel,
  ProviderModelLaunchIdentity,
  TeamFastMode,
  TeamProviderBackendId,
} from '@shared/types';

interface OpenCodeLaunchMember {
  model?: string;
  effort?: EffortLevel;
  launchIdentity?: ProviderModelLaunchIdentity;
}

export function projectOpenCodePersistedLaunchIdentity(
  member: OpenCodeLaunchMember,
  evidenceModel?: string
): {
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  selectedFastMode?: TeamFastMode;
  launchIdentity?: ProviderModelLaunchIdentity;
} {
  const launchIdentity = member.launchIdentity;
  return {
    providerBackendId: launchIdentity?.providerBackendId ?? undefined,
    model:
      evidenceModel?.trim() ??
      launchIdentity?.resolvedLaunchModel ??
      launchIdentity?.selectedModel ??
      member.model?.trim() ??
      undefined,
    effort: launchIdentity?.resolvedEffort ?? launchIdentity?.selectedEffort ?? member.effort,
    selectedFastMode: launchIdentity?.selectedFastMode ?? undefined,
    launchIdentity,
  };
}
