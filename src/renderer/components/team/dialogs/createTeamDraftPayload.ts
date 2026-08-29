import type { TeamCreateConfigRequest, TeamCreateRequest } from '@shared/types';

export function createTeamDraftPayload(
  request: TeamCreateRequest,
  effectiveCwd: string
): TeamCreateConfigRequest {
  return {
    teamName: request.teamName,
    displayName: request.displayName,
    description: request.description,
    color: request.color,
    members: request.members,
    cwd: effectiveCwd || undefined,
    prompt: request.prompt,
    providerId: request.providerId,
    leadRuntimeSelectionProvenance: request.leadRuntimeSelectionProvenance,
    providerBackendId: request.providerBackendId,
    model: request.model,
    effort: request.effort,
    fastMode: request.fastMode,
    limitContext: request.limitContext,
    skipPermissions: request.skipPermissions,
    worktree: request.worktree,
    extraCliArgs: request.extraCliArgs,
  };
}
