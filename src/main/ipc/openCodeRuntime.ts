import {
  getLatestQualifiedOpenCodeV2Version,
  getOpenCodeV2EngineVersion,
} from '@features/opencode-compatibility';
import { parseOpenCodeInstallOptions } from '@features/opencode-runtime-installer';
import { createCapturedOpenCodeRuntimeInstaller } from '@features/opencode-runtime-installer/main';
import {
  OPENCODE_RUNTIME_GET_STATUS,
  OPENCODE_RUNTIME_INSTALL,
  OPENCODE_RUNTIME_INVALIDATE_STATUS,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants shared between main and preload
} from '@preload/constants/ipcChannels';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import {
  captureDesktopRuntimeSources,
  captureDesktopStatusRequest,
  getDesktopProviderStatusPort,
} from './agentBackend';

import type { OpenCodeRuntimeInstallerService } from '../services';
import type { IpcResult, OpenCodeRuntimeStatus } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:openCodeRuntime');

let service: OpenCodeRuntimeInstallerService | null = null;
let capturedInstaller: ReturnType<typeof createCapturedOpenCodeRuntimeInstaller> | null = null;

export function initializeOpenCodeRuntimeHandlers(
  openCodeRuntimeService: OpenCodeRuntimeInstallerService
): void {
  service = openCodeRuntimeService;
  capturedInstaller = createCapturedOpenCodeRuntimeInstaller(openCodeRuntimeService);
}

export function registerOpenCodeRuntimeHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(OPENCODE_RUNTIME_GET_STATUS, handleGetStatus);
  ipcMain.handle(OPENCODE_RUNTIME_INSTALL, handleInstall);
  ipcMain.handle(OPENCODE_RUNTIME_INVALIDATE_STATUS, handleInvalidateStatus);
  logger.info('OpenCode runtime handlers registered');
}

export function removeOpenCodeRuntimeHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(OPENCODE_RUNTIME_GET_STATUS);
  ipcMain.removeHandler(OPENCODE_RUNTIME_INSTALL);
  ipcMain.removeHandler(OPENCODE_RUNTIME_INVALIDATE_STATUS);
  logger.info('OpenCode runtime handlers removed');
}

function requireService(): OpenCodeRuntimeInstallerService {
  if (!service) {
    throw new Error('OpenCode runtime installer service is not initialized');
  }
  return service;
}

async function handleGetStatus(
  _event: IpcMainInvokeEvent
): Promise<IpcResult<OpenCodeRuntimeStatus>> {
  try {
    const native = getDesktopProviderStatusPort();
    if (!native) return { success: true, data: await requireService().getStatus() };
    const current = captureDesktopStatusRequest(_event);
    if (!current?.() || !native.readOpenCodeRuntimeStatus)
      return { success: false, error: 'Native runtime status request is not authorized' };
    const captured = await native.readOpenCodeRuntimeStatus();
    if (!current()) return { success: false, error: 'Native runtime status context changed' };
    if (captured === null)
      return { success: false, error: 'Native runtime status could not be confirmed' };
    const status = captured;
    if (!current()) return { success: false, error: 'Native runtime status context changed' };
    const result = await withV2Maintenance(_event, current, status);
    if (!current()) return { success: false, error: 'Native runtime status context changed' };
    return { success: true, data: result };
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error('Error in openCodeRuntime:getStatus:', message);
    return { success: false, error: message };
  }
}

/** Optional maintenance is observed beside the same original engine, never as its replacement. */
async function withV2Maintenance(
  event: IpcMainInvokeEvent,
  current: () => boolean,
  status: OpenCodeRuntimeStatus
): Promise<OpenCodeRuntimeStatus> {
  if (
    !status.installed ||
    status.state !== 'ready' ||
    status.v2Support !== 'ready' ||
    !status.engineVersion ||
    !status.sourceRevision
  )
    return status;
  const sources = await captureDesktopRuntimeSources(event, 'opencode');
  if (!current()) throw new Error('Native runtime status context changed');
  if (!sources) return status;
  const original = await sources.current();
  if (!current()) throw new Error('Native runtime status context changed');
  if (
    original.revision !== status.sourceRevision ||
    original.nativeGeneration !== 'v2' ||
    original.engineVersion !== status.engineVersion
  )
    throw new Error('Native runtime selection changed');
  if (
    original.cliVersion !== undefined ||
    original.configurationCurrent !== true ||
    getLatestQualifiedOpenCodeV2Version(process.platform, process.arch) !== original.engineVersion
  )
    return status;
  const identity = (selection: typeof original) => [
    selection.sourceId,
    selection.revision,
    selection.profileId,
    selection.configRevision,
    selection.sourceKind,
    selection.nativeGeneration,
    selection.cliVersion,
    selection.engineVersion,
    selection.configurationCurrent,
    selection.preferencesDigest,
  ];
  const retained = identity(original);
  let stock: OpenCodeRuntimeStatus | undefined;
  try {
    stock = await requireService().getReadinessStatus();
  } catch {
    // An optional CLI discovery failure does not alter the original engine evidence.
  }
  const observed = identity(await sources.current());
  if (!current()) throw new Error('Native runtime status context changed');
  if (observed.some((value, index) => value !== retained[index]))
    throw new Error('Native runtime selection changed');
  if (
    stock?.installed === false &&
    stock.source === 'missing' &&
    stock.state === 'idle' &&
    !stock.ignoredOverride
  )
    return { ...status, v2Maintenance: { kind: 'missing', engineVersion: status.engineVersion } };
  if (
    stock?.installed &&
    ['app-managed', 'path', 'override'].includes(stock.source) &&
    stock.version &&
    getOpenCodeV2EngineVersion(stock.version) === status.engineVersion &&
    stock.compatibleV2Version === status.engineVersion &&
    ((stock.state === 'idle' && stock.v2Support === 'required') ||
      (stock.state === 'ready' && stock.v2Support === 'ready'))
  )
    return {
      ...status,
      v2Maintenance: {
        kind: 'installed',
        cliVersion: stock.version,
        engineVersion: status.engineVersion,
        support: stock.v2Support,
      },
    };
  return status;
}

async function handleInstall(
  _event: IpcMainInvokeEvent,
  options?: unknown
): Promise<IpcResult<OpenCodeRuntimeStatus>> {
  try {
    const validated = parseOpenCodeInstallOptions(options);
    const captured = captureDesktopRuntimeSources(_event, 'opencode');
    return {
      success: true,
      data: captured
        ? await capturedInstaller!.install(await captured, validated)
        : await requireService().install(validated),
    };
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error('Error in openCodeRuntime:install:', message);
    return { success: false, error: message };
  }
}

async function handleInvalidateStatus(
  _event: IpcMainInvokeEvent,
  mode?: unknown
): Promise<IpcResult<void>> {
  try {
    if (mode !== undefined && mode !== 'cache-only')
      throw new Error('Invalid OpenCode status invalidation mode');
    if (mode === 'cache-only') {
      const native = getDesktopProviderStatusPort();
      const current = native ? captureDesktopStatusRequest(_event) : undefined;
      if (native && !current?.()) throw new Error('Native runtime status request is not authorized');
      requireService().invalidateStatusCache();
      if (native && !current?.()) throw new Error('Native runtime status context changed');
      return { success: true, data: undefined };
    }
    requireService().invalidateStatusCache();
    const captured = captureDesktopRuntimeSources(_event, 'opencode');
    if (captured) {
      const status = await capturedInstaller!.selectInstalled(await captured);
      if (status.state !== 'ready')
        throw new Error(status.error ?? 'OpenCode selection could not be confirmed.');
    }
    return { success: true, data: undefined };
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error('Error in openCodeRuntime:invalidateStatus:', message);
    return { success: false, error: message };
  }
}
