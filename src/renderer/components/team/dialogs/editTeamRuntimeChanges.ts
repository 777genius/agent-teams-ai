import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type {
  EffortLevel,
  ResolvedTeamMember,
  TeamFastMode,
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningMemberInput,
} from '@shared/types';

function normalizeRestartSensitiveMemberContract(member: {
  role?: string;
  workflow?: string;
  isolation?: string;
  providerId?: string;
  model?: string;
  effort?: string;
  mcpPolicy?: unknown;
}): {
  role?: string;
  workflow?: string;
  providerId?: TeamProviderId;
  model?: string;
  effort?: EffortLevel;
  isolation?: 'worktree';
  mcpPolicy?: ReturnType<typeof normalizeTeamMemberMcpPolicy>;
} {
  const role = member.role?.trim() || undefined;
  const workflow = member.workflow?.trim() || undefined;
  const providerId = normalizeOptionalTeamProviderId(member.providerId);
  const model = member.model?.trim() || undefined;
  const effort = isTeamEffortLevel(member.effort) ? member.effort : undefined;
  const isolation = member.isolation === 'worktree' ? 'worktree' : undefined;
  const mcpPolicy = normalizeTeamMemberMcpPolicy(member.mcpPolicy);
  return { role, workflow, providerId, model, effort, isolation, mcpPolicy };
}

export function getMemberRuntimeContractKey(member: {
  role?: string;
  workflow?: string;
  providerId?: string;
  model?: string;
  effort?: string;
  isolation?: string;
  mcpPolicy?: unknown;
}): string {
  return JSON.stringify(normalizeRestartSensitiveMemberContract(member));
}

export function getMembersRequiringRuntimeRestart(params: {
  previousMembers: readonly ResolvedTeamMember[];
  nextMembers: readonly TeamProvisioningMemberInput[];
}): string[] {
  const previousByName = new Map(
    params.previousMembers
      .filter((member) => !member.removedAt)
      .map((member) => [member.name.trim().toLowerCase(), member] as const)
  );

  const membersToRestart: string[] = [];
  for (const nextMember of params.nextMembers) {
    const normalizedName = nextMember.name.trim().toLowerCase();
    if (!normalizedName) {
      continue;
    }
    const previousMember = previousByName.get(normalizedName);
    if (!previousMember) {
      continue;
    }

    const previousRuntime = normalizeRestartSensitiveMemberContract(previousMember);
    const nextRuntime = normalizeRestartSensitiveMemberContract(nextMember);
    if (
      previousRuntime.role !== nextRuntime.role ||
      previousRuntime.workflow !== nextRuntime.workflow ||
      previousRuntime.providerId !== nextRuntime.providerId ||
      previousRuntime.model !== nextRuntime.model ||
      previousRuntime.effort !== nextRuntime.effort ||
      previousRuntime.isolation !== nextRuntime.isolation ||
      JSON.stringify(previousRuntime.mcpPolicy) !== JSON.stringify(nextRuntime.mcpPolicy)
    ) {
      membersToRestart.push(previousMember.name);
    }
  }

  return membersToRestart;
}

export function getLiveRosterIdentityChanges(params: {
  previousMembers: readonly ResolvedTeamMember[];
  nextDrafts: readonly MemberDraft[];
}): {
  renamed: string[];
  removed: string[];
} {
  const previousMembers = params.previousMembers
    .filter((member) => !member.removedAt)
    .filter((member) => member.name.trim().toLowerCase() !== 'team-lead');

  const previousNamesByKey = new Map(
    previousMembers.map((member) => [member.name.trim().toLowerCase(), member.name.trim()] as const)
  );

  const nextExistingOriginalKeys = new Set(
    params.nextDrafts
      .map((member) => member.originalName?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value))
  );

  const renamed = params.nextDrafts
    .flatMap((member) => {
      const originalName = member.originalName?.trim();
      const nextName = member.name.trim();
      if (!originalName || !nextName) {
        return [];
      }
      return originalName.toLowerCase() === nextName.toLowerCase() ? [] : [originalName];
    })
    .sort((a, b) => a.localeCompare(b));

  const removed = Array.from(previousNamesByKey.entries())
    .filter(([normalizedName]) => !nextExistingOriginalKeys.has(normalizedName))
    .map(([, displayName]) => displayName)
    .sort((a, b) => a.localeCompare(b));

  return { renamed, removed };
}

function normalizeEditableMemberSnapshot(member: {
  name: string;
  role?: string;
  workflow?: string;
  providerId?: string;
  providerBackendId?: string;
  model?: string;
  effort?: string;
  isolation?: string;
  fastMode?: string;
  mcpPolicy?: unknown;
  removedAt?: number | string | null;
}): {
  name: string;
  role?: string;
  workflow?: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  isolation?: 'worktree';
  fastMode?: TeamFastMode;
  mcpPolicy?: ReturnType<typeof normalizeTeamMemberMcpPolicy>;
} | null {
  if (member.removedAt) {
    return null;
  }
  const name = member.name.trim();
  if (!name || name.toLowerCase() === 'team-lead') {
    return null;
  }
  const runtime = normalizeRestartSensitiveMemberContract(member);
  return {
    name,
    role: member.role?.trim() || undefined,
    workflow: member.workflow?.trim() || undefined,
    providerBackendId: migrateProviderBackendId(runtime.providerId, member.providerBackendId),
    fastMode:
      member.fastMode === 'inherit' || member.fastMode === 'on' || member.fastMode === 'off'
        ? member.fastMode
        : undefined,
    ...runtime,
  };
}

export function buildEditTeamMemberRosterSnapshot(members: readonly ResolvedTeamMember[]): string;
export function buildEditTeamMemberRosterSnapshot(
  members: readonly TeamProvisioningMemberInput[]
): string;
export function buildEditTeamMemberRosterSnapshot(
  members: readonly (ResolvedTeamMember | TeamProvisioningMemberInput)[]
): string {
  const normalizedMembers = members
    .map(normalizeEditableMemberSnapshot)
    .filter((member): member is NonNullable<typeof member> => member !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return JSON.stringify(normalizedMembers);
}

export function buildEditTeamSourceSnapshot(params: {
  name: string;
  description: string;
  color: string;
  members: readonly ResolvedTeamMember[];
}): string {
  const members = JSON.parse(buildEditTeamMemberRosterSnapshot(params.members)) as unknown;

  return JSON.stringify({
    name: params.name.trim(),
    description: params.description.trim(),
    color: params.color.trim(),
    members,
  });
}
