import type { MemberSettingsTarget } from '../../contracts/memberSettings';
import type { ResolvedTeamMember } from '@shared/types';

function joinedAtOf(value: MemberSettingsTarget['joinedAt']): number | undefined {
  if (typeof value === 'number') return value;
  const numeric = value?.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * A saved member target (for example of a per-project team definition, which
 * has no runtime snapshot) shown by the settings editor. Its settings are the
 * configured ones, so the editor's fingerprint of this member is the one the
 * settings mutation compares.
 */
export function memberSettingsTargetToMember(target: MemberSettingsTarget): ResolvedTeamMember {
  const { settings } = target;
  const providerId = settings.providerId ?? undefined;
  const providerBackendId = settings.providerBackendId ?? undefined;
  const model = settings.model ?? undefined;
  const effort = settings.effort ?? undefined;
  const fastMode = settings.fastMode ?? undefined;
  return {
    name: target.name,
    status: 'unknown',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
    agentType: target.agentType ?? undefined,
    agentId: target.agentId ?? undefined,
    joinedAt: joinedAtOf(target.joinedAt),
    role: settings.role ?? undefined,
    workflow: settings.workflow ?? undefined,
    isolation: settings.isolation ?? undefined,
    providerId,
    providerBackendId,
    model,
    effort,
    selectedFastMode: fastMode,
    mcpPolicy: settings.mcpPolicy ?? undefined,
    configuredRuntimeSettings: { providerId, providerBackendId, model, effort, fastMode },
  };
}
