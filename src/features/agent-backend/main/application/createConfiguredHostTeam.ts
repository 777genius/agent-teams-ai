import { createTeamRegistryPayloadSchema } from '@agent-teams/legacy-agent-host/team-registry/contracts';

import {
  HOST_TEAM_HISTORY_MODE_MESSAGE,
  hostTeamSelectionKey,
  TeamCreationRefusal,
} from '../../contracts';

import { assertBackendRequestGuard, BackendRoutingError } from './backendBinding';

import type { BackendHandle } from '../../contracts';
import type { BackendRequestGuard } from './backendBinding';
import type { CreateTeamRegistryPayload } from '@agent-teams/legacy-agent-host/team-registry/contracts';
import type { TeamCreateConfigResponse } from '@shared/types/team';

/** One finite product mapping is shared by save-only and immediate Create launch. */
export function captureConfiguredHostTeamDraft(
  contextId: string,
  value: unknown
): CreateTeamRegistryPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BackendRoutingError('invalid-binding');
  const raw = value as Record<string, unknown>;
  if (Object.hasOwn(raw, 'projectContextMode') && raw.projectContextMode !== 'shared') {
    const error = new TeamCreationRefusal('invalid', 'not-dispatched');
    error.message = HOST_TEAM_HISTORY_MODE_MESSAGE;
    throw error;
  }
  const allowed = new Set([
    'teamName',
    'projectContextMode',
    'runtimeSelectionVersion',
    'members',
    'cwd',
    'displayName',
    'description',
    'color',
    'prompt',
    'providerId',
    'providerBackendId',
    'model',
    'effort',
    'fastMode',
    'syncModelsWithLead',
    'limitContext',
    'skipPermissions',
    'worktree',
    'extraCliArgs',
    'allowExperimentalLocalModels',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key)) || !Array.isArray(raw.members))
    throw new BackendRoutingError('invalid-binding');
  // Host has one shared history; retain the original mode only in the caller's draft/signature.
  const { teamName, members, projectContextMode: _historyMode, ...savedSettings } = raw;
  return createTeamRegistryPayloadSchema.parse(
    JSON.parse(
      JSON.stringify({
        contextId,
        teamName,
        savedSettings,
        members: (members as unknown[]).map((member) => {
          if (!member || typeof member !== 'object' || Array.isArray(member))
            throw new BackendRoutingError('invalid-binding');
          const { name, ...memberSettings } = member as Record<string, unknown>;
          return { name, memberSettings };
        }),
      })
    )
  );
}

/** Existing Create dialog product data only. Shell supplies captured context and owner. */
export async function createConfiguredHostTeam(options: {
  feature: {
    createConfiguredTeam(
      contextId: string,
      commandId: string,
      payload: CreateTeamRegistryPayload,
      guard?: BackendRequestGuard
    ): Promise<BackendHandle>;
  };
  contextId: string;
  request: unknown;
  guard: BackendRequestGuard;
}): Promise<TeamCreateConfigResponse> {
  const value = structuredClone(options.request);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BackendRoutingError('invalid-binding');
  const raw = value as Record<string, unknown>;
  const { command, ...draft } = raw;
  if (!command || typeof command !== 'object' || Array.isArray(command))
    throw new BackendRoutingError('invalid-binding');
  const identity = command as Record<string, unknown>;
  if (
    Object.keys(identity).some((key) => !['commandId', 'idempotencyKey'].includes(key)) ||
    typeof identity.commandId !== 'string' ||
    !identity.commandId.trim() ||
    identity.commandId.length > 240 ||
    identity.commandId.includes('\0') ||
    identity.idempotencyKey !== identity.commandId
  )
    throw new BackendRoutingError('invalid-binding');
  const payload = captureConfiguredHostTeamDraft(options.contextId, draft);
  assertBackendRequestGuard(options.guard);
  const handle = await options.feature.createConfiguredTeam(
    options.contextId,
    identity.commandId,
    payload,
    options.guard
  );
  assertBackendRequestGuard(options.guard, 'unknown');
  return { teamName: hostTeamSelectionKey(handle.handleId) };
}
