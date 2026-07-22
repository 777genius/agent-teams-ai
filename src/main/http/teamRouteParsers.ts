import {
  validateTeammateName,
  validateTeamName,
} from '@main/services/team/TeamIdentifierValidation';
import { extractUserFlags, PROTECTED_CLI_FLAGS } from '@shared/utils/cliArgsParser';
import {
  formatEffortLevelListForProvider,
  isTeamEffortLevelForProvider,
} from '@shared/utils/effortLevels';
import { isTeamProviderBackendId, migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { isTeamProviderId } from '@shared/utils/teamProvider';
import { isAbsolute } from 'path';

import type {
  EffortLevel,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamFastMode,
  TeamLaunchRequest,
} from '@shared/types/team';

const PROVIDER_BACKEND_ERROR =
  'providerBackendId must be valid for the selected provider (auto, adapter, api, cli-sdk, codex-native, or opencode-cli)';

export class HttpBadRequestError extends Error {}

export function assertProvisioningTeamName(value: unknown): string {
  const validated = validateTeamName(value);
  if (!validated.valid) {
    throw new HttpBadRequestError(validated.error ?? 'Invalid teamName');
  }
  const teamName = validated.value!;
  const parts = teamName.split('-');
  if (teamName.length > 64 || !parts.every((part) => /^[a-z0-9]+$/.test(part))) {
    throw new HttpBadRequestError('teamName must be kebab-case [a-z0-9-], max 64 chars');
  }
  return teamName;
}

export function assertAbsoluteCwd(cwd: unknown): string {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    throw new HttpBadRequestError('cwd must be a non-empty string');
  }

  const normalized = cwd.trim();
  if (!isAbsolute(normalized)) {
    throw new HttpBadRequestError('cwd must be an absolute path');
  }

  return normalized;
}

export function assertOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new HttpBadRequestError(`${fieldName} must be a string`);
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function assertOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new HttpBadRequestError(`${fieldName} must be a boolean`);
  }

  return value;
}

export function assertOptionalCwd(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  const cwd = assertOptionalString(value, 'cwd');
  if (!cwd) {
    return undefined;
  }
  if (!isAbsolute(cwd)) {
    throw new HttpBadRequestError('cwd must be an absolute path');
  }
  return cwd;
}

export function assertOptionalExtraCliArgs(value: unknown): string | undefined {
  const extraCliArgs = assertOptionalString(value, 'extraCliArgs');
  if (!extraCliArgs) {
    return undefined;
  }
  if (extraCliArgs.length > 1024) {
    throw new HttpBadRequestError('extraCliArgs too long (max 1024)');
  }

  const protectedFlags = extractUserFlags(extraCliArgs).filter((flag) =>
    PROTECTED_CLI_FLAGS.has(flag)
  );
  if (protectedFlags.length > 0) {
    throw new HttpBadRequestError(
      `extraCliArgs contains app-managed flags: ${[...new Set(protectedFlags)].join(', ')}`
    );
  }
  return extraCliArgs;
}

export function assertOptionalEffort(
  value: unknown,
  providerId: TeamLaunchRequest['providerId']
): EffortLevel | undefined {
  if (value == null) {
    return undefined;
  }

  if (!isTeamEffortLevelForProvider(value, providerId)) {
    throw new HttpBadRequestError(
      `effort must be one of: ${formatEffortLevelListForProvider(providerId)}`
    );
  }

  return value;
}

export function assertOptionalFastMode(value: unknown): TeamFastMode | undefined {
  if (value == null) {
    return undefined;
  }

  if (value !== 'inherit' && value !== 'on' && value !== 'off') {
    throw new HttpBadRequestError('fastMode must be one of: inherit, on, off');
  }

  return value;
}

export function parseProviderId(value: unknown): TeamLaunchRequest['providerId'] {
  if (value == null) {
    return 'anthropic';
  }
  if (isTeamProviderId(value)) {
    return value;
  }
  throw new HttpBadRequestError('providerId must be anthropic, codex, gemini, or opencode');
}

export function parseProviderBackendId(
  providerId: TeamLaunchRequest['providerId'],
  value: unknown
): TeamLaunchRequest['providerBackendId'] | undefined {
  const rawProviderBackendId = assertOptionalString(value, 'providerBackendId');
  const providerBackendId = migrateProviderBackendId(providerId, rawProviderBackendId);
  if (rawProviderBackendId && !providerBackendId) {
    throw new HttpBadRequestError(PROVIDER_BACKEND_ERROR);
  }
  return providerBackendId;
}

export function parseLaunchProviderBackendId(
  providerId: TeamLaunchRequest['providerId'],
  value: unknown
): TeamLaunchRequest['providerBackendId'] | undefined {
  const rawProviderBackendId = assertOptionalString(value, 'providerBackendId');
  const providerBackendId = migrateProviderBackendId(providerId, rawProviderBackendId);
  if (providerBackendId || !rawProviderBackendId) {
    return providerBackendId;
  }
  if (isTeamProviderBackendId(rawProviderBackendId)) {
    return undefined;
  }
  throw new HttpBadRequestError(PROVIDER_BACKEND_ERROR);
}

export function parseCreateMembers(
  payloadMembers: unknown,
  defaultProviderId: TeamLaunchRequest['providerId']
): TeamCreateConfigRequest['members'] {
  if (payloadMembers === undefined) {
    return [];
  }
  if (!Array.isArray(payloadMembers)) {
    throw new HttpBadRequestError('members must be an array');
  }

  const seenNames = new Set<string>();
  return payloadMembers.map((member) => {
    if (!member || typeof member !== 'object') {
      throw new HttpBadRequestError('member must be object');
    }
    const rawMember = member as Record<string, unknown>;
    const nameValidation = validateTeammateName(rawMember.name);
    if (!nameValidation.valid) {
      throw new HttpBadRequestError(nameValidation.error ?? 'Invalid member name');
    }
    const name = nameValidation.value!;
    const normalizedName = name.toLowerCase();
    if (seenNames.has(normalizedName)) {
      throw new HttpBadRequestError('member names must be unique');
    }
    seenNames.add(normalizedName);

    const role = assertOptionalString(rawMember.role, 'member role');
    const workflow = assertOptionalString(rawMember.workflow, 'member workflow');
    if (rawMember.isolation !== undefined && rawMember.isolation !== 'worktree') {
      throw new HttpBadRequestError('member isolation must be "worktree" when provided');
    }
    const providerId =
      rawMember.providerId == null ? undefined : parseProviderId(rawMember.providerId);
    const providerBackendId = parseProviderBackendId(
      providerId ?? defaultProviderId,
      rawMember.providerBackendId
    );
    const model = assertOptionalString(rawMember.model, 'member model');
    const effort = assertOptionalEffort(rawMember.effort, providerId ?? defaultProviderId);
    const fastMode = assertOptionalFastMode(rawMember.fastMode);
    const mcpPolicy = normalizeTeamMemberMcpPolicy(rawMember.mcpPolicy);

    return {
      name,
      ...(role ? { role } : {}),
      ...(workflow ? { workflow } : {}),
      ...(rawMember.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
      ...(providerId ? { providerId } : {}),
      ...(providerBackendId ? { providerBackendId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(fastMode ? { fastMode } : {}),
      ...(mcpPolicy ? { mcpPolicy } : {}),
    };
  });
}

export function parseLaunchRequest(teamName: string, body: unknown): TeamLaunchRequest {
  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const providerId = parseProviderId(payload.providerId);
  const prompt = assertOptionalString(payload.prompt, 'prompt');
  const providerBackendId = parseLaunchProviderBackendId(providerId, payload.providerBackendId);
  const model = assertOptionalString(payload.model, 'model');
  const effort = assertOptionalEffort(payload.effort, providerId ?? 'anthropic');
  const fastMode = assertOptionalFastMode(payload.fastMode);
  const limitContext = assertOptionalBoolean(payload.limitContext, 'limitContext');
  const clearContext = assertOptionalBoolean(payload.clearContext, 'clearContext');
  const skipPermissions = assertOptionalBoolean(payload.skipPermissions, 'skipPermissions');
  const worktree = assertOptionalString(payload.worktree, 'worktree');
  const extraCliArgs = assertOptionalExtraCliArgs(payload.extraCliArgs);

  return {
    teamName,
    cwd: assertAbsoluteCwd(payload.cwd),
    providerId,
    ...(providerBackendId && {
      providerBackendId,
    }),
    ...(prompt && {
      prompt,
    }),
    ...(model && {
      model,
    }),
    ...(effort && {
      effort,
    }),
    ...(fastMode && {
      fastMode,
    }),
    ...(limitContext !== undefined && {
      limitContext,
    }),
    ...(clearContext !== undefined && {
      clearContext,
    }),
    ...(skipPermissions !== undefined && {
      skipPermissions,
    }),
    ...(worktree && {
      worktree,
    }),
    ...(extraCliArgs && {
      extraCliArgs,
    }),
  };
}

export function parseCreateTeamRequest(body: unknown): TeamCreateConfigRequest {
  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const teamName = assertProvisioningTeamName(payload.teamName);
  const providerId = payload.providerId == null ? undefined : parseProviderId(payload.providerId);
  const providerBackendId = parseLaunchProviderBackendId(providerId, payload.providerBackendId);
  const displayName = assertOptionalString(payload.displayName, 'displayName');
  const description = assertOptionalString(payload.description, 'description');
  const color = assertOptionalString(payload.color, 'color');
  const cwd = assertOptionalCwd(payload.cwd);
  const prompt = assertOptionalString(payload.prompt, 'prompt');
  const model = assertOptionalString(payload.model, 'model');
  const effort = assertOptionalEffort(payload.effort, providerId ?? 'anthropic');
  const fastMode = assertOptionalFastMode(payload.fastMode);
  const limitContext = assertOptionalBoolean(payload.limitContext, 'limitContext');
  const skipPermissions = assertOptionalBoolean(payload.skipPermissions, 'skipPermissions');
  const worktree = assertOptionalString(payload.worktree, 'worktree');
  const extraCliArgs = assertOptionalExtraCliArgs(payload.extraCliArgs);

  return {
    teamName,
    members: parseCreateMembers(payload.members, providerId ?? 'anthropic'),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(color ? { color } : {}),
    ...(cwd ? { cwd } : {}),
    ...(prompt ? { prompt } : {}),
    ...(providerId ? { providerId } : {}),
    ...(providerBackendId ? { providerBackendId } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode } : {}),
    ...(limitContext !== undefined ? { limitContext } : {}),
    ...(skipPermissions !== undefined ? { skipPermissions } : {}),
    ...(worktree ? { worktree } : {}),
    ...(extraCliArgs ? { extraCliArgs } : {}),
  };
}

function getObjectPayload(body: unknown): Record<string, unknown> {
  if (body === undefined) {
    return {};
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpBadRequestError('draft launch body must be an object');
  }
  return body as Record<string, unknown>;
}

function pickOptionalString(
  payload: Record<string, unknown>,
  key: string,
  fallback: string | undefined,
  fieldName: string
): string | undefined {
  return Object.hasOwn(payload, key) ? assertOptionalString(payload[key], fieldName) : fallback;
}

function pickOptionalBoolean(
  payload: Record<string, unknown>,
  key: string,
  fallback: boolean | undefined,
  fieldName: string
): boolean | undefined {
  return Object.hasOwn(payload, key) ? assertOptionalBoolean(payload[key], fieldName) : fallback;
}

export function parseDraftLaunchCreateRequest(
  savedRequest: TeamCreateRequest,
  body: unknown
): TeamCreateRequest {
  const payload = getObjectPayload(body);
  const cwd = Object.hasOwn(payload, 'cwd') ? assertAbsoluteCwd(payload.cwd) : savedRequest.cwd;
  if (!cwd) {
    throw new HttpBadRequestError('cwd is required');
  }

  const providerId = Object.hasOwn(payload, 'providerId')
    ? parseProviderId(payload.providerId)
    : (savedRequest.providerId ?? 'anthropic');
  const providerChangedFromSaved =
    Object.hasOwn(payload, 'providerId') && providerId !== (savedRequest.providerId ?? 'anthropic');
  const providerBackendId = parseLaunchProviderBackendId(
    providerId,
    Object.hasOwn(payload, 'providerBackendId')
      ? payload.providerBackendId
      : providerChangedFromSaved
        ? undefined
        : savedRequest.providerBackendId
  );
  const effort = assertOptionalEffort(
    Object.hasOwn(payload, 'effort')
      ? payload.effort
      : providerChangedFromSaved
        ? undefined
        : savedRequest.effort,
    providerId
  );
  const fastMode = Object.hasOwn(payload, 'fastMode')
    ? assertOptionalFastMode(payload.fastMode)
    : providerChangedFromSaved
      ? undefined
      : savedRequest.fastMode;
  const extraCliArgs = Object.hasOwn(payload, 'extraCliArgs')
    ? assertOptionalExtraCliArgs(payload.extraCliArgs)
    : savedRequest.extraCliArgs;
  if (extraCliArgs) {
    assertOptionalExtraCliArgs(extraCliArgs);
  }

  return {
    teamName: savedRequest.teamName,
    displayName: savedRequest.displayName,
    description: savedRequest.description,
    color: savedRequest.color,
    members: savedRequest.members,
    cwd,
    prompt: pickOptionalString(payload, 'prompt', savedRequest.prompt, 'prompt'),
    providerId,
    ...(providerBackendId ? { providerBackendId } : {}),
    model: pickOptionalString(
      payload,
      'model',
      providerChangedFromSaved ? undefined : savedRequest.model,
      'model'
    ),
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode } : {}),
    limitContext: pickOptionalBoolean(
      payload,
      'limitContext',
      providerChangedFromSaved ? undefined : savedRequest.limitContext,
      'limitContext'
    ),
    skipPermissions: pickOptionalBoolean(
      payload,
      'skipPermissions',
      savedRequest.skipPermissions,
      'skipPermissions'
    ),
    worktree: pickOptionalString(payload, 'worktree', savedRequest.worktree, 'worktree'),
    ...(extraCliArgs ? { extraCliArgs } : {}),
  };
}

export function withRuntimeTeamName(teamName: string, body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpBadRequestError('runtime body must be an object');
  }
  const payload = body as Record<string, unknown>;
  const bodyTeamName = typeof payload.teamName === 'string' ? payload.teamName.trim() : '';
  if (bodyTeamName && bodyTeamName !== teamName) {
    throw new HttpBadRequestError('runtime body teamName must match route teamName');
  }
  return { ...payload, teamName };
}
