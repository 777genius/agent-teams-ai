import { createLogger } from '@shared/utils/logger';

import {
  normalizeTokenUsageBudgetSettings,
  normalizeTokenUsageSnapshot,
  TOKEN_USAGE_GET_BUDGET_SETTINGS,
  TOKEN_USAGE_GET_SNAPSHOT,
  TOKEN_USAGE_REFRESH_SNAPSHOT,
  TOKEN_USAGE_SNAPSHOT_CHANGED,
  TOKEN_USAGE_UPDATE_BUDGET_SETTINGS,
  type TokenUsageAnalyticsSnapshotDto,
  type TokenUsageBudgetSettingsDto,
  type TokenUsageSnapshotRequest,
} from '../../../../contracts';

import type { TokenUsageFeatureFacade } from '../../../composition/createTokenUsageFeature';
import type { IpcMain } from 'electron';

const logger = createLogger('Feature:TokenUsage:IPC');

export function registerTokenUsageIpc(ipcMain: IpcMain, feature: TokenUsageFeatureFacade): void {
  ipcMain.handle(
    TOKEN_USAGE_GET_SNAPSHOT,
    async (
      _event,
      request?: TokenUsageSnapshotRequest
    ): Promise<TokenUsageAnalyticsSnapshotDto> => {
      try {
        const snapshot = await feature.getSnapshot(request);
        return normalizeTokenUsageSnapshot(snapshot) ?? snapshot;
      } catch (error) {
        logger.error('Failed to get token usage snapshot', error);
        throw error;
      }
    }
  );

  ipcMain.handle(
    TOKEN_USAGE_REFRESH_SNAPSHOT,
    async (event, request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto> => {
      try {
        const snapshot = await feature.refreshSnapshot(request);
        event.sender.send(TOKEN_USAGE_SNAPSHOT_CHANGED, snapshot);
        return normalizeTokenUsageSnapshot(snapshot) ?? snapshot;
      } catch (error) {
        logger.error('Failed to refresh token usage snapshot', error);
        throw error;
      }
    }
  );

  ipcMain.handle(
    TOKEN_USAGE_GET_BUDGET_SETTINGS,
    async (): Promise<TokenUsageBudgetSettingsDto> => {
      try {
        return normalizeTokenUsageBudgetSettings(await feature.getBudgetSettings());
      } catch (error) {
        logger.error('Failed to get token usage budget settings', error);
        throw error;
      }
    }
  );

  ipcMain.handle(
    TOKEN_USAGE_UPDATE_BUDGET_SETTINGS,
    async (_event, settings: TokenUsageBudgetSettingsDto): Promise<TokenUsageBudgetSettingsDto> => {
      try {
        return normalizeTokenUsageBudgetSettings(
          await feature.updateBudgetSettings(normalizeTokenUsageBudgetSettings(settings))
        );
      } catch (error) {
        logger.error('Failed to update token usage budget settings', error);
        throw error;
      }
    }
  );
}

export function removeTokenUsageIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TOKEN_USAGE_GET_SNAPSHOT);
  ipcMain.removeHandler(TOKEN_USAGE_REFRESH_SNAPSHOT);
  ipcMain.removeHandler(TOKEN_USAGE_GET_BUDGET_SETTINGS);
  ipcMain.removeHandler(TOKEN_USAGE_UPDATE_BUDGET_SETTINGS);
}
