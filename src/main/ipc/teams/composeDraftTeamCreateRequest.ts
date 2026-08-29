import type { TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

type DraftLaunchOverrides = Pick<
  TeamCreateRequest,
  | 'teamName'
  | 'cwd'
  | 'providerId'
  | 'providerBackendId'
  | 'effort'
  | 'fastMode'
  | 'allowExperimentalLocalModels'
>;

export function composeDraftTeamCreateRequest(
  saved: TeamCreateRequest,
  payload: Partial<TeamLaunchRequest>,
  overrides: DraftLaunchOverrides,
  providerChanged: boolean
): TeamCreateRequest {
  return {
    teamName: overrides.teamName,
    displayName: saved.displayName,
    description: saved.description,
    color: saved.color,
    cwd: overrides.cwd,
    prompt: typeof payload.prompt === 'string' ? payload.prompt.trim() || undefined : saved.prompt,
    providerId: overrides.providerId,
    executionProof: payload.executionProof,
    leadRuntimeSelectionProvenance:
      payload.leadRuntimeSelectionProvenance ??
      (providerChanged ? undefined : saved.leadRuntimeSelectionProvenance),
    providerBackendId: overrides.providerBackendId,
    model: Object.hasOwn(payload, 'model')
      ? typeof payload.model === 'string'
        ? payload.model.trim() || undefined
        : undefined
      : providerChanged
        ? undefined
        : saved.model,
    effort: overrides.effort,
    fastMode: overrides.fastMode,
    limitContext:
      typeof payload.limitContext === 'boolean'
        ? payload.limitContext
        : providerChanged
          ? undefined
          : saved.limitContext,
    skipPermissions:
      typeof payload.skipPermissions === 'boolean'
        ? payload.skipPermissions
        : saved.skipPermissions,
    allowExperimentalLocalModels: overrides.allowExperimentalLocalModels,
    worktree:
      typeof payload.worktree === 'string' ? payload.worktree.trim() || undefined : saved.worktree,
    extraCliArgs:
      typeof payload.extraCliArgs === 'string'
        ? payload.extraCliArgs.trim() || undefined
        : saved.extraCliArgs,
    members: saved.members,
  };
}
