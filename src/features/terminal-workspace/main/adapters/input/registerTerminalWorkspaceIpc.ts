import {
  TERMINAL_WORKSPACE_GET_BOOTSTRAP,
  TERMINAL_WORKSPACE_STOP_TEAM,
  type TerminalWorkspaceBootstrapRequest,
} from '../../../contracts';

import type { TerminalWorkspaceFeatureFacade } from '../../composition/createTerminalWorkspaceFeature';
import type { IpcMain } from 'electron';

interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  error?: string;
}

export function registerTerminalWorkspaceIpc(
  ipcMain: IpcMain,
  feature: TerminalWorkspaceFeatureFacade
): void {
  ipcMain.handle(TERMINAL_WORKSPACE_GET_BOOTSTRAP, async (_event, rawRequest: unknown) => {
    const request = validateBootstrapRequest(rawRequest);
    if (!request.valid) {
      throw new Error(request.error ?? 'Invalid terminal workspace bootstrap request');
    }
    return feature.getBootstrap(request.value!);
  });

  ipcMain.handle(TERMINAL_WORKSPACE_STOP_TEAM, async (_event, rawTeamName: unknown) => {
    const teamName = validateTeamName(rawTeamName);
    if (!teamName.valid) {
      throw new Error(teamName.error ?? 'Invalid terminal workspace team name');
    }
    await feature.stopTeamRuntime(teamName.value!);
  });
}

export function removeTerminalWorkspaceIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TERMINAL_WORKSPACE_GET_BOOTSTRAP);
  ipcMain.removeHandler(TERMINAL_WORKSPACE_STOP_TEAM);
}

function validateBootstrapRequest(
  value: unknown
): ValidationResult<TerminalWorkspaceBootstrapRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: 'request must be an object' };
  }

  const record = value as Record<string, unknown>;
  const teamName = validateTeamName(record.teamName);
  if (!teamName.valid) {
    return { valid: false, error: teamName.error };
  }

  const projectPath = validateOptionalString(record.projectPath, 'projectPath', 4096);
  if (!projectPath.valid) {
    return { valid: false, error: projectPath.error };
  }

  const teamDisplayName = validateOptionalString(record.teamDisplayName, 'teamDisplayName', 160);
  if (!teamDisplayName.valid) {
    return { valid: false, error: teamDisplayName.error };
  }

  return {
    valid: true,
    value: {
      teamName: teamName.value!,
      projectPath: projectPath.value ?? null,
      teamDisplayName: teamDisplayName.value ?? null,
    },
  };
}

function validateTeamName(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { valid: false, error: 'teamName must be a string' };
  }

  const trimmed = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(trimmed)) {
    return { valid: false, error: 'teamName contains invalid characters' };
  }

  return { valid: true, value: trimmed };
}

function validateOptionalString(
  value: unknown,
  fieldName: string,
  maxLength: number
): ValidationResult<string | null> {
  if (value == null) {
    return { valid: true, value: null };
  }
  if (typeof value !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return { valid: false, error: `${fieldName} exceeds max length (${maxLength})` };
  }
  return { valid: true, value: trimmed || null };
}
