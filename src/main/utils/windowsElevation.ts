import { execFile } from 'child_process';
import { win32 as pathWin32 } from 'path';

import type { WindowsElevationStatus } from '@shared/types/api';

const DEFAULT_WINDOWS_ELEVATION_TIMEOUT_MS = 3_000;
const DEFAULT_WINDOWS_SYSTEM_ROOT = 'C:\\Windows';
const NON_ELEVATED_FLTMC_PATTERNS = [
  /\baccess\s+is\s+denied\b/i,
  /\baccess\s+denied\b/i,
  /\boperation\s+not\s+permitted\b/i,
  /requires?\s+elevation/i,
  /\belevated\b/i,
  /\badministrator\b/i,
  /\bprivileges?\b/i,
  /\bpermission\s+denied\b/i,
  /not\s+held\s+by\s+the\s+client/i,
];
const PROBE_UNAVAILABLE_PATTERNS = [
  /cannot\s+find/i,
  /not\s+found/i,
  /not\s+recognized/i,
  /not\s+a\s+valid\s+win32\s+application/i,
  /bad\s+exe\s+format/i,
];

export interface WindowsElevationCommandResult {
  error: unknown;
  stderr?: string | Buffer | null;
}

export interface WindowsElevationCommandOptions {
  timeoutMs: number;
}

export type WindowsElevationCommandRunner = (
  command: string,
  options: WindowsElevationCommandOptions
) => Promise<WindowsElevationCommandResult>;

export interface WindowsElevationStatusCheckerOptions {
  platform?: string;
  arch?: string;
  systemRoot?: string;
  timeoutMs?: number;
  runCommand?: WindowsElevationCommandRunner;
}

let cachedWindowsElevationStatus: Promise<WindowsElevationStatus> | null = null;

function createStatus(
  platform: string,
  isAdministrator: boolean | null,
  checkFailed: boolean,
  error: string | null = null
): WindowsElevationStatus {
  return {
    platform,
    isWindows: platform === 'win32',
    isAdministrator,
    checkFailed,
    error,
  };
}

function readErrorField(error: unknown, field: string): unknown {
  if (!error || typeof error !== 'object' || !(field in error)) {
    return undefined;
  }
  return (error as Record<string, unknown>)[field];
}

function getErrorCode(error: unknown): string | number | null {
  const code = readErrorField(error, 'code');
  return typeof code === 'string' || typeof code === 'number' ? code : null;
}

function wasKilledOrTimedOut(error: unknown): boolean {
  const killed = readErrorField(error, 'killed');
  const signal = readErrorField(error, 'signal');
  const code = getErrorCode(error);
  return killed === true || signal === 'SIGTERM' || code === 'ETIMEDOUT';
}

function isMissingCommand(error: unknown): boolean {
  return getErrorCode(error) === 'ENOENT';
}

function toCappedString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.slice(0, 500);
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8').slice(0, 500);
  }
  return null;
}

function getErrorMessage(error: unknown, stderr: unknown): string | null {
  const stderrText = toCappedString(stderr)?.trim();
  if (stderrText) {
    return stderrText;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.slice(0, 500);
  }
  return null;
}

function getCombinedErrorText(error: unknown, stderr: unknown): string {
  return [getErrorMessage(error, null), toCappedString(stderr)]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n');
}

function looksLikeNonElevatedFltmcError(error: unknown, stderr: unknown): boolean {
  const code = getErrorCode(error);
  const combined = getCombinedErrorText(error, stderr);
  if (PROBE_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(combined))) {
    return false;
  }

  if (code === 1 || code === '1' || code === 5 || code === '5') {
    return true;
  }

  return NON_ELEVATED_FLTMC_PATTERNS.some((pattern) => pattern.test(combined));
}

function normalizeWindowsRoot(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^['"]|['"]$/g, '');
  if (!normalized || !pathWin32.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function resolveWindowsSystemRoot(explicitSystemRoot: string | undefined): string {
  if (explicitSystemRoot !== undefined) {
    return normalizeWindowsRoot(explicitSystemRoot) ?? DEFAULT_WINDOWS_SYSTEM_ROOT;
  }

  return (
    normalizeWindowsRoot(process.env.SystemRoot) ??
    normalizeWindowsRoot(process.env.windir) ??
    normalizeWindowsRoot(process.env.WINDIR) ??
    DEFAULT_WINDOWS_SYSTEM_ROOT
  );
}

function getFltmcPathCandidates(systemRoot: string, arch: string): string[] {
  const systemDirs = arch === 'ia32' ? ['Sysnative', 'System32'] : ['System32'];
  return systemDirs.map((dir) => pathWin32.join(systemRoot, dir, 'fltmc.exe'));
}

function runFltmc(command: string, options: WindowsElevationCommandOptions) {
  return new Promise<WindowsElevationCommandResult>((resolve) => {
    execFile(
      command,
      [],
      { timeout: options.timeoutMs, windowsHide: true },
      (error, _stdout, stderr) => {
        resolve({ error, stderr });
      }
    );
  });
}

export function createWindowsElevationStatusChecker(
  options: WindowsElevationStatusCheckerOptions = {}
): () => Promise<WindowsElevationStatus> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const systemRoot = resolveWindowsSystemRoot(options.systemRoot);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WINDOWS_ELEVATION_TIMEOUT_MS;
  const runCommand = options.runCommand ?? runFltmc;

  return async () => {
    if (platform !== 'win32') {
      return createStatus(platform, null, false);
    }

    for (const command of getFltmcPathCandidates(systemRoot, arch)) {
      let result: WindowsElevationCommandResult;
      try {
        result = await runCommand(command, { timeoutMs });
      } catch (error) {
        if (isMissingCommand(error)) {
          continue;
        }
        return createStatus(platform, null, true, getErrorMessage(error, null));
      }

      if (!result.error) {
        return createStatus(platform, true, false);
      }

      const message = getErrorMessage(result.error, result.stderr);
      if (isMissingCommand(result.error)) {
        continue;
      }
      if (wasKilledOrTimedOut(result.error)) {
        return createStatus(platform, null, true, message);
      }
      if (looksLikeNonElevatedFltmcError(result.error, result.stderr)) {
        return createStatus(platform, false, false, message);
      }

      return createStatus(platform, null, true, message);
    }

    return createStatus(platform, null, true, 'Windows elevation probe command was not found.');
  };
}

export function getWindowsElevationStatus(): Promise<WindowsElevationStatus> {
  cachedWindowsElevationStatus ??= createWindowsElevationStatusChecker()();
  return cachedWindowsElevationStatus;
}

export function resetWindowsElevationStatusCacheForTests(): void {
  cachedWindowsElevationStatus = null;
}
