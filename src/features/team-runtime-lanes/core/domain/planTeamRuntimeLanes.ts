import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type {
  EffortLevel,
  TeamFastMode,
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningMemberInput,
} from '@shared/types';

export interface RuntimeLanePlannerMemberInput {
  name: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
}

export interface PlannedRuntimeMember extends RuntimeLanePlannerMemberInput {
  providerId: TeamProviderId;
}

export interface PlannedTeamMemberLaneIdentity {
  laneId: string;
  laneKind: 'primary' | 'secondary';
  laneOwnerProviderId: TeamProviderId;
}

export type TeamRuntimeLanePlan =
  | {
      mode: 'primary_only';
      primaryMembers: PlannedRuntimeMember[];
      allMembers: PlannedRuntimeMember[];
      sideLanes: [];
    }
  | {
      mode: 'pure_opencode';
      primaryMembers: PlannedRuntimeMember[];
      allMembers: PlannedRuntimeMember[];
      sideLanes: [];
    }
  | {
      mode: 'mixed_opencode_side_lanes';
      primaryMembers: PlannedRuntimeMember[];
      allMembers: PlannedRuntimeMember[];
      sideLanes: Array<{
        laneId: string;
        providerId: 'opencode';
        member: PlannedRuntimeMember;
      }>;
    };

export type TeamRuntimeLanePlanErrorReason = 'unsupported_opencode_led_mixed_team';

export interface TeamRuntimeLanePlanError {
  ok: false;
  reason: TeamRuntimeLanePlanErrorReason;
  message: string;
}

export interface TeamRuntimeLanePlanSuccess {
  ok: true;
  plan: TeamRuntimeLanePlan;
}

export type TeamRuntimeLanePlanResult = TeamRuntimeLanePlanSuccess | TeamRuntimeLanePlanError;

function normalizeLeadProviderId(providerId: TeamProviderId | undefined): TeamProviderId {
  return normalizeOptionalTeamProviderId(providerId) ?? 'anthropic';
}

function normalizePlannedMembers(
  members: readonly RuntimeLanePlannerMemberInput[],
  leadProviderId: TeamProviderId
): PlannedRuntimeMember[] {
  return members
    .map((member) => ({
      ...member,
      name: member.name.trim(),
      providerId: normalizeOptionalTeamProviderId(member.providerId) ?? leadProviderId,
    }))
    .filter((member) => member.name.length > 0);
}

export function buildPlannedMemberLaneIdentity(params: {
  leadProviderId?: TeamProviderId;
  member: Pick<RuntimeLanePlannerMemberInput, 'name' | 'providerId'>;
}): PlannedTeamMemberLaneIdentity {
  const leadProviderId = normalizeLeadProviderId(params.leadProviderId);
  const memberProviderId =
    normalizeOptionalTeamProviderId(params.member.providerId) ?? leadProviderId;
  const trimmedName = params.member.name.trim();

  if (leadProviderId !== 'opencode' && memberProviderId === 'opencode') {
    return {
      laneId: `secondary:opencode:${trimmedName}`,
      laneKind: 'secondary',
      laneOwnerProviderId: 'opencode',
    };
  }

  return {
    laneId: 'primary',
    laneKind: 'primary',
    laneOwnerProviderId: leadProviderId,
  };
}

export function planTeamRuntimeLanes(params: {
  leadProviderId?: TeamProviderId;
  members: readonly RuntimeLanePlannerMemberInput[];
}): TeamRuntimeLanePlanResult {
  const leadProviderId = normalizeLeadProviderId(params.leadProviderId);
  const allMembers = normalizePlannedMembers(params.members, leadProviderId);
  const openCodeMembers = allMembers.filter((member) => member.providerId === 'opencode');

  if (leadProviderId === 'opencode') {
    const nonOpenCodeMembers = allMembers.filter((member) => member.providerId !== 'opencode');
    if (nonOpenCodeMembers.length > 0) {
      return {
        ok: false,
        reason: 'unsupported_opencode_led_mixed_team',
        message:
          'Mixed teams with an OpenCode lead are not supported in this phase. Keep the team lead on Anthropic, Codex, or Gemini when you mix OpenCode with other providers.',
      };
    }
    return {
      ok: true,
      plan: {
        mode: 'pure_opencode',
        primaryMembers: allMembers,
        allMembers,
        sideLanes: [],
      },
    };
  }

  if (openCodeMembers.length === 0) {
    return {
      ok: true,
      plan: {
        mode: 'primary_only',
        primaryMembers: allMembers,
        allMembers,
        sideLanes: [],
      },
    };
  }
  return {
    ok: true,
    plan: {
      mode: 'mixed_opencode_side_lanes',
      primaryMembers: allMembers.filter((member) => member.providerId !== 'opencode'),
      allMembers,
      sideLanes: openCodeMembers.map((member) => ({
        laneId: buildPlannedMemberLaneIdentity({
          leadProviderId,
          member,
        }).laneId,
        providerId: 'opencode',
        member,
      })),
    },
  };
}

export function isMixedOpenCodeSideLanePlan(
  plan: TeamRuntimeLanePlan
): plan is Extract<TeamRuntimeLanePlan, { mode: 'mixed_opencode_side_lanes' }> {
  return plan.mode === 'mixed_opencode_side_lanes';
}

export function isPureOpenCodeLanePlan(
  plan: TeamRuntimeLanePlan
): plan is Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode' }> {
  return plan.mode === 'pure_opencode';
}

export function fromProvisioningMembers(
  leadProviderId: TeamProviderId | undefined,
  members: readonly TeamProvisioningMemberInput[]
): TeamRuntimeLanePlanResult {
  return planTeamRuntimeLanes({
    leadProviderId,
    members: members.map((member) => ({
      name: member.name,
      providerId: normalizeOptionalTeamProviderId(member.providerId),
      providerBackendId: member.providerBackendId,
      model: member.model,
      effort: member.effort,
      fastMode: member.fastMode,
    })),
  });
}
