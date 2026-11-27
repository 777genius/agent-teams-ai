import {
  validateMemberName,
  validateTeammateName,
} from '@main/services/team/TeamIdentifierValidation';
import { getConfiguredTeamMember } from '@shared/utils/teamMemberConfiguredSettings';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { parseNumericSuffixName } from '@shared/utils/teamMemberName';

import {
  parseOptionalMemberEffort,
  parseOptionalMemberProviderId,
  parseOptionalProviderBackendId,
  parseOptionalTeamFastMode,
} from '../teamIpcRequestParsers';

import {
  assertLiveRosterMutationAllowed,
  isLeadRosterMutationMember,
} from './teamLiveRosterMutationPolicy';

import type { RuntimeRosterMutationMember } from './runtimeRosterMutationMember';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { ReplaceMembersRequest } from '@shared/types';

/** The same request normalization is used before the journal and by native execution. */
export function parseRosterMutationMembers(value: unknown): ReplaceMembersRequest['members'] {
  if (!Array.isArray(value)) throw new Error('members must be an array');
  const seenNames = new Set<string>();
  return Array.from(value, (item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('member must be object');
    const member = item as Record<string, unknown>;
    const name = validateTeammateName(member.name);
    if (!name.valid || !name.value) throw new Error(name.error ?? 'Invalid member name');
    const suffix = parseNumericSuffixName(name.value);
    if (suffix && suffix.suffix >= 2) {
      throw new Error(
        `Member name "${name.value}" is reserved for runtime-managed numeric suffixes`
      );
    }
    if (seenNames.has(name.value.toLowerCase())) throw new Error('member names must be unique');
    seenNames.add(name.value.toLowerCase());
    for (const field of ['role', 'workflow', 'model'] as const) {
      if (member[field] !== undefined && typeof member[field] !== 'string') {
        throw new Error(`member ${field} must be string`);
      }
    }
    if (member.isolation !== undefined && member.isolation !== 'worktree') {
      throw new Error('member isolation must be "worktree" when provided');
    }
    const provider = parseOptionalMemberProviderId(member.providerId);
    if (!provider.valid) throw new Error(provider.error);
    const backend = parseOptionalProviderBackendId(member.providerBackendId, provider.value);
    if (!backend.valid) throw new Error(backend.error);
    const effort = parseOptionalMemberEffort(member.effort, provider.value);
    if (!effort.valid) throw new Error(effort.error);
    const fastMode = parseOptionalTeamFastMode(member.fastMode);
    if (!fastMode.valid) throw new Error(fastMode.error);
    return {
      name: name.value,
      role: typeof member.role === 'string' ? member.role.trim() || undefined : undefined,
      workflow:
        typeof member.workflow === 'string' ? member.workflow.trim() || undefined : undefined,
      isolation: member.isolation === 'worktree' ? 'worktree' : undefined,
      providerId: provider.value,
      providerBackendId: backend.value,
      model: typeof member.model === 'string' ? member.model.trim() || undefined : undefined,
      effort: effort.value,
      fastMode: fastMode.value,
      mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
    };
  });
}

export type RosterMutationKind = 'add' | 'replace' | 'remove' | 'restore' | 'role';

function nextRoster(
  previous: readonly RuntimeRosterMutationMember[],
  operation: RosterMutationKind,
  args: readonly unknown[]
): RuntimeRosterMutationMember[] {
  if (operation === 'replace') {
    const request = args[0];
    if (!request || typeof request !== 'object') throw new Error('request must be an object');
    return parseRosterMutationMembers((request as Record<string, unknown>).members);
  }
  if (operation === 'add') {
    const added = parseRosterMutationMembers([args[0]])[0];
    if (previous.some((member) => member.name.toLowerCase() === added.name.toLowerCase())) {
      throw new Error(`Member "${added.name}" already exists`);
    }
    return [...previous, added];
  }
  const name = validateMemberName(args[0]);
  if (!name.valid || !name.value) throw new Error(name.error ?? 'Invalid member name');
  const member = previous.find(
    (candidate) => candidate.name.toLowerCase() === name.value!.toLowerCase()
  );
  if (!member) throw new Error(`Member "${name.value}" not found`);
  if (isLeadRosterMutationMember(member)) throw new Error('Cannot change team lead');
  if (operation === 'remove') return previous.filter((candidate) => candidate !== member);
  if (operation === 'restore') {
    if (!member.removedAt) throw new Error(`Member "${name.value}" is not removed`);
    return previous.map((candidate) =>
      candidate === member ? { ...candidate, removedAt: undefined } : candidate
    );
  }
  if (member.removedAt) throw new Error(`Member "${name.value}" is removed`);
  const role = args[1];
  if (role != null && typeof role !== 'string')
    throw new Error('role must be a string, null, or undefined');
  return previous.map((candidate) =>
    candidate === member
      ? { ...candidate, role: typeof role === 'string' ? role.trim() || undefined : undefined }
      : candidate
  );
}

/** Read-only admission under the caller's logical/runtime gates, before either persisted write. */
export async function preflightRosterMutation(
  data: Pick<TeamDataService, 'getTeamData' | 'assertRosterMutationAllowed'>,
  teamName: string,
  operation: RosterMutationKind,
  ...args: unknown[]
): Promise<void> {
  const previous = (await data.getTeamData(teamName)).members;
  const authored = previous.map((member) =>
    isLeadRosterMutationMember(member) ? member : getConfiguredTeamMember(member)
  );
  const next = nextRoster(authored, operation, args).filter((member) => !member.removedAt);
  if (
    operation === 'remove' &&
    next.length === previous.filter((member) => !member.removedAt).length
  )
    return;
  // The dedicated role setter only saves for the next launch; replacement is a live mutation.
  if (operation === 'role') return;
  assertLiveRosterMutationAllowed(previous, next);
  await data.assertRosterMutationAllowed(
    teamName,
    next.filter((member) => !isLeadRosterMutationMember(member)),
    true
  );
}
