import { parseLegacyMemberKey, parseMemberId, parseTeamId } from '@shared/contracts/hosted';

import {
  CompositeRuntimePlanValidationError,
  createCompositeRuntimePlan,
  type CreateCompositeRuntimePlanInput,
} from './createCompositeRuntimePlan';

import type { CompositeRuntimePlan, RuntimePlanMemberBinding } from '../../../contracts';
import type {
  PersistedTeamRosterPlanMember,
  PersistedTeamRosterPlanSource,
} from '../ports/PersistedTeamRosterPlanSource';
import type { PlannedRuntimeMember, TeamRuntimeLanePlanResult } from '@features/team-runtime-lanes';

export type CreateRuntimePlanFromPersistedRosterInput = Omit<
  CreateCompositeRuntimePlanInput,
  'memberBindings' | 'rosterGeneration'
>;

export class CreateRuntimePlanFromPersistedRoster {
  constructor(private readonly rosterSource: PersistedTeamRosterPlanSource) {}

  async execute(input: CreateRuntimePlanFromPersistedRosterInput): Promise<CompositeRuntimePlan> {
    let teamId;
    try {
      teamId = parseTeamId(input.teamId);
    } catch {
      fail('persisted_roster_mismatch', 'runtime-plan-team-identity-invalid');
    }
    const roster = await this.rosterSource.getPersistedTeamRoster(teamId);
    if (!roster) {
      fail('persisted_roster_missing', 'runtime-plan-persisted-roster-missing');
    }
    let persistedTeamId;
    try {
      persistedTeamId = parseTeamId(roster.teamId);
    } catch {
      fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-invalid');
    }
    if (
      persistedTeamId !== teamId ||
      !Number.isSafeInteger(roster.rosterGeneration) ||
      roster.rosterGeneration < 1
    ) {
      fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-invalid');
    }

    const memberBindings = bindPersistedRosterMembers(input.lanePlanResult, roster.members);
    return createCompositeRuntimePlan({
      ...input,
      rosterGeneration: roster.rosterGeneration,
      memberBindings,
    });
  }
}

function bindPersistedRosterMembers(
  lanePlanResult: TeamRuntimeLanePlanResult,
  rosterMembers: unknown
): readonly RuntimePlanMemberBinding[] {
  const activeRosterMembers = validatePersistedRosterMembers(rosterMembers).filter(
    (member) => member.state === 'active'
  );
  if (!lanePlanResult.ok) {
    fail('lane_plan_rejected', 'runtime-plan-lane-planner-rejected');
  }
  const plannedMembers = lanePlanResult.plan.allMembers;
  const rosterByKey = new Map(
    activeRosterMembers.map((member) => [member.legacyMemberKey, member])
  );
  if (plannedMembers.length !== activeRosterMembers.length) {
    fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-member-count-mismatch');
  }
  const secondaryLaneByMemberKey = new Map(
    lanePlanResult.plan.sideLanes.map((lane) => [lane.member.name, lane.laneId])
  );
  return Object.freeze(
    plannedMembers.map((plannedMember) => {
      const plannedMemberKey = validatePlannedMember(plannedMember);
      const rosterMember = rosterByKey.get(plannedMemberKey);
      if (
        rosterMember?.providerId !== plannedMember.providerId ||
        rosterMember.model !== (plannedMember.model ?? null) ||
        rosterMember.role !== (plannedMember.role ?? null) ||
        rosterMember.workflow !== (plannedMember.workflow ?? null) ||
        rosterMember.isolation !== (plannedMember.isolation ?? null)
      ) {
        fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-member-mismatch');
      }
      return Object.freeze({
        memberId: rosterMember.memberId,
        memberRevision: rosterMember.memberRevision,
        legacyMemberKey: rosterMember.legacyMemberKey,
        providerId: rosterMember.providerId,
        laneId: secondaryLaneByMemberKey.get(plannedMemberKey) ?? 'primary',
        policy: 'required',
      }) as RuntimePlanMemberBinding;
    })
  );
}

function validatePersistedRosterMembers(
  members: unknown
): readonly PersistedTeamRosterPlanMember[] {
  if (!Array.isArray(members)) {
    fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-members-invalid');
  }
  const candidates: readonly unknown[] = members;
  const ids = new Set<string>();
  const keys = new Set<string>();
  const foldedKeys = new Set<string>();
  let previousKey: string | null = null;
  const validated = candidates.map((candidate, index) => {
    if (!Object.hasOwn(candidates, index)) {
      fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-members-sparse');
    }
    if (typeof candidate !== 'object' || candidate === null) {
      fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-member-invalid');
    }
    const member = candidate as Record<string, unknown>;
    let memberId;
    let legacyMemberKey;
    try {
      memberId = parseMemberId(member.memberId);
      legacyMemberKey = parseLegacyMemberKey(member.legacyMemberKey);
    } catch {
      fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-identity-invalid');
    }
    const foldedKey = legacyMemberKey.toLowerCase();
    if (
      ids.has(memberId) ||
      keys.has(legacyMemberKey) ||
      foldedKeys.has(foldedKey) ||
      (previousKey !== null && previousKey >= legacyMemberKey)
    ) {
      fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-identity-ambiguous');
    }
    const memberRevision = member.memberRevision;
    if (!Number.isSafeInteger(memberRevision) || (memberRevision as number) < 1) {
      fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-revision-invalid');
    }
    if (member.state !== 'active' && member.state !== 'removed') {
      fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-state-invalid');
    }
    if (
      member.providerId !== 'anthropic' &&
      member.providerId !== 'codex' &&
      member.providerId !== 'gemini' &&
      member.providerId !== 'opencode'
    ) {
      fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-provider-invalid');
    }
    const model = validateNullableRosterText(member.model, 512);
    const role = validateNullableRosterText(member.role, 4_096);
    const workflow = validateNullableRosterText(member.workflow, 131_072);
    if (member.isolation !== null && member.isolation !== 'worktree') {
      fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-isolation-invalid');
    }
    ids.add(memberId);
    keys.add(legacyMemberKey);
    foldedKeys.add(foldedKey);
    previousKey = legacyMemberKey;
    return {
      memberId,
      legacyMemberKey,
      memberRevision: memberRevision as number,
      state: member.state,
      providerId: member.providerId,
      model,
      role,
      workflow,
      isolation: member.isolation,
    } as const;
  });
  for (const member of validated) {
    const suffix = /^(.+)-(\d+)$/.exec(member.legacyMemberKey);
    if (suffix?.[1] && Number(suffix[2]) >= 2 && foldedKeys.has(suffix[1].toLowerCase())) {
      fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-identity-ambiguous');
    }
  }
  return validated;
}

function validateNullableRosterText(value: unknown, maximumLength: number): string | null {
  if (
    value !== null &&
    (typeof value !== 'string' || value.length === 0 || value.length > maximumLength)
  ) {
    fail('persisted_roster_mismatch', 'runtime-plan-persisted-roster-member-field-invalid');
  }
  return value;
}

function validatePlannedMember(
  member: PlannedRuntimeMember
): ReturnType<typeof parseLegacyMemberKey> {
  try {
    if (member.name !== member.name.trim()) throw new TypeError();
    return parseLegacyMemberKey(member.name);
  } catch {
    fail('persisted_roster_mismatch', 'runtime-plan-planned-member-identity-invalid');
  }
}

function fail(
  code: 'lane_plan_rejected' | 'persisted_roster_mismatch' | 'persisted_roster_missing',
  message: string
): never {
  throw new CompositeRuntimePlanValidationError(code, message);
}
