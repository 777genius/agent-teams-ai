import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';

import { resolvePersistedLeadRuntimeRoute } from './teamProviderBackendResolution';

import type { TeamMembersMetaFile } from './TeamMembersMetaStore';
import type { TeamMetaFile } from './TeamMetaStore';
import type { TeamCreateRequest } from '@shared/types';

export function buildSavedTeamCreateRequest(
  teamName: string,
  meta: TeamMetaFile,
  membersMeta: TeamMembersMetaFile | null
): TeamCreateRequest {
  const launchIdentity = meta.launchIdentity;
  const savedRoute = resolvePersistedLeadRuntimeRoute(meta);
  const leadRuntimeSelectionProvenance =
    meta.leadRuntimeSelectionProvenance ??
    (launchIdentity
      ? {
          version: 1 as const,
          providerBackendId:
            savedRoute.providerId !== 'anthropic' && savedRoute.providerBackendId
              ? ('explicit' as const)
              : ('default' as const),
          model: launchIdentity.selectedModelKind,
          effort: launchIdentity.selectedEffort ? ('explicit' as const) : ('default' as const),
        }
      : undefined);
  return {
    teamName,
    displayName: meta.displayName,
    description: meta.description,
    color: meta.color,
    cwd: meta.cwd,
    prompt: meta.prompt,
    providerId: savedRoute.providerId ?? 'anthropic',
    providerBackendId: savedRoute.providerBackendId,
    leadRuntimeSelectionProvenance,
    model: launchIdentity
      ? launchIdentity.selectedModelKind === 'explicit'
        ? (launchIdentity.selectedModel ?? undefined)
        : undefined
      : meta.model,
    effort: (launchIdentity?.selectedEffort ?? meta.effort) as TeamCreateRequest['effort'],
    fastMode: launchIdentity?.selectedFastMode ?? meta.fastMode,
    skipPermissions: meta.skipPermissions,
    worktree: meta.worktree,
    extraCliArgs: meta.extraCliArgs,
    limitContext: meta.limitContext,
    members: (membersMeta?.members ?? [])
      .filter((member) => !member.removedAt)
      .map((member) => ({
        name: member.name,
        role: member.role,
        workflow: member.workflow,
        isolation: member.isolation,
        cwd: member.cwd,
        providerId: member.providerId,
        providerBackendId: member.providerBackendId,
        model: member.model,
        effort: member.effort,
        runtimeSelectionProvenance: member.runtimeSelectionProvenance,
        fastMode: member.fastMode,
        mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
      })),
  };
}
