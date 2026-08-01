import {
  registerTeamApprovalsIpc as registerApprovalsIpc,
  removeTeamApprovalsIpc as removeApprovalsIpc,
} from '../adapters/input/ipc/registerTeamApprovalsIpc';

import type {
  TeamApprovalsCommandPort,
  ToolApprovalPreviewReaderPort,
} from '../../core/application/ports/TeamApprovalsPorts';

export interface TeamApprovalsIpcLogger {
  error(message: string): void;
}

export interface TeamApprovalsFeature {
  commands: TeamApprovalsCommandPort;
  previewReader: ToolApprovalPreviewReaderPort;
}

export interface TeamApprovalsIpcDependencies extends TeamApprovalsFeature {
  logger: TeamApprovalsIpcLogger;
}

export interface TeamApprovalsIpcRegistrar {
  readonly handle: CallableFunction;
  readonly removeHandler: CallableFunction;
}

export type TeamApprovalsIpcEvent = unknown;

export function registerTeamApprovalsIpc(
  ipcMain: TeamApprovalsIpcRegistrar,
  dependencies: TeamApprovalsIpcDependencies
): void {
  registerApprovalsIpc(ipcMain, dependencies);
}

export function removeTeamApprovalsIpc(ipcMain: TeamApprovalsIpcRegistrar): void {
  removeApprovalsIpc(ipcMain);
}
