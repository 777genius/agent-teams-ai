import path from 'node:path';

import {
  TEAM_TOOL_APPROVAL_READ_FILE,
  TEAM_TOOL_APPROVAL_RESPOND,
  TEAM_TOOL_APPROVAL_SETTINGS,
} from '@features/team-approvals/contracts';
import { validateTeamName } from '@main/ipc/guards';

import type {
  TeamApprovalsCommandPort,
  ToolApprovalFileReaderPort,
} from '../../../../core/application/ports/TeamApprovalsPorts';
import type { IpcResult, ToolApprovalFileContent, ToolApprovalSettings } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

export interface TeamApprovalsIpcLogger {
  error(message: string): void;
}

export interface TeamApprovalsIpcDependencies {
  commands: TeamApprovalsCommandPort;
  fileReader: ToolApprovalFileReaderPort;
  logger: TeamApprovalsIpcLogger;
}

async function executeCommand(
  dependencies: TeamApprovalsIpcDependencies,
  operation: string,
  command: () => Promise<void>
): Promise<IpcResult<void>> {
  try {
    await command();
    return { success: true, data: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.logger.error(`[teams:${operation}] ${message}`);
    return { success: false, error: message };
  }
}

function validateSettings(settings: unknown): IpcResult<never> | ToolApprovalSettings {
  if (typeof settings !== 'object' || settings === null) {
    return { success: false, error: 'Settings must be an object' };
  }

  const candidate = settings as Record<string, unknown>;
  if (typeof candidate.autoAllowAll !== 'boolean') {
    return { success: false, error: 'autoAllowAll must be a boolean' };
  }
  if (typeof candidate.autoAllowFileEdits !== 'boolean') {
    return { success: false, error: 'autoAllowFileEdits must be a boolean' };
  }
  if (typeof candidate.autoAllowSafeBash !== 'boolean') {
    return { success: false, error: 'autoAllowSafeBash must be a boolean' };
  }
  if (
    typeof candidate.timeoutAction !== 'string' ||
    !['allow', 'deny', 'wait'].includes(candidate.timeoutAction)
  ) {
    return { success: false, error: 'timeoutAction must be "allow", "deny", or "wait"' };
  }
  if (
    typeof candidate.timeoutSeconds !== 'number' ||
    !Number.isFinite(candidate.timeoutSeconds) ||
    candidate.timeoutSeconds < 5 ||
    candidate.timeoutSeconds > 300
  ) {
    return { success: false, error: 'timeoutSeconds must be a number between 5 and 300' };
  }

  return candidate as unknown as ToolApprovalSettings;
}

export function registerTeamApprovalsIpc(
  ipcMain: IpcMain,
  dependencies: TeamApprovalsIpcDependencies
): void {
  ipcMain.handle(
    TEAM_TOOL_APPROVAL_RESPOND,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      runId: unknown,
      requestId: unknown,
      allow: unknown,
      message?: unknown
    ): Promise<IpcResult<void>> => {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      if (typeof runId !== 'string' || runId.trim().length === 0) {
        return { success: false, error: 'runId must be a non-empty string' };
      }
      if (typeof requestId !== 'string' || requestId.trim().length === 0) {
        return { success: false, error: 'requestId must be a non-empty string' };
      }
      if (typeof allow !== 'boolean') {
        return { success: false, error: 'allow must be a boolean' };
      }

      return executeCommand(dependencies, 'toolApprovalRespond', () =>
        dependencies.commands.respond({
          teamName: validatedTeamName.value!,
          runId,
          requestId,
          allow,
          message: typeof message === 'string' ? message : undefined,
        })
      );
    }
  );

  ipcMain.handle(
    TEAM_TOOL_APPROVAL_READ_FILE,
    async (
      _event: IpcMainInvokeEvent,
      filePath: unknown
    ): Promise<IpcResult<ToolApprovalFileContent>> => {
      if (typeof filePath !== 'string' || filePath.trim().length === 0) {
        return { success: false, error: 'filePath must be a non-empty string' };
      }
      if (!path.isAbsolute(filePath)) {
        return { success: false, error: 'filePath must be an absolute path' };
      }

      try {
        return { success: true, data: await dependencies.fileReader.read(filePath) };
      } catch (error) {
        return {
          success: true,
          data: {
            content: '',
            exists: true,
            truncated: false,
            isBinary: false,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
  );

  ipcMain.handle(
    TEAM_TOOL_APPROVAL_SETTINGS,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      settings: unknown
    ): Promise<IpcResult<void>> => {
      if (typeof teamName !== 'string' || teamName.trim().length === 0) {
        return { success: false, error: 'teamName must be a non-empty string' };
      }

      const validatedSettings = validateSettings(settings);
      if ('success' in validatedSettings) return validatedSettings;

      try {
        dependencies.commands.updateSettings({
          teamName,
          settings: validatedSettings,
        });
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: `Failed to update tool approval settings: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
  );
}

export function removeTeamApprovalsIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_TOOL_APPROVAL_RESPOND);
  ipcMain.removeHandler(TEAM_TOOL_APPROVAL_READ_FILE);
  ipcMain.removeHandler(TEAM_TOOL_APPROVAL_SETTINGS);
}
