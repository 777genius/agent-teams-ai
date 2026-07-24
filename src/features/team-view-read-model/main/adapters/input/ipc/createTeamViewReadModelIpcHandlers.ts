import { validateTeamName } from '@main/ipc/guards';

import { executeTeamViewReadHandler } from './executeTeamViewReadHandler';

import type { TeamViewReadModelIpcDependencies } from './TeamViewReadModelIpcDependencies';
import type {
  IpcResult,
  MessagesPage,
  TeamGetDataOptions,
  TeamMemberActivityMeta,
  TeamViewSnapshot,
} from '@shared/types';
import type { IpcMainInvokeEvent } from 'electron';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateTeamGetDataOptions(
  value: unknown
): { valid: true; value: TeamGetDataOptions | undefined } | { valid: false; error: string } {
  if (value === undefined) {
    return { valid: true, value: undefined };
  }
  if (!isPlainObject(value)) {
    return { valid: false, error: 'options must be an object' };
  }
  const allowed = new Set(['includeMemberBranches']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return { valid: false, error: `Unknown getData option: ${key}` };
    }
  }
  const includeMemberBranches = value.includeMemberBranches;
  if (includeMemberBranches !== undefined && typeof includeMemberBranches !== 'boolean') {
    return { valid: false, error: 'includeMemberBranches must be a boolean' };
  }
  return {
    valid: true,
    value: includeMemberBranches === false ? { includeMemberBranches: false } : undefined,
  };
}

export function createTeamViewReadModelIpcHandlers(
  dependencies: TeamViewReadModelIpcDependencies
): {
  getData(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    options?: unknown
  ): Promise<IpcResult<TeamViewSnapshot>>;
  getMessagesPage(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    options: unknown
  ): Promise<IpcResult<MessagesPage>>;
  getMemberActivityMeta(
    event: IpcMainInvokeEvent,
    teamName: unknown
  ): Promise<IpcResult<TeamMemberActivityMeta>>;
} {
  return {
    async getData(_event, teamName, options) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedOptions = validateTeamGetDataOptions(options);
      if (!validatedOptions.valid) {
        return { success: false, error: validatedOptions.error };
      }
      const result = await dependencies.getTeamView.execute(
        validatedTeamName.value!,
        validatedOptions.value
      );
      return result.kind === 'success'
        ? { success: true, data: result.data }
        : { success: false, error: result.error };
    },

    async getMessagesPage(_event, teamName, options) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const parsedOptions = (options && typeof options === 'object' ? options : {}) as {
        cursor?: string | null;
        limit?: number;
      };
      const limit = Math.min(Math.max(1, parsedOptions.limit ?? 50), 200);
      const cursor =
        typeof parsedOptions.cursor === 'string'
          ? parsedOptions.cursor
          : parsedOptions.cursor === null
            ? null
            : undefined;
      return executeTeamViewReadHandler(dependencies, 'getMessagesPage', () =>
        dependencies.getMessagesPage.execute({
          teamName: validatedTeamName.value!,
          cursor,
          limit,
        })
      );
    },

    async getMemberActivityMeta(_event, teamName) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      return executeTeamViewReadHandler(dependencies, 'getMemberActivityMeta', () =>
        dependencies.getMemberActivityMeta.execute(validatedTeamName.value!)
      );
    },
  };
}
