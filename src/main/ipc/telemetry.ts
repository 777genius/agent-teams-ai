/**
 * Telemetry IPC handlers.
 *
 * Only exposes Sentry-safe anonymous context. Raw app identity stays in main.
 */

import { getCurrentSentryTelemetryContext } from '@main/sentry';
import {
  TELEMETRY_GET_SENTRY_CONTEXT,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants shared between main and preload
} from '@preload/constants/ipcChannels';

import type { SentryTelemetryContext } from '@main/sentry';
import type { IpcMain } from 'electron';

export function registerTelemetryHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(TELEMETRY_GET_SENTRY_CONTEXT, async (): Promise<SentryTelemetryContext | null> => {
    return getCurrentSentryTelemetryContext();
  });
}

export function removeTelemetryHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TELEMETRY_GET_SENTRY_CONTEXT);
}
