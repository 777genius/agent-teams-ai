import { TMUX_GET_STATUS } from '@preload/constants/ipcChannels';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { execFile } from 'child_process';

import type { IpcResult, TmuxPlatform, TmuxStatus } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:tmux');

let cachedStatus: { value: TmuxStatus; at: number } | null = null;
let statusInFlight: Promise<TmuxStatus> | null = null;
const STATUS_CACHE_TTL_MS = 10_000;

function mapPlatform(platform: NodeJS.Platform): TmuxPlatform {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform;
  }
  return 'unknown';
}

function execFileAsync(
  command: string,
  args: string[],
  timeout: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function resolveBinaryPath(platform: TmuxPlatform): Promise<string | null> {
  const locator = platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(locator, ['tmux'], 2_000);
    const firstLine = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstLine ?? null;
  } catch {
    return null;
  }
}

async function computeTmuxStatus(): Promise<TmuxStatus> {
  const platform = mapPlatform(process.platform);
  const nativeSupported = platform === 'darwin' || platform === 'linux';
  const checkedAt = new Date().toISOString();

  try {
    const { stdout, stderr } = await execFileAsync('tmux', ['-V'], 3_000);
    const version = (stdout || stderr).trim() || null;
    const binaryPath = await resolveBinaryPath(platform);
    return {
      available: true,
      version,
      binaryPath,
      platform,
      nativeSupported,
      checkedAt,
      error: null,
    };
  } catch (error) {
    const message = getErrorMessage(error);
    const missing =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ((error as { code?: string }).code === 'ENOENT' ||
        (error as { code?: string }).code === 'ENOEXEC');

    if (missing) {
      return {
        available: false,
        version: null,
        binaryPath: null,
        platform,
        nativeSupported,
        checkedAt,
        error: null,
      };
    }

    logger.warn(`tmux status check failed: ${message}`);
    return {
      available: false,
      version: null,
      binaryPath: null,
      platform,
      nativeSupported,
      checkedAt,
      error: message,
    };
  }
}

async function handleGetStatus(_event: IpcMainInvokeEvent): Promise<IpcResult<TmuxStatus>> {
  try {
    if (cachedStatus && Date.now() - cachedStatus.at < STATUS_CACHE_TTL_MS) {
      return { success: true, data: cachedStatus.value };
    }

    if (!statusInFlight) {
      statusInFlight = computeTmuxStatus()
        .then((status) => {
          cachedStatus = { value: status, at: Date.now() };
          return status;
        })
        .finally(() => {
          statusInFlight = null;
        });
    }

    const status = await statusInFlight;
    return { success: true, data: status };
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error('Error in tmux:getStatus:', message);
    return { success: false, error: message };
  }
}

export function registerTmuxHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(TMUX_GET_STATUS, handleGetStatus);
  logger.info('tmux handlers registered');
}

export function removeTmuxHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TMUX_GET_STATUS);
  logger.info('tmux handlers removed');
}
