import {
  parseOptionalMemberEffort,
  parseOptionalMemberProviderId,
  parseOptionalProviderBackendId,
  parseOptionalTeamFastMode,
} from '@features/team-configuration';
import { validateMemberName, validateTeammateName, validateTeamName } from '@main/ipc/guards';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';

import type { RosterMemberInput } from '../../../../core/domain/rosterMutationModels';

type Result<T> = { valid: true; value: T } | { valid: false; error: string };

export function normalizeAddMemberInput(
  teamName: unknown,
  payload: unknown
): Result<{ teamName: string; member: RosterMemberInput }> {
  const validatedTeam = requiredTeamName(teamName);
  if (!validatedTeam.valid) return validatedTeam;
  if (!payload || typeof payload !== 'object') {
    return failure('Invalid payload');
  }
  const input = payload as Record<string, unknown>;
  const validatedName = validateTeammateName(input.name);
  if (!validatedName.valid) return failure(validatedName.error ?? 'Invalid member name');
  if (input.role !== undefined && typeof input.role !== 'string') {
    return failure('role must be a string');
  }
  if (input.workflow !== undefined && typeof input.workflow !== 'string') {
    return failure('workflow must be a string');
  }
  if (input.isolation !== undefined && input.isolation !== 'worktree') {
    return failure('isolation must be "worktree" when provided');
  }
  const runtime = normalizeRuntimeSelection(input, '');
  if (!runtime.valid) return runtime;

  return success({
    teamName: validatedTeam.value,
    member: {
      name: validatedName.value!,
      role: input.role,
      workflow: optionalTrimmedText(input.workflow),
      isolation: input.isolation === 'worktree' ? 'worktree' : undefined,
      providerId: runtime.value.providerId,
      ...(runtime.value.providerBackendId
        ? { providerBackendId: runtime.value.providerBackendId }
        : {}),
      model: runtime.value.model,
      effort: runtime.value.effort,
      ...(runtime.value.fastMode ? { fastMode: runtime.value.fastMode } : {}),
      mcpPolicy: normalizeTeamMemberMcpPolicy(input.mcpPolicy),
    },
  });
}

export function normalizeReplaceMembersInput(
  teamName: unknown,
  request: unknown
): Result<{ teamName: string; members: RosterMemberInput[] }> {
  const validatedTeam = requiredTeamName(teamName);
  if (!validatedTeam.valid) return validatedTeam;
  if (!request || typeof request !== 'object') return failure('request must be an object');
  const input = request as { members?: unknown };
  if (!Array.isArray(input.members)) return failure('members must be an array');

  const seenNames = new Set<string>();
  const members: RosterMemberInput[] = [];
  for (const item of input.members) {
    if (!item || typeof item !== 'object') return failure('member must be object');
    const member = item as Record<string, unknown>;
    const validatedName = validateTeammateName(member.name);
    if (!validatedName.valid) return failure(validatedName.error ?? 'Invalid member name');
    const name = validatedName.value!;
    if (seenNames.has(name)) return failure('member names must be unique');
    seenNames.add(name);
    if (member.role !== undefined && typeof member.role !== 'string') {
      return failure('member role must be string');
    }
    if (member.workflow !== undefined && typeof member.workflow !== 'string') {
      return failure('member workflow must be string');
    }
    if (member.isolation !== undefined && member.isolation !== 'worktree') {
      return failure('member isolation must be "worktree" when provided');
    }
    const runtime = normalizeRuntimeSelection(member, 'member ');
    if (!runtime.valid) return runtime;
    members.push({
      name,
      role: typeof member.role === 'string' ? member.role.trim() : undefined,
      workflow: typeof member.workflow === 'string' ? member.workflow.trim() : undefined,
      isolation: member.isolation === 'worktree' ? 'worktree' : undefined,
      ...runtime.value,
      mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
    });
  }
  return success({ teamName: validatedTeam.value, members });
}

export function normalizeMemberMutationInput(
  teamName: unknown,
  memberName: unknown
): Result<{ teamName: string; memberName: string }> {
  const validatedTeam = requiredTeamName(teamName);
  if (!validatedTeam.valid) return validatedTeam;
  const validatedMember = validateMemberName(memberName);
  if (!validatedMember.valid) {
    return failure(validatedMember.error ?? 'Invalid memberName');
  }
  return success({ teamName: validatedTeam.value, memberName: validatedMember.value! });
}

export function normalizeUpdateMemberRoleInput(
  teamName: unknown,
  memberName: unknown,
  role: unknown
): Result<{ teamName: string; memberName: string; role: string | undefined }> {
  const member = normalizeMemberMutationInput(teamName, memberName);
  if (!member.valid) return member;
  if (role !== undefined && role !== null && typeof role !== 'string') {
    return failure('role must be a string, null, or undefined');
  }
  return success({
    ...member.value,
    role: typeof role === 'string' ? role.trim() || undefined : undefined,
  });
}

function normalizeRuntimeSelection(
  input: Record<string, unknown>,
  fieldPrefix: '' | 'member '
): Result<Omit<RosterMemberInput, 'name' | 'role' | 'workflow' | 'isolation' | 'mcpPolicy'>> {
  const provider = parseOptionalMemberProviderId(input.providerId);
  if (!provider.valid) return failure(provider.error);
  const backend = parseOptionalProviderBackendId(input.providerBackendId, provider.value);
  if (!backend.valid) return failure(backend.error);
  if (input.model !== undefined && typeof input.model !== 'string') {
    return failure(fieldPrefix ? 'member model must be string' : 'model must be a string');
  }
  const effort = parseOptionalMemberEffort(input.effort, provider.value);
  if (!effort.valid) return failure(effort.error);
  const fastMode = parseOptionalTeamFastMode(input.fastMode);
  if (!fastMode.valid) return failure(fastMode.error);
  return success({
    providerId: provider.value,
    providerBackendId: backend.value,
    model: optionalTrimmedText(input.model),
    effort: effort.value,
    fastMode: fastMode.value,
  });
}

function requiredTeamName(value: unknown): Result<string> {
  const validated = validateTeamName(value);
  return validated.valid
    ? success(validated.value!)
    : failure(validated.error ?? 'Invalid teamName');
}

function optionalTrimmedText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function success<T>(value: T): Result<T> {
  return { valid: true, value };
}

function failure(error: string): Result<never> {
  return { valid: false, error };
}
