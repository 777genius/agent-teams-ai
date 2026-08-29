import {
  TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION,
  TEAM_GET_ROSTER_AUTHORIZATION_TRANSACTION_OUTCOME,
  TEAM_ROLLBACK_ROSTER_AUTHORIZATION_TRANSACTION,
} from '@shared/types/rosterAuthorizationTransaction';
import { normalizeRosterAuthorizationMembers } from '@shared/utils/rosterAuthorizationTransaction';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { normalizeTeamMemberRuntimeSelectionProvenance } from '@shared/utils/teamMemberRuntimeSelectionProvenance';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { validateTeammateName, validateTeamName } from '../guards';
import {
  parseOptionalMemberEffort,
  parseOptionalMemberProviderId,
  parseOptionalProviderBackendId,
  parseOptionalTeamFastMode,
} from '../teamIpcRequestParsers';

import type { TeamDataService } from '@main/services/team/TeamDataService';
import type {
  IpcResult,
  ReplaceMembersRequest,
  RosterAuthorizationTransactionOutcome,
} from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ParsedMembers =
  | { valid: true; members: ReplaceMembersRequest['members'] }
  | { valid: false; error: string };

function withDefined<T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V | undefined
): T & Partial<Record<K, V>> {
  return value === undefined ? target : Object.assign(target, { [key]: value });
}

export function parseReplaceMembersRequest(request: unknown): ParsedMembers {
  if (!request || typeof request !== 'object')
    return { valid: false, error: 'request must be an object' };
  const payload = request as { members?: unknown };
  if (!Array.isArray(payload.members)) return { valid: false, error: 'members must be an array' };
  const seenNames = new Set<string>();
  const members: ReplaceMembersRequest['members'] = [];
  for (const item of payload.members) {
    if (!item || typeof item !== 'object') return { valid: false, error: 'member must be object' };
    const member = item as Record<string, unknown>;
    const validatedName = validateTeammateName(member.name);
    if (!validatedName.valid)
      return { valid: false, error: validatedName.error ?? 'Invalid member name' };
    const name = validatedName.value!;
    if (seenNames.has(name)) return { valid: false, error: 'member names must be unique' };
    seenNames.add(name);
    if (member.role !== undefined && typeof member.role !== 'string')
      return { valid: false, error: 'member role must be string' };
    if (member.workflow !== undefined && typeof member.workflow !== 'string')
      return { valid: false, error: 'member workflow must be string' };
    if (member.isolation !== undefined && member.isolation !== 'worktree')
      return { valid: false, error: 'member isolation must be "worktree" when provided' };
    const provider = parseOptionalMemberProviderId(member.providerId);
    if (!provider.valid) return { valid: false, error: provider.error };
    const backend = parseOptionalProviderBackendId(member.providerBackendId, provider.value);
    if (!backend.valid) return { valid: false, error: backend.error };
    if (member.model !== undefined && typeof member.model !== 'string')
      return { valid: false, error: 'member model must be string' };
    const effort = parseOptionalMemberEffort(member.effort, provider.value);
    if (!effort.valid) return { valid: false, error: effort.error };
    const fastMode = parseOptionalTeamFastMode(member.fastMode);
    if (!fastMode.valid) return { valid: false, error: fastMode.error };
    const normalized = { name } as ReplaceMembersRequest['members'][number];
    withDefined(
      normalized,
      'role',
      typeof member.role === 'string' ? member.role.trim() : undefined
    );
    withDefined(
      normalized,
      'workflow',
      typeof member.workflow === 'string' ? member.workflow.trim() : undefined
    );
    withDefined(normalized, 'isolation', member.isolation === 'worktree' ? 'worktree' : undefined);
    withDefined(normalized, 'providerId', normalizeOptionalTeamProviderId(provider.value));
    withDefined(normalized, 'providerBackendId', backend.value);
    withDefined(
      normalized,
      'model',
      typeof member.model === 'string' ? member.model.trim() || undefined : undefined
    );
    withDefined(normalized, 'effort', effort.value);
    withDefined(
      normalized,
      'runtimeSelectionProvenance',
      normalizeTeamMemberRuntimeSelectionProvenance(member.runtimeSelectionProvenance)
    );
    withDefined(normalized, 'fastMode', fastMode.value);
    withDefined(normalized, 'mcpPolicy', normalizeTeamMemberMcpPolicy(member.mcpPolicy));
    members.push(normalized);
  }
  return { valid: true, members: normalizeRosterAuthorizationMembers(members) };
}

function validateIdentity(
  teamName: unknown,
  transactionId: unknown
): { teamName: string; transactionId: string } | { error: string } {
  const team = validateTeamName(teamName);
  if (!team.valid) return { error: team.error ?? 'Invalid teamName' };
  if (typeof transactionId !== 'string' || !UUID_PATTERN.test(transactionId))
    return { error: 'Invalid transactionId' };
  return { teamName: team.value!, transactionId };
}

async function respond(
  operation: () => Promise<RosterAuthorizationTransactionOutcome>
): Promise<IpcResult<RosterAuthorizationTransactionOutcome>> {
  try {
    return { success: true, data: await operation() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerRosterAuthorizationTransactionHandlers(
  ipcMain: IpcMain,
  getService: () => TeamDataService
): void {
  ipcMain.handle(
    TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION,
    async (_event: IpcMainInvokeEvent, teamName: unknown, request: unknown) => {
      const transactionId =
        request && typeof request === 'object'
          ? (request as { transactionId?: unknown }).transactionId
          : undefined;
      const identity = validateIdentity(teamName, transactionId);
      if ('error' in identity) return { success: false, error: identity.error };
      const parsed = parseReplaceMembersRequest(request);
      if (!parsed.valid) return { success: false, error: parsed.error };
      return respond(async () => {
        const service = getService();
        const resolved = await service.resolveRosterProviderBackends(identity.teamName, {
          members: parsed.members,
        });
        return service.beginRosterAuthorizationTransaction(
          identity.teamName,
          identity.transactionId,
          resolved
        );
      });
    }
  );
  const registerFinalizer = (
    channel: string,
    operation: (
      service: TeamDataService,
      teamName: string,
      transactionId: string
    ) => Promise<RosterAuthorizationTransactionOutcome>
  ): void =>
    ipcMain.handle(channel, async (_event, teamName: unknown, transactionId: unknown) => {
      const identity = validateIdentity(teamName, transactionId);
      return 'error' in identity
        ? { success: false, error: identity.error }
        : respond(() => operation(getService(), identity.teamName, identity.transactionId));
    });
  registerFinalizer(TEAM_GET_ROSTER_AUTHORIZATION_TRANSACTION_OUTCOME, (service, team, id) =>
    service.getRosterAuthorizationTransactionOutcome(team, id)
  );
  registerFinalizer(TEAM_ROLLBACK_ROSTER_AUTHORIZATION_TRANSACTION, (service, team, id) =>
    service.rollbackRosterAuthorizationTransaction(team, id)
  );
}

export function unregisterRosterAuthorizationTransactionHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION);
  ipcMain.removeHandler(TEAM_GET_ROSTER_AUTHORIZATION_TRANSACTION_OUTCOME);
  ipcMain.removeHandler(TEAM_ROLLBACK_ROSTER_AUTHORIZATION_TRANSACTION);
}
