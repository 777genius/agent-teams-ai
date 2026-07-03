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
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  cwd?: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
}

export interface PlannedRuntimeMember extends RuntimeLanePlannerMemberInput {
  providerId: TeamProviderId;
}

export const OPEN_CODE_SOLO_MEMBER_NAME = 'solo';
export const OPEN_CODE_SOLO_MEMBER_ROLE = 'Solo OpenCode Agent';

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
      mode: 'pure_opencode_solo';
      primaryMembers: [PlannedRuntimeMember];
      allMembers: [PlannedRuntimeMember];
      sideLanes: [];
      soloMember: PlannedRuntimeMember;
    }
  | {
      mode: 'pure_opencode_worktree_root_lanes';
      primaryMembers: PlannedRuntimeMember[];
      allMembers: PlannedRuntimeMember[];
      sideLanes: {
        laneId: string;
        providerId: 'opencode';
        member: PlannedRuntimeMember;
      }[];
    }
  | {
      mode: 'mixed_opencode_side_lanes';
      primaryMembers: PlannedRuntimeMember[];
      allMembers: PlannedRuntimeMember[];
      sideLanes: {
        laneId: string;
        providerId: 'opencode';
        member: PlannedRuntimeMember;
      }[];
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

export function buildOpenCodeSecondaryLaneId(
  member: Pick<RuntimeLanePlannerMemberInput, 'name'>
): string {
  return `secondary:opencode:${member.name.trim()}`;
}

export function createOpenCodeSoloRuntimeMember(baseCwd?: string): PlannedRuntimeMember {
  const normalizedBaseCwd = baseCwd?.trim();
  return {
    name: OPEN_CODE_SOLO_MEMBER_NAME,
    role: OPEN_CODE_SOLO_MEMBER_ROLE,
    providerId: 'opencode',
    ...(normalizedBaseCwd ? { cwd: normalizedBaseCwd } : {}),
  };
}

export function planTeamRuntimeLanes(params: {
  leadProviderId?: TeamProviderId;
  members: readonly RuntimeLanePlannerMemberInput[];
  baseCwd?: string;
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
          'Mixed teams with an OpenCode lead are not supported in this phase. Keep the team lead on Anthropic or Codex when you mix OpenCode with other providers.',
      };
    }
    const normalizedBaseCwd = params.baseCwd?.trim();
    if (allMembers.length === 0) {
      const soloMember = createOpenCodeSoloRuntimeMember(normalizedBaseCwd);
      return {
        ok: true,
        plan: {
          mode: 'pure_opencode_solo',
          primaryMembers: [soloMember],
          allMembers: [soloMember],
          sideLanes: [],
          soloMember,
        },
      };
    }
    const worktreeRootMembers = allMembers.filter((member) => {
      const memberCwd = member.cwd?.trim();
      return Boolean(memberCwd && (!normalizedBaseCwd || memberCwd !== normalizedBaseCwd));
    });
    if (worktreeRootMembers.length > 0 && allMembers.length > 1) {
      const worktreeRootMemberNames = new Set(worktreeRootMembers.map((member) => member.name));
      return {
        ok: true,
        plan: {
          mode: 'pure_opencode_worktree_root_lanes',
          primaryMembers: allMembers.filter((member) => !worktreeRootMemberNames.has(member.name)),
          allMembers,
          sideLanes: worktreeRootMembers.map((member) => ({
            laneId: buildOpenCodeSecondaryLaneId(member),
            providerId: 'opencode',
            member,
          })),
        },
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

export function isOpenCodeSideLanePlan(
  plan: TeamRuntimeLanePlan
): plan is Extract<
  TeamRuntimeLanePlan,
  { mode: 'mixed_opencode_side_lanes' | 'pure_opencode_worktree_root_lanes' }
> {
  return (
    plan.mode === 'mixed_opencode_side_lanes' || plan.mode === 'pure_opencode_worktree_root_lanes'
  );
}

export function isPureOpenCodeLanePlan(
  plan: TeamRuntimeLanePlan
): plan is Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode' | 'pure_opencode_solo' }> {
  return plan.mode === 'pure_opencode' || plan.mode === 'pure_opencode_solo';
}

export function isPureOpenCodeSoloLanePlan(
  plan: TeamRuntimeLanePlan
): plan is Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_solo' }> {
  return plan.mode === 'pure_opencode_solo';
}

export function isPureOpenCodeWorktreeRootLanePlan(
  plan: TeamRuntimeLanePlan
): plan is Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_worktree_root_lanes' }> {
  return plan.mode === 'pure_opencode_worktree_root_lanes';
}

export function fromProvisioningMembers(
  leadProviderId: TeamProviderId | undefined,
  members: readonly TeamProvisioningMemberInput[],
  options: { baseCwd?: string } = {}
): TeamRuntimeLanePlanResult {
  return planTeamRuntimeLanes({
    leadProviderId,
    baseCwd: options.baseCwd,
    members: members.map((member) => ({
      name: member.name,
      role: member.role,
      workflow: member.workflow,
      isolation: member.isolation,
      cwd: member.cwd,
      providerId: normalizeOptionalTeamProviderId(member.providerId),
      providerBackendId: member.providerBackendId,
      model: member.model,
      effort: member.effort,
      fastMode: member.fastMode,
    })),
  });
}
