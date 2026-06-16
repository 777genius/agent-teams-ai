import { migrateProviderBackendId } from '@shared/utils/providerBackend';

import type {
  EffortLevel,
  TeamFastMode,
  TeamMemberMcpPolicy,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

export interface MemberDiffInput {
  name: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  mcpPolicy?: TeamMemberMcpPolicy;
  removedAt?: number | string | null;
}

export interface ReplaceMembersDiff {
  added: {
    name: string;
    role?: string;
    workflow?: string;
    isolation?: 'worktree';
    providerId?: TeamProviderId;
    providerBackendId?: TeamProviderBackendId;
    model?: string;
    effort?: EffortLevel;
    fastMode?: TeamFastMode;
    mcpPolicy?: TeamMemberMcpPolicy;
  }[];
  removed: string[];
  updated: {
    name: string;
    changes: string[];
  }[];
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function describeRoleChange(
  previousRole: string | undefined,
  nextRole: string | undefined
): string | null {
  if (previousRole === nextRole) {
    return null;
  }
  if (previousRole && nextRole) {
    return `role changed from "${previousRole}" to "${nextRole}"`;
  }
  if (nextRole) {
    return `role set to "${nextRole}"`;
  }
  return 'role cleared';
}

function describeWorkflowChange(
  previousWorkflow: string | undefined,
  nextWorkflow: string | undefined
): string | null {
  if (previousWorkflow === nextWorkflow) {
    return null;
  }
  if (previousWorkflow && nextWorkflow) {
    return 'workflow instructions were updated';
  }
  if (nextWorkflow) {
    return 'workflow instructions were added';
  }
  return 'workflow instructions were cleared';
}

function describeProviderChange(
  previousProviderId: TeamProviderId | undefined,
  nextProviderId: TeamProviderId | undefined
): string | null {
  if (previousProviderId === nextProviderId) {
    return null;
  }
  return 'provider changed - restart required';
}

function describeProviderBackendChange(
  previousProviderId: TeamProviderId | undefined,
  previousProviderBackendId: TeamProviderBackendId | undefined,
  nextProviderId: TeamProviderId | undefined,
  nextProviderBackendId: TeamProviderBackendId | undefined
): string | null {
  if (
    migrateProviderBackendId(previousProviderId, previousProviderBackendId) ===
    migrateProviderBackendId(nextProviderId, nextProviderBackendId)
  ) {
    return null;
  }
  return 'provider backend changed - restart required';
}

function describeModelChange(
  previousModel: string | undefined,
  nextModel: string | undefined
): string | null {
  if (previousModel === nextModel) {
    return null;
  }
  return 'model changed - restart required';
}

function describeEffortChange(
  previousEffort: EffortLevel | undefined,
  nextEffort: EffortLevel | undefined
): string | null {
  if (previousEffort === nextEffort) {
    return null;
  }
  return 'reasoning effort changed - restart required';
}

function describeFastModeChange(
  previousFastMode: TeamFastMode | undefined,
  nextFastMode: TeamFastMode | undefined
): string | null {
  if (previousFastMode === nextFastMode) {
    return null;
  }
  return 'fast mode changed - restart required';
}

function describeMcpPolicyChange(
  previousMcpPolicy: TeamMemberMcpPolicy | undefined,
  nextMcpPolicy: TeamMemberMcpPolicy | undefined
): string | null {
  if (JSON.stringify(previousMcpPolicy) === JSON.stringify(nextMcpPolicy)) {
    return null;
  }
  return 'MCP access policy changed - restart required';
}

export function buildReplaceMembersDiff(
  previousMembers: MemberDiffInput[],
  nextMembers: {
    name: string;
    role?: string;
    workflow?: string;
    isolation?: 'worktree';
    providerId?: TeamProviderId;
    providerBackendId?: TeamProviderBackendId;
    model?: string;
    effort?: EffortLevel;
    fastMode?: TeamFastMode;
    mcpPolicy?: TeamMemberMcpPolicy;
  }[]
): ReplaceMembersDiff {
  const previousByName = new Map(
    previousMembers
      .filter((member) => !member.removedAt && member.name.trim().toLowerCase() !== 'team-lead')
      .map((member) => [
        member.name.trim().toLowerCase(),
        {
          name: member.name.trim(),
          role: normalizeOptionalText(member.role),
          workflow: normalizeOptionalText(member.workflow),
          isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
          providerId: member.providerId,
          providerBackendId: migrateProviderBackendId(member.providerId, member.providerBackendId),
          model: normalizeOptionalText(member.model),
          effort: member.effort,
          fastMode: member.fastMode,
          mcpPolicy: member.mcpPolicy,
        },
      ])
  );
  const nextByName = new Map(
    nextMembers
      .filter((member) => member.name.trim().toLowerCase() !== 'team-lead')
      .map((member) => [
        member.name.trim().toLowerCase(),
        {
          name: member.name.trim(),
          role: normalizeOptionalText(member.role),
          workflow: normalizeOptionalText(member.workflow),
          isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
          providerId: member.providerId,
          providerBackendId: migrateProviderBackendId(member.providerId, member.providerBackendId),
          model: normalizeOptionalText(member.model),
          effort: member.effort,
          fastMode: member.fastMode,
          mcpPolicy: member.mcpPolicy,
        },
      ])
  );

  const added = Array.from(nextByName.entries())
    .filter(([name]) => !previousByName.has(name))
    .map(([, member]) => member);

  const removed = Array.from(previousByName.entries())
    .filter(([name]) => !nextByName.has(name))
    .map(([, member]) => member.name)
    .sort((a, b) => a.localeCompare(b));

  const updated = Array.from(nextByName.entries())
    .flatMap(([name, nextMember]) => {
      const previousMember = previousByName.get(name);
      if (!previousMember) {
        return [];
      }
      const changes = [
        describeRoleChange(previousMember.role, nextMember.role),
        describeWorkflowChange(previousMember.workflow, nextMember.workflow),
        previousMember.isolation !== nextMember.isolation
          ? nextMember.isolation === 'worktree'
            ? 'worktree isolation enabled'
            : 'worktree isolation disabled'
          : null,
        describeProviderChange(previousMember.providerId, nextMember.providerId),
        describeProviderBackendChange(
          previousMember.providerId,
          previousMember.providerBackendId,
          nextMember.providerId,
          nextMember.providerBackendId
        ),
        describeModelChange(previousMember.model, nextMember.model),
        describeEffortChange(previousMember.effort, nextMember.effort),
        describeFastModeChange(previousMember.fastMode, nextMember.fastMode),
        describeMcpPolicyChange(previousMember.mcpPolicy, nextMember.mcpPolicy),
      ].filter((value): value is string => value !== null);
      if (changes.length === 0) {
        return [];
      }
      return [{ name: nextMember.name, changes }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { added, removed, updated };
}

export function buildReplaceMembersSummaryMessage(diff: ReplaceMembersDiff): string | null {
  const lines: string[] = [];

  for (const name of diff.removed) {
    lines.push(
      `- Teammate "${name}" was removed from the team. Stop assigning them new work and reassign any active tasks if needed.`
    );
  }

  for (const update of diff.updated) {
    lines.push(
      `- Teammate "${update.name}" was updated: ${update.changes.join('; ')}. Please send them refreshed instructions so their live behavior matches the new config.`
    );
  }

  if (lines.length === 0) {
    return null;
  }

  return (
    'The user updated the live team roster.\n' +
    'Apply these changes to the running team now:\n' +
    lines.join('\n')
  );
}
