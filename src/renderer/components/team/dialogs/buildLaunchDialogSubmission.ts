import { buildMembersFromDrafts } from '@renderer/components/team/members/MembersEditorSection';
import { resolveUiOwnedProviderBackendId } from '@renderer/utils/providerBackendIdentity';

import { computeEffectiveTeamModel } from './TeamModelSelector';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type {
  CliProviderStatus,
  EffortLevel,
  TeamFastMode,
  TeamLaunchRequest,
  TeamProviderId,
} from '@shared/types';

/** Fresh Launch and unchanged-form Resume inspect the same existing dialog choices. */
export function buildLaunchDialogSubmission(input: {
  teamName: string;
  cwd: string;
  prompt: string;
  providerId: TeamProviderId;
  providerBackendId?: TeamLaunchRequest['providerBackendId'];
  providerStatus?: CliProviderStatus;
  model: string;
  effort: string;
  fastMode: TeamFastMode;
  syncModelsWithLead?: boolean;
  limitContext: boolean;
  skipPermissions: boolean;
  allowExperimentalLocalModels: boolean;
  worktreeEnabled: boolean;
  worktreeName: string;
  customArgs: string;
  members: MemberDraft[];
}) {
  const request: TeamLaunchRequest = {
    teamName: input.teamName,
    cwd: input.cwd,
    prompt: input.prompt.trim() || undefined,
    providerId: input.providerId,
    providerBackendId:
      resolveUiOwnedProviderBackendId(input.providerId, input.providerStatus) ??
      input.providerBackendId ??
      undefined,
    model: computeEffectiveTeamModel(
      input.model,
      input.limitContext,
      input.providerId,
      input.providerStatus
    ),
    effort: (input.effort as EffortLevel) || undefined,
    fastMode:
      input.providerId === 'anthropic' || input.providerId === 'codex' ? input.fastMode : undefined,
    syncModelsWithLead: input.syncModelsWithLead,
    limitContext: input.limitContext,
    skipPermissions: input.skipPermissions,
    allowExperimentalLocalModels: input.allowExperimentalLocalModels || undefined,
    worktree:
      input.worktreeEnabled && input.worktreeName.trim() ? input.worktreeName.trim() : undefined,
    extraCliArgs: input.customArgs.trim() || undefined,
  };
  return {
    request,
    members: buildMembersFromDrafts(input.members, { inheritedProviderId: input.providerId }),
  };
}
