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
import { validateTeammateName, validateTeamName } from '@main/ipc/guards';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { isTeamProviderId } from '@shared/utils/teamProvider';

import type {
  InputValidation,
  ValidatedProvisioningPrepareInput,
  ValidatedTeamLaunchInput,
} from '../../../../core/application/models/TeamProvisioningModels';
import type { TeamProvisioningWorkspacePort } from '../../../../core/application/ports/TeamProvisioningPorts';
import type {
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
} from '@shared/types';

export async function normalizeCreateTeamRequest(
  request: unknown,
  workspace: TeamProvisioningWorkspacePort
): Promise<InputValidation<TeamCreateRequest>> {
  if (!request || typeof request !== 'object') {
    return { valid: false, error: 'Invalid team create request' };
  }

  const payload = request as Partial<TeamCreateRequest>;
  if (typeof payload.teamName !== 'string' || payload.teamName.trim().length === 0) {
    return { valid: false, error: 'teamName is required' };
  }
  const teamName = payload.teamName.trim();
  if (!isProvisioningTeamName(teamName)) {
    return { valid: false, error: 'teamName must be kebab-case [a-z0-9-], max 64 chars' };
  }
  if (payload.displayName !== undefined && typeof payload.displayName !== 'string') {
    return { valid: false, error: 'displayName must be string' };
  }
  if (payload.description !== undefined && typeof payload.description !== 'string') {
    return { valid: false, error: 'description must be string' };
  }
  if (!Array.isArray(payload.members)) {
    return { valid: false, error: 'members must be an array' };
  }

  const teamProviderValidation = parseOptionalTeamProviderId(payload.providerId);
  if (!teamProviderValidation.valid) {
    return { valid: false, error: teamProviderValidation.error };
  }
  const providerId = teamProviderValidation.value ?? 'anthropic';
  const seenNames = new Set<string>();
  const members: TeamCreateRequest['members'] = [];
  for (const member of payload.members) {
    if (!member || typeof member !== 'object') {
      return { valid: false, error: 'member must be object' };
    }
    const rawMember = member as unknown as Record<string, unknown>;
    const nameValidation = validateTeammateName(rawMember.name);
    if (!nameValidation.valid) {
      return { valid: false, error: nameValidation.error ?? 'Invalid member name' };
    }
    const memberName = nameValidation.value!;
    if (seenNames.has(memberName)) {
      return { valid: false, error: 'member names must be unique' };
    }
    seenNames.add(memberName);

    if (rawMember.role !== undefined && typeof rawMember.role !== 'string') {
      return { valid: false, error: 'member role must be string' };
    }
    if (rawMember.workflow !== undefined && typeof rawMember.workflow !== 'string') {
      return { valid: false, error: 'member workflow must be string' };
    }
    if (rawMember.isolation !== undefined && rawMember.isolation !== 'worktree') {
      return { valid: false, error: 'member isolation must be "worktree" when provided' };
    }
    const memberProviderValidation = parseOptionalMemberProviderId(rawMember.providerId);
    if (!memberProviderValidation.valid) {
      return { valid: false, error: memberProviderValidation.error };
    }
    const memberProviderId = memberProviderValidation.value ?? providerId;
    const backendValidation = parseOptionalProviderBackendId(
      rawMember.providerBackendId,
      memberProviderId
    );
    if (!backendValidation.valid) {
      return { valid: false, error: backendValidation.error };
    }
    if (rawMember.model !== undefined && typeof rawMember.model !== 'string') {
      return { valid: false, error: 'member model must be string' };
    }
    const effortValidation = parseOptionalMemberEffort(rawMember.effort, memberProviderId);
    if (!effortValidation.valid) {
      return { valid: false, error: effortValidation.error };
    }
    const fastModeValidation = parseOptionalTeamFastMode(rawMember.fastMode);
    if (!fastModeValidation.valid) {
      return { valid: false, error: fastModeValidation.error };
    }
    members.push({
      name: memberName,
      role: typeof rawMember.role === 'string' ? rawMember.role.trim() : undefined,
      workflow: typeof rawMember.workflow === 'string' ? rawMember.workflow.trim() : undefined,
      isolation: rawMember.isolation === 'worktree' ? 'worktree' : undefined,
      providerId: memberProviderValidation.value,
      providerBackendId: backendValidation.value,
      model: typeof rawMember.model === 'string' ? rawMember.model.trim() || undefined : undefined,
      effort: effortValidation.value,
      fastMode: fastModeValidation.value,
      mcpPolicy: normalizeTeamMemberMcpPolicy(rawMember.mcpPolicy),
    });
  }

  if (typeof payload.cwd !== 'string' || payload.cwd.trim().length === 0) {
    return { valid: false, error: 'cwd is required' };
  }
  const cwd = payload.cwd.trim();
  if (!workspace.isAbsolute(cwd)) {
    return { valid: false, error: 'cwd must be an absolute path' };
  }
  if (payload.prompt !== undefined && typeof payload.prompt !== 'string') {
    return { valid: false, error: 'prompt must be a string' };
  }
  const backendValidation = parseOptionalLaunchProviderBackendId(
    payload.providerBackendId,
    providerId
  );
  if (!backendValidation.valid) {
    return { valid: false, error: backendValidation.error };
  }
  const effortValidation = parseOptionalTeamEffort(payload.effort, providerId);
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
  if (!(await workspace.ensureDirectory(cwd))) {
    return { valid: false, error: 'failed to create cwd directory' };
  }
  const directoryStatus = await workspace.getDirectoryStatus(cwd);
  if (directoryStatus === 'missing') {
    return { valid: false, error: 'cwd does not exist' };
  }
  if (directoryStatus === 'not-directory') {
    return { valid: false, error: 'cwd must be a directory' };
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
  }

  return {
    valid: true,
    value: {
      teamName,
      displayName: payload.displayName?.trim() || undefined,
      description: payload.description?.trim() || undefined,
      color: typeof payload.color === 'string' ? payload.color.trim() || undefined : undefined,
      members,
      cwd,
      prompt: typeof payload.prompt === 'string' ? payload.prompt.trim() || undefined : undefined,
      providerId,
      providerBackendId: backendValidation.value,
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

export async function normalizeLaunchTeamRequest(
  request: unknown,
  workspace: TeamProvisioningWorkspacePort
): Promise<InputValidation<ValidatedTeamLaunchInput>> {
  if (!request || typeof request !== 'object') {
    return { valid: false, error: 'Invalid team launch request' };
  }
  const payload = request as Partial<TeamLaunchRequest>;
  const teamNameValidation = validateTeamName(payload.teamName);
  if (!teamNameValidation.valid) {
    return { valid: false, error: teamNameValidation.error ?? 'Invalid teamName' };
  }
  if (typeof payload.cwd !== 'string' || payload.cwd.trim().length === 0) {
    return { valid: false, error: 'cwd is required' };
  }
  const cwd = payload.cwd.trim();
  if (!workspace.isAbsolute(cwd)) {
    return { valid: false, error: 'cwd must be an absolute path' };
  }
  const directoryStatus = await workspace.getDirectoryStatus(cwd);
  if (directoryStatus === 'missing') {
    return { valid: false, error: 'cwd does not exist' };
  }
  if (directoryStatus === 'not-directory') {
    return { valid: false, error: 'cwd must be a directory' };
  }
  if (payload.prompt !== undefined && typeof payload.prompt !== 'string') {
    return { valid: false, error: 'prompt must be a string' };
  }
  if (payload.model !== undefined && typeof payload.model !== 'string') {
    return { valid: false, error: 'model must be a string' };
  }
  if (payload.limitContext !== undefined && typeof payload.limitContext !== 'boolean') {
    return { valid: false, error: 'limitContext must be a boolean' };
  }
  const providerValidation = parseOptionalTeamProviderId(payload.providerId);
  if (!providerValidation.valid) {
    return { valid: false, error: providerValidation.error };
  }
  const explicitProviderId = providerValidation.value;
  const defaultProviderId = explicitProviderId ?? 'anthropic';
  const backendValidation = parseOptionalLaunchProviderBackendId(
    payload.providerBackendId,
    defaultProviderId
  );
  if (!backendValidation.valid) {
    return { valid: false, error: backendValidation.error };
  }
  return {
    valid: true,
    value: {
      payload,
      teamName: teamNameValidation.value!,
      cwd,
      explicitProviderId,
      defaultProviderId,
      explicitProviderBackendId: backendValidation.value,
    },
  };
}

export function normalizeProvisioningPrepareInput(
  cwd: unknown,
  providerId: unknown,
  providerIds: unknown,
  selectedModels: unknown,
  limitContext: unknown,
  modelVerificationMode: unknown,
  selectedModelChecks: unknown,
  isAbsolutePath: (value: string) => boolean
): InputValidation<ValidatedProvisioningPrepareInput> {
  let validatedCwd: string | undefined;
  let validatedProviderId: TeamProviderId | undefined;
  let validatedProviderIds: TeamProviderId[] | undefined;
  let validatedSelectedModels: string[] | undefined;
  let validatedLimitContext: boolean | undefined;
  let validatedModelVerificationMode: TeamProvisioningModelVerificationMode | undefined;
  let validatedSelectedModelChecks: TeamProvisioningModelCheckRequest[] | undefined;

  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || cwd.trim().length === 0) {
      return { valid: false, error: 'cwd must be a non-empty string' };
    }
    validatedCwd = cwd.trim();
    if (!isAbsolutePath(validatedCwd)) {
      return { valid: false, error: 'cwd must be an absolute path' };
    }
  }
  if (providerId !== undefined) {
    if (!isTeamProviderId(providerId)) {
      return { valid: false, error: 'providerId must be anthropic, codex, gemini, or opencode' };
    }
    validatedProviderId = providerId;
  }
  if (providerIds !== undefined) {
    if (!Array.isArray(providerIds)) {
      return { valid: false, error: 'providerIds must be an array when provided' };
    }
    const normalized: TeamProviderId[] = [];
    for (const entry of providerIds) {
      if (!isTeamProviderId(entry)) {
        return {
          valid: false,
          error: 'providerIds entries must be anthropic, codex, gemini, or opencode',
        };
      }
      if (!normalized.includes(entry)) normalized.push(entry);
    }
    validatedProviderIds = normalized;
  }
  if (selectedModels !== undefined) {
    if (!Array.isArray(selectedModels)) {
      return { valid: false, error: 'selectedModels must be an array when provided' };
    }
    const rawSelectedModels: unknown[] = selectedModels;
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < rawSelectedModels.length; index += 1) {
      if (!Object.hasOwn(rawSelectedModels, index)) {
        return { valid: false, error: 'selectedModels entries must be non-empty strings' };
      }
      const entry = rawSelectedModels[index];
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        return { valid: false, error: 'selectedModels entries must be non-empty strings' };
      }
      const model = entry.trim();
      if (!seen.has(model)) {
        seen.add(model);
        normalized.push(model);
      }
    }
    validatedSelectedModels = normalized;
  }
  if (limitContext !== undefined) {
    if (typeof limitContext !== 'boolean') {
      return { valid: false, error: 'limitContext must be a boolean when provided' };
    }
    validatedLimitContext = limitContext;
  }
  if (modelVerificationMode !== undefined) {
    if (modelVerificationMode !== 'compatibility' && modelVerificationMode !== 'deep') {
      return {
        valid: false,
        error: 'modelVerificationMode must be compatibility or deep when provided',
      };
    }
    validatedModelVerificationMode = modelVerificationMode;
  }
  if (selectedModelChecks !== undefined) {
    if (!Array.isArray(selectedModelChecks)) {
      return { valid: false, error: 'selectedModelChecks must be an array when provided' };
    }
    const normalized: TeamProvisioningModelCheckRequest[] = [];
    const seen = new Set<string>();
    for (const entry of selectedModelChecks) {
      if (!entry || typeof entry !== 'object') {
        return { valid: false, error: 'selectedModelChecks entries must be objects' };
      }
      const raw = entry as Record<string, unknown>;
      if (!isTeamProviderId(raw.providerId)) {
        return {
          valid: false,
          error: 'selectedModelChecks entries must include a valid providerId',
        };
      }
      if (typeof raw.model !== 'string' || raw.model.trim().length === 0) {
        return {
          valid: false,
          error: 'selectedModelChecks entries must include a non-empty model',
        };
      }
      const effortValidation = parseOptionalTeamEffort(raw.effort, raw.providerId);
      if (!effortValidation.valid) {
        return { valid: false, error: `selectedModelChecks ${effortValidation.error}` };
      }
      const model = raw.model.trim();
      const key = `${raw.providerId}\n${model}\n${effortValidation.value ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({
        providerId: raw.providerId,
        model,
        ...(effortValidation.value ? { effort: effortValidation.value } : {}),
      });
    }
    validatedSelectedModelChecks = normalized;
  }
  return {
    valid: true,
    value: {
      cwd: validatedCwd,
      providerId: validatedProviderId,
      providerIds: validatedProviderIds,
      selectedModels: validatedSelectedModels,
      limitContext: validatedLimitContext,
      modelVerificationMode: validatedModelVerificationMode,
      selectedModelChecks: validatedSelectedModelChecks,
    },
  };
}
