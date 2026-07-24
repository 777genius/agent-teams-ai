import {
  isProvisioningTeamName,
  parseOptionalLaunchProviderBackendId,
  parseOptionalMemberEffort,
  parseOptionalMemberProviderId,
  parseOptionalProviderBackendId,
  parseOptionalTeamEffort,
  parseOptionalTeamFastMode,
  parseOptionalTeamProviderId,
} from '@features/team-configuration';
import { validateTeammateName } from '@main/ipc/guards';
import { extractUserFlags, PROTECTED_CLI_FLAGS } from '@shared/utils/cliArgsParser';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import * as path from 'path';

import type { TeamCreateConfigRequest } from '@shared/types';

type NormalizedCreateConfigResult =
  | { valid: true; value: TeamCreateConfigRequest }
  | { valid: false; error: string };

export function normalizeCreateTeamConfigRequest(request: unknown): NormalizedCreateConfigResult {
  if (!request || typeof request !== 'object') {
    return { valid: false, error: 'Invalid create config request' };
  }

  const payload = request as Partial<TeamCreateConfigRequest>;
  if (typeof payload.teamName !== 'string' || payload.teamName.trim().length === 0) {
    return { valid: false, error: 'teamName is required' };
  }
  const teamName = payload.teamName.trim();
  if (!isProvisioningTeamName(teamName)) {
    return { valid: false, error: 'teamName must be kebab-case [a-z0-9-], max 64 chars' };
  }

  if (!Array.isArray(payload.members)) {
    return { valid: false, error: 'members must be an array' };
  }

  if (payload.displayName !== undefined && typeof payload.displayName !== 'string') {
    return { valid: false, error: 'displayName must be a string' };
  }
  if (payload.description !== undefined && typeof payload.description !== 'string') {
    return { valid: false, error: 'description must be a string' };
  }
  if (payload.color !== undefined && typeof payload.color !== 'string') {
    return { valid: false, error: 'color must be a string' };
  }
  if (payload.cwd !== undefined) {
    if (typeof payload.cwd !== 'string' || payload.cwd.trim().length === 0) {
      return { valid: false, error: 'cwd must be a non-empty string if provided' };
    }
    if (!path.isAbsolute(payload.cwd.trim())) {
      return { valid: false, error: 'cwd must be an absolute path' };
    }
  }
  if (payload.prompt !== undefined && typeof payload.prompt !== 'string') {
    return { valid: false, error: 'prompt must be a string' };
  }
  const teamProviderValidation = parseOptionalTeamProviderId(payload.providerId);
  if (!teamProviderValidation.valid) {
    return { valid: false, error: teamProviderValidation.error };
  }
  const effectiveTeamProviderId = teamProviderValidation.value ?? 'anthropic';
  const providerBackendValidation = parseOptionalLaunchProviderBackendId(
    payload.providerBackendId,
    effectiveTeamProviderId
  );
  if (!providerBackendValidation.valid) {
    return { valid: false, error: providerBackendValidation.error };
  }
  if (payload.model !== undefined && typeof payload.model !== 'string') {
    return { valid: false, error: 'model must be a string' };
  }
  const effortValidation = parseOptionalTeamEffort(payload.effort, effectiveTeamProviderId);
  if (!effortValidation.valid) {
    return { valid: false, error: effortValidation.error };
  }
  const fastModeValidation = parseOptionalTeamFastMode(payload.fastMode);
  if (!fastModeValidation.valid) {
    return { valid: false, error: fastModeValidation.error };
  }
  if (payload.limitContext !== undefined && typeof payload.limitContext !== 'boolean') {
    return { valid: false, error: 'limitContext must be a boolean' };
  }
  if (payload.skipPermissions !== undefined && typeof payload.skipPermissions !== 'boolean') {
    return { valid: false, error: 'skipPermissions must be a boolean' };
  }
  if (payload.worktree !== undefined) {
    if (typeof payload.worktree !== 'string') {
      return { valid: false, error: 'worktree must be a string' };
    }
    const worktree = payload.worktree.trim();
    if (worktree.length > 128) {
      return { valid: false, error: 'worktree name too long (max 128)' };
    }
    if (worktree && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(worktree)) {
      return {
        valid: false,
        error: 'worktree name: start with alphanumeric, use [a-zA-Z0-9._-]',
      };
    }
  }
  if (payload.extraCliArgs !== undefined) {
    if (typeof payload.extraCliArgs !== 'string') {
      return { valid: false, error: 'extraCliArgs must be a string' };
    }
    if (payload.extraCliArgs.length > 1024) {
      return { valid: false, error: 'extraCliArgs too long (max 1024)' };
    }
    const protectedFlags = extractUserFlags(payload.extraCliArgs).filter((flag) =>
      PROTECTED_CLI_FLAGS.has(flag)
    );
    if (protectedFlags.length > 0) {
      return {
        valid: false,
        error: `extraCliArgs contains app-managed flags: ${[...new Set(protectedFlags)].join(', ')}`,
      };
    }
  }

  const seenNames = new Set<string>();
  const members: TeamCreateConfigRequest['members'] = [];
  for (const member of payload.members) {
    if (!member || typeof member !== 'object') {
      return { valid: false, error: 'member must be object' };
    }
    const nameValidation = validateTeammateName((member as { name?: unknown }).name);
    if (!nameValidation.valid) {
      return { valid: false, error: nameValidation.error ?? 'Invalid member name' };
    }
    const memberName = nameValidation.value!;
    if (seenNames.has(memberName)) {
      return { valid: false, error: 'member names must be unique' };
    }
    seenNames.add(memberName);

    const role = (member as { role?: unknown }).role;
    if (role !== undefined && typeof role !== 'string') {
      return { valid: false, error: 'member role must be string' };
    }
    const workflow = (member as { workflow?: unknown }).workflow;
    if (workflow !== undefined && typeof workflow !== 'string') {
      return { valid: false, error: 'member workflow must be string' };
    }
    const isolation = (member as { isolation?: unknown }).isolation;
    if (isolation !== undefined && isolation !== 'worktree') {
      return { valid: false, error: 'member isolation must be "worktree" when provided' };
    }
    const providerValidation = parseOptionalMemberProviderId(
      (member as { providerId?: unknown }).providerId
    );
    if (!providerValidation.valid) {
      return { valid: false, error: providerValidation.error };
    }
    const effectiveMemberProviderId = providerValidation.value ?? effectiveTeamProviderId;
    const memberProviderBackendValidation = parseOptionalProviderBackendId(
      (member as { providerBackendId?: unknown }).providerBackendId,
      effectiveMemberProviderId
    );
    if (!memberProviderBackendValidation.valid) {
      return { valid: false, error: memberProviderBackendValidation.error };
    }
    const model = (member as { model?: unknown }).model;
    if (model !== undefined && typeof model !== 'string') {
      return { valid: false, error: 'member model must be string' };
    }
    const memberEffortValidation = parseOptionalMemberEffort(
      (member as { effort?: unknown }).effort,
      effectiveMemberProviderId
    );
    if (!memberEffortValidation.valid) {
      return { valid: false, error: memberEffortValidation.error };
    }
    const memberFastModeValidation = parseOptionalTeamFastMode(
      (member as { fastMode?: unknown }).fastMode
    );
    if (!memberFastModeValidation.valid) {
      return { valid: false, error: memberFastModeValidation.error };
    }
    members.push({
      name: memberName,
      role: typeof role === 'string' ? role.trim() : undefined,
      workflow: typeof workflow === 'string' ? workflow.trim() : undefined,
      isolation: isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: providerValidation.value,
      providerBackendId: memberProviderBackendValidation.value,
      model: typeof model === 'string' ? model.trim() || undefined : undefined,
      effort: memberEffortValidation.value,
      fastMode: memberFastModeValidation.value,
      mcpPolicy: normalizeTeamMemberMcpPolicy((member as { mcpPolicy?: unknown }).mcpPolicy),
    });
  }

  return {
    valid: true,
    value: {
      teamName,
      displayName: payload.displayName?.trim() || undefined,
      description: payload.description?.trim() || undefined,
      color: typeof payload.color === 'string' ? payload.color.trim() || undefined : undefined,
      members,
      cwd: typeof payload.cwd === 'string' ? payload.cwd.trim() || undefined : undefined,
      prompt: typeof payload.prompt === 'string' ? payload.prompt.trim() || undefined : undefined,
      providerId: teamProviderValidation.value,
      providerBackendId: providerBackendValidation.value,
      model: typeof payload.model === 'string' ? payload.model.trim() || undefined : undefined,
      effort: effortValidation.value,
      fastMode: fastModeValidation.value,
      limitContext: typeof payload.limitContext === 'boolean' ? payload.limitContext : undefined,
      skipPermissions:
        typeof payload.skipPermissions === 'boolean' ? payload.skipPermissions : undefined,
      worktree:
        typeof payload.worktree === 'string' && payload.worktree.trim()
          ? payload.worktree.trim()
          : undefined,
      extraCliArgs:
        typeof payload.extraCliArgs === 'string' && payload.extraCliArgs.trim()
          ? payload.extraCliArgs.trim()
          : undefined,
    },
  };
}
