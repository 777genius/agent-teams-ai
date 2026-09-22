/**
 * Telemetry IPC handlers.
 *
 * Only exposes Sentry-safe anonymous context. Raw app identity stays in main.
 */

import { getCurrentSentryTelemetryContext, getMainSentryStatus } from '@main/sentry';
import {
  TELEMETRY_GET_SENTRY_CONTEXT,
  TELEMETRY_GET_SENTRY_STATUS,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants shared between main and preload
} from '@preload/constants/ipcChannels';

import type { SentryTelemetryContext } from '@main/sentry';
import type { SentryTelemetryStatus } from '@shared/types/api';
import type { IpcMain } from 'electron';

export function registerTelemetryHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(TELEMETRY_GET_SENTRY_CONTEXT, async (): Promise<SentryTelemetryContext | null> => {
    return getCurrentSentryTelemetryContext();
  });
  ipcMain.handle(TELEMETRY_GET_SENTRY_STATUS, (): SentryTelemetryStatus => getMainSentryStatus());
}

export function removeTelemetryHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TELEMETRY_GET_SENTRY_CONTEXT);
  ipcMain.removeHandler(TELEMETRY_GET_SENTRY_STATUS);
}
