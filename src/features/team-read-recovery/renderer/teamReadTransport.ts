import { api } from '@renderer/api';

import { parseTeamReadFailure } from '../core/domain/parseTeamReadFailure';

import type { TeamReadFailureMetadata } from '../contracts';
import type { TeamsAPI } from '@shared/types/api';
import type { IpcResult } from '@shared/types/ipc';

export class TeamReadTransportError extends Error {
  constructor(
    message: string,
    public readonly failure?: TeamReadFailureMetadata
  ) {
    super(message);
    this.name = 'TeamReadTransportError';
  }
}

async function readResult<T>(
  legacy: () => Promise<T>,
  raw?: () => Promise<IpcResult<T>>
): Promise<T> {
  if (!raw) return legacy();
  const result = await raw();
  if (!result || typeof result !== 'object' || typeof result.success !== 'boolean') {
    throw new TeamReadTransportError('Invalid team read response');
  }
  if (!result.success) {
    throw new TeamReadTransportError(
      typeof result.error === 'string' ? result.error : 'Unknown error',
      parseTeamReadFailure(result.failure)
    );
  }
  return result.data as T;
}

export function readTeamData(
  ...args: Parameters<TeamsAPI['getData']>
): ReturnType<TeamsAPI['getData']> {
  const teams = api.teams;
  const raw = teams.readRecovery;
  const callArgs: Parameters<TeamsAPI['getData']> = args[1] === undefined ? [args[0]] : args;
  return readResult(() => teams.getData(...callArgs), raw && (() => raw.getData(...callArgs)));
}

export function readTeamMessagesPage(
  ...args: Parameters<TeamsAPI['getMessagesPage']>
): ReturnType<TeamsAPI['getMessagesPage']> {
  const teams = api.teams;
  const raw = teams.readRecovery;
  return readResult(
    () => teams.getMessagesPage(...args),
    raw && (() => raw.getMessagesPage(...args))
  );
}

export function readTeamMemberActivity(
  ...args: Parameters<TeamsAPI['getMemberActivityMeta']>
): ReturnType<TeamsAPI['getMemberActivityMeta']> {
  const teams = api.teams;
  const raw = teams.readRecovery;
  return readResult(
    () => teams.getMemberActivityMeta(...args),
    raw && (() => raw.getMemberActivityMeta(...args))
  );
}

export function readTeamTaskLogs(
  ...args: Parameters<TeamsAPI['getLogsForTask']>
): ReturnType<TeamsAPI['getLogsForTask']> {
  const teams = api.teams;
  const raw = teams.readRecovery;
  return readResult(
    () => teams.getLogsForTask(...args),
    raw && (() => raw.getLogsForTask(...args))
  );
}
