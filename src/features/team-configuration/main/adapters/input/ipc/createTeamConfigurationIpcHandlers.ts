import { validateTeamName } from '@main/ipc/guards';

import { normalizeCreateTeamConfigRequest } from './normalizeCreateTeamConfigRequest';

import type { TeamConfigurationIpcDependencies } from './TeamConfigurationIpcDependencies';
import type {
  IpcResult,
  TeamConfig,
  TeamCreateRequest,
  TeamUpdateConfigRequest,
} from '@shared/types';

export function createTeamConfigurationIpcHandlers(
  dependencies: TeamConfigurationIpcDependencies
): {
  createConfig: (_event: unknown, request: unknown) => Promise<IpcResult<void>>;
  updateConfig: (
    _event: unknown,
    teamName: unknown,
    updates: unknown
  ) => Promise<IpcResult<TeamConfig>>;
  getSavedRequest: (
    _event: unknown,
    teamName: unknown
  ) => Promise<IpcResult<TeamCreateRequest | null>>;
  deleteDraft: (_event: unknown, teamName: unknown) => Promise<IpcResult<void>>;
} {
  const execute = async <T>(
    operation: string,
    handler: () => Promise<T>
  ): Promise<IpcResult<T>> => {
    try {
      return { success: true, data: await handler() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.error(`[teams:${operation}] ${message}`);
      return { success: false, error: message };
    }
  };

  return {
    createConfig: async (_event, request) => {
      const normalized = normalizeCreateTeamConfigRequest(request);
      if (!normalized.valid) {
        return { success: false, error: normalized.error };
      }
      return execute('createConfig', () => dependencies.createConfig.execute(normalized.value));
    },

    updateConfig: async (_event, teamName, updates) => {
      const validated = validateTeamName(teamName);
      if (!validated.valid) {
        return { success: false, error: validated.error ?? 'Invalid teamName' };
      }
      if (!updates || typeof updates !== 'object') {
        return { success: false, error: 'Invalid updates object' };
      }
      const { name, description, color } = updates as TeamUpdateConfigRequest;
      if (name !== undefined && typeof name !== 'string') {
        return { success: false, error: 'name must be a string' };
      }
      if (description !== undefined && typeof description !== 'string') {
        return { success: false, error: 'description must be a string' };
      }
      if (color !== undefined && typeof color !== 'string') {
        return { success: false, error: 'color must be a string' };
      }
      return execute('updateConfig', () =>
        dependencies.updateConfig.execute(validated.value!, { name, description, color })
      );
    },

    getSavedRequest: async (_event, teamName) => {
      const validated = validateTeamName(teamName);
      if (!validated.valid) {
        return { success: false, error: validated.error ?? 'Invalid teamName' };
      }
      return execute('getSavedRequest', () =>
        dependencies.getSavedRequest.execute(validated.value!)
      );
    },

    deleteDraft: async (_event, teamName) => {
      const validated = validateTeamName(teamName);
      if (!validated.valid) {
        return { success: false, error: validated.error ?? 'Invalid teamName' };
      }
      return execute('deleteDraft', () => dependencies.deleteDraft.execute(validated.value!));
    },
  };
}
