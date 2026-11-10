import {
  TOKEN_USAGE_BUDGET_STATUS_CHANGED,
  TOKEN_USAGE_GET_BUDGET_SETTINGS,
  TOKEN_USAGE_GET_BUDGET_STATUS,
  TOKEN_USAGE_GET_SNAPSHOT,
  TOKEN_USAGE_REFRESH_SNAPSHOT,
  TOKEN_USAGE_SNAPSHOT_CHANGED,
  TOKEN_USAGE_UPDATE_BUDGET_SETTINGS,
  type TokenUsageAnalyticsSnapshotDto,
  type TokenUsageBudgetSettingsUpdateRequestDto,
  type TokenUsageBudgetStatusDto,
  type TokenUsageElectronApi,
  type TokenUsageSnapshotRequest,
} from '../contracts';

import type { IpcRenderer, IpcRendererEvent } from 'electron';

export function createTokenUsageBridge(
  ipcRenderer: IpcRenderer
): TokenUsageElectronApi['tokenUsage'] {
  return {
    getSnapshot: (request?: TokenUsageSnapshotRequest) =>
      ipcRenderer.invoke(TOKEN_USAGE_GET_SNAPSHOT, request),
    refreshSnapshot: (request?: TokenUsageSnapshotRequest) =>
      ipcRenderer.invoke(TOKEN_USAGE_REFRESH_SNAPSHOT, request),
    getBudgetStatus: () => ipcRenderer.invoke(TOKEN_USAGE_GET_BUDGET_STATUS),
    onBudgetStatusChanged: (callback) => {
      const listener = (_event: IpcRendererEvent, status: TokenUsageBudgetStatusDto): void =>
        callback(status);
      ipcRenderer.on(TOKEN_USAGE_BUDGET_STATUS_CHANGED, listener);
      return () => ipcRenderer.removeListener(TOKEN_USAGE_BUDGET_STATUS_CHANGED, listener);
    },
    getBudgetSettings: () => ipcRenderer.invoke(TOKEN_USAGE_GET_BUDGET_SETTINGS),
    updateBudgetSettings: (settings: TokenUsageBudgetSettingsUpdateRequestDto) =>
      ipcRenderer.invoke(TOKEN_USAGE_UPDATE_BUDGET_SETTINGS, settings),
    onSnapshotChanged: (callback: (snapshot: TokenUsageAnalyticsSnapshotDto) => void) => {
      const listener = (
        _event: IpcRendererEvent,
        snapshot: TokenUsageAnalyticsSnapshotDto
      ): void => {
        callback(snapshot);
      };
      ipcRenderer.on(TOKEN_USAGE_SNAPSHOT_CHANGED, listener);
      return () => ipcRenderer.removeListener(TOKEN_USAGE_SNAPSHOT_CHANGED, listener);
    },
  };
}
