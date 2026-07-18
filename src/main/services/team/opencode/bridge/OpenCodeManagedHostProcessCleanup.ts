import {
  listRuntimeProcessTableForCurrentPlatform,
  type RuntimeProcessTableRow,
} from '@features/tmux-installer/main';
import { killProcessByPid, killProcessByPidAndWait } from '@main/utils/processKill';
import { listWindowsProcessTable } from '@main/utils/windowsProcessTable';
import { execFile, type ExecFileException } from 'child_process';

export type OpenCodeManagedHostCleanupMode = 'orphaned' | 'force';

export interface OpenCodeManagedHostCleanupCandidate {
  pid: number;
  ppid: number;
  action: 'killed' | 'kept_excluded' | 'kept_recent' | 'kept_unmanaged' | 'failed';
  reason: string;
}

export interface OpenCodeManagedHostCleanupResult {
  scanned: number;
  killed: number;
  candidates: OpenCodeManagedHostCleanupCandidate[];
  diagnostics: string[];
}

export interface OpenCodeManagedHostProcessCleanupOptions {
  mode: OpenCodeManagedHostCleanupMode;
  excludePids?: ReadonlySet<number>;
  requiredDetailsMarkers?: readonly string[];
  requiredServeConfigMarkersAny?: readonly string[];
  startedBeforeMs?: number | null;
  platform?: NodeJS.Platform;
  listProcessRows?: () => Promise<RuntimeProcessTableRow[]>;
  readProcessDetails?: (pid: number) => Promise<string | null>;
  readProcessStartTimeMs?: (pid: number) => Promise<number | null>;
  readServeHostConfig?: (baseUrl: string) => Promise<string | null>;
  disposeServeHost?: (baseUrl: string) => Promise<void>;
  killProcess?: (pid: number) => void | Promise<void>;
  forceKillProcess?: (pid: number) => void | Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  sleepMs?: (ms: number) => Promise<void>;
}

const OPENCODE_SERVE_COMMAND_RE =
  /(^|[/\\\s"])opencode(?:\.exe)?(?:"?)(?=\s|$).*?(?:^|\s)serve(?=\s|$)/i;
const WINDOWS_APP_MANAGED_OPENCODE_SERVE_RE =
  /[\\/]runtimes[\\/]opencode[\\/]versions[\\/][^"'\s]+[\\/]opencode-windows-[^"'\s]+[\\/]opencode\.exe(?:"|\s|$)/i;
const MANAGED_ENV_MARKERS = ['CLAUDE_MULTIMODEL_DATA_HOME=', 'OPENCODE_CONFIG_CONTENT='] as const;
const MANAGED_ENV_IDENTITY_MARKERS = [
  'AGENT_TEAMS_MCP_CLAUDE_DIR=',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY=',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL=',
] as const;
const MANAGED_INLINE_OPENCODE_CONFIG_PATTERNS = [
  /OPENCODE_CONFIG_CONTENT=[\s\S]*"mcp"\s*:\s*\{[\s\S]*"agent-teams(?:-runtime-\d+)?"/i,
  /OPENCODE_CONFIG_CONTENT=[\s\S]*"claude-multimodel runtime orchestration"/i,
  /OPENCODE_CONFIG_CONTENT=[\s\S]*"(?:agent-teams|agent_teams|mcp__agent-teams|mcp__agent_teams)_\*"/i,
] as const;

export async function cleanupManagedOpenCodeServeProcesses(
  options: OpenCodeManagedHostProcessCleanupOptions
): Promise<OpenCodeManagedHostCleanupResult> {
  const platform = options.platform ?? process.platform;
  const result: OpenCodeManagedHostCleanupResult = {
    scanned: 0,
    killed: 0,
    candidates: [],
    diagnostics: [],
  };

  const listProcessRows =
    options.listProcessRows ??
    (platform === 'win32'
      ? () => listWindowsProcessTable(4_000, { bypassCache: true })
      : () => listRuntimeProcessTableForCurrentPlatform({ bypassCache: true }));
  const rows = await listProcessRows();
  const excludePids = options.excludePids ?? new Set<number>();
  const requiredDetailsMarkers = options.requiredDetailsMarkers ?? [];
  const requiredServeConfigMarkersAny = options.requiredServeConfigMarkersAny ?? [];
  const readDetails =
    options.readProcessDetails ??
    (platform === 'win32' ? async () => null : readNativeProcessCommandWithEnv);
  const readStartTimeMs =
    options.readProcessStartTimeMs ??
    (platform === 'win32' ? readWindowsProcessStartTimeMs : readNativeProcessStartTimeMs);
  const disposeServeHost = options.disposeServeHost ?? disposeOpenCodeServeHost;
  const readServeHostConfig = options.readServeHostConfig ?? readOpenCodeServeHostConfig;
  const killProcess = options.killProcess;
  const forceKillProcess =
    options.forceKillProcess ?? ((pid: number) => process.kill(pid, 'SIGKILL'));
  const isProcessAlive = options.isProcessAlive ?? isNativeProcessAlive;
  const sleepMs = options.sleepMs ?? sleep;

  for (const row of rows) {
    if (!isOpenCodeServeCommand(row.command)) {
      continue;
    }
    result.scanned += 1;

    if (excludePids.has(row.pid)) {
      result.candidates.push({
        pid: row.pid,
        ppid: row.ppid,
        action: 'kept_excluded',
        reason: 'pid is known to the bridge host registry cleanup result',
      });
      continue;
    }

    const baseUrl = getOpenCodeServeLoopbackBaseUrl(row.command);
    const details = await readDetails(row.pid);
    const isManagedByWindowsCommand =
      platform === 'win32' && isAppManagedWindowsOpenCodeServeCommand(row.command);
    const isManaged =
      isManagedByWindowsCommand ||
      Boolean(details && isManagedOpenCodeServeProcessDetails(details));
    const hasRequiredDetailsMarkers =
      requiredDetailsMarkers.length === 0 ||
      Boolean(details && processDetailsIncludeMarkers(details, requiredDetailsMarkers));
    const serveConfig =
      requiredServeConfigMarkersAny.length > 0 && baseUrl
        ? await readServeHostConfig(baseUrl).catch(() => null)
        : null;
    const hasRequiredServeConfigMarker =
      requiredServeConfigMarkersAny.length === 0 ||
      Boolean(serveConfig && stringIncludesAnyMarker(serveConfig, requiredServeConfigMarkersAny));
    if (!isManaged || !hasRequiredDetailsMarkers || !hasRequiredServeConfigMarker) {
      result.candidates.push({
        pid: row.pid,
        ppid: row.ppid,
        action: 'kept_unmanaged',
        reason: !isManaged
          ? platform === 'win32'
            ? 'process is not an app-managed Windows OpenCode serve command'
            : 'process does not carry Agent Teams managed OpenCode environment markers'
          : 'process ownership markers do not match the current app instance',
      });
      continue;
    }

    const shouldTrackStartTime =
      platform === 'win32' ||
      typeof options.startedBeforeMs === 'number' ||
      requiredDetailsMarkers.length > 0 ||
      requiredServeConfigMarkersAny.length > 0;
    const startedAtMs = shouldTrackStartTime ? await readStartTimeMs(row.pid) : null;
    if (shouldTrackStartTime && !Number.isFinite(startedAtMs)) {
      if (!isProcessAlive(row.pid)) {
        result.killed += 1;
        result.candidates.push({
          pid: row.pid,
          ppid: row.ppid,
          action: 'killed',
          reason: 'managed OpenCode serve exited before cleanup signal',
        });
        continue;
      }
      if (platform === 'win32') {
        const reason = 'Windows process start time could not be verified';
        result.diagnostics.push(
          `Skipped managed OpenCode serve pid=${row.pid}: ${reason.toLowerCase()}`
        );
        result.candidates.push({
          pid: row.pid,
          ppid: row.ppid,
          action: 'failed',
          reason,
        });
        continue;
      }
    }
    if (options.mode === 'orphaned') {
      if (
        typeof options.startedBeforeMs === 'number' &&
        (!Number.isFinite(startedAtMs) ||
          startedAtMs === null ||
          startedAtMs >= options.startedBeforeMs)
      ) {
        result.candidates.push({
          pid: row.pid,
          ppid: row.ppid,
          action: 'kept_recent',
          reason: 'process started after this app instance began',
        });
        continue;
      }
      const parentMayStillOwnProcess =
        platform === 'win32' ? row.ppid > 0 && isProcessAlive(row.ppid) : row.ppid !== 1;
      if (parentMayStillOwnProcess) {
        result.candidates.push({
          pid: row.pid,
          ppid: row.ppid,
          action: 'kept_recent',
          reason: 'process is still parented and may belong to an active bridge command',
        });
        continue;
      }
    }

    try {
      const confirmCandidateIdentity = async (): Promise<'confirmed' | 'gone' | 'changed'> => {
        let startTimeMatches = false;
        let ownershipMarkerMatches = false;
        if (Number.isFinite(startedAtMs) && startedAtMs !== null) {
          const currentStartedAtMs = await readStartTimeMs(row.pid);
          if (currentStartedAtMs !== startedAtMs) {
            return isProcessAlive(row.pid) ? 'changed' : 'gone';
          }
          startTimeMatches = true;
        }
        if (requiredDetailsMarkers.length > 0) {
          const currentDetails = await readDetails(row.pid);
          if (currentDetails) {
            if (!processDetailsIncludeMarkers(currentDetails, requiredDetailsMarkers)) {
              return isProcessAlive(row.pid) ? 'changed' : 'gone';
            }
            ownershipMarkerMatches = true;
          }
        }
        if (requiredServeConfigMarkersAny.length > 0) {
          const currentServeConfig = baseUrl
            ? await readServeHostConfig(baseUrl).catch(() => null)
            : null;
          if (currentServeConfig) {
            if (!stringIncludesAnyMarker(currentServeConfig, requiredServeConfigMarkersAny)) {
              return isProcessAlive(row.pid) ? 'changed' : 'gone';
            }
            ownershipMarkerMatches = true;
          }
        }
        if (startTimeMatches) {
          return 'confirmed';
        }
        if (ownershipMarkerMatches) {
          return isProcessAlive(row.pid) ? 'confirmed' : 'gone';
        }
        if (
          !shouldTrackStartTime &&
          requiredDetailsMarkers.length === 0 &&
          requiredServeConfigMarkersAny.length === 0
        ) {
          return 'confirmed';
        }
        return isProcessAlive(row.pid) ? 'changed' : 'gone';
      };

      const identityBeforeDispose = await confirmCandidateIdentity();
      if (identityBeforeDispose === 'gone') {
        result.killed += 1;
        result.candidates.push({
          pid: row.pid,
          ppid: row.ppid,
          action: 'killed',
          reason: 'managed OpenCode serve exited before graceful dispose',
        });
        continue;
      }
      if (identityBeforeDispose === 'changed') {
        result.candidates.push({
          pid: row.pid,
          ppid: row.ppid,
          action: 'kept_unmanaged',
          reason: 'pid identity changed before graceful dispose',
        });
        continue;
      }

      if (baseUrl) {
        await disposeServeHost(baseUrl).catch(() => undefined);
      }

      const identityBeforeKill = await confirmCandidateIdentity();
      if (identityBeforeKill === 'gone') {
        result.killed += 1;
        result.candidates.push({
          pid: row.pid,
          ppid: row.ppid,
          action: 'killed',
          reason: 'managed OpenCode serve exited during graceful dispose',
        });
        continue;
      }
      if (identityBeforeKill === 'changed') {
        result.candidates.push({
          pid: row.pid,
          ppid: row.ppid,
          action: 'kept_unmanaged',
          reason: 'pid identity changed before cleanup signal',
        });
        continue;
      }

      try {
        if (killProcess) {
          await killProcess(row.pid);
        } else if (platform === 'win32') {
          await killProcessByPidAndWait(row.pid, {
            platform,
            confirmTargetIdentity: async () =>
              Number.isFinite(startedAtMs) &&
              startedAtMs !== null &&
              (await readStartTimeMs(row.pid)) === startedAtMs,
          });
        } else {
          killProcessByPid(row.pid);
        }
      } catch (error) {
        if (isProcessAlive(row.pid)) {
          throw error;
        }
      }
      if (options.mode === 'force' && isProcessAlive(row.pid)) {
        await sleepMs(250);
        if (isProcessAlive(row.pid)) {
          const identityBeforeForceKill = await confirmCandidateIdentity();
          if (identityBeforeForceKill === 'confirmed') {
            try {
              await forceKillProcess(row.pid);
            } catch (error) {
              if (isProcessAlive(row.pid)) {
                throw error;
              }
            }
          } else if (identityBeforeForceKill === 'changed') {
            result.diagnostics.push(
              `Skipped force kill for managed OpenCode serve pid=${row.pid}: pid identity changed`
            );
            result.candidates.push({
              pid: row.pid,
              ppid: row.ppid,
              action: 'kept_unmanaged',
              reason: 'pid identity changed before force kill',
            });
            continue;
          }
        }
      }
      if (isProcessAlive(row.pid)) {
        throw new Error(`managed OpenCode serve pid=${row.pid} remained alive after cleanup`);
      }
      result.killed += 1;
      result.candidates.push({
        pid: row.pid,
        ppid: row.ppid,
        action: 'killed',
        reason: `managed OpenCode serve ${options.mode === 'force' ? 'cleanup' : 'orphan cleanup'}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.diagnostics.push(`Failed to kill managed OpenCode serve pid=${row.pid}: ${message}`);
      result.candidates.push({
        pid: row.pid,
        ppid: row.ppid,
        action: 'failed',
        reason: message,
      });
    }
  }

  return result;
}

export function isOpenCodeServeCommand(command: string): boolean {
  return OPENCODE_SERVE_COMMAND_RE.test(command.trim());
}

export function isAppManagedWindowsOpenCodeServeCommand(command: string): boolean {
  const normalizedCommand = command.trim().replace(/\//g, '\\');
  return (
    isOpenCodeServeCommand(normalizedCommand) &&
    WINDOWS_APP_MANAGED_OPENCODE_SERVE_RE.test(normalizedCommand)
  );
}

export function isManagedOpenCodeServeProcessDetails(details: string): boolean {
  return (
    processDetailsIncludeMarkers(details, MANAGED_ENV_MARKERS) &&
    (MANAGED_ENV_IDENTITY_MARKERS.some((marker) => processDetailsIncludeMarker(details, marker)) ||
      MANAGED_INLINE_OPENCODE_CONFIG_PATTERNS.some((pattern) => pattern.test(details)))
  );
}

export function getOpenCodeServeLoopbackBaseUrl(command: string): string | null {
  const portMatch = /(?:^|\s)--port(?:=|\s+)(\d{1,5})(?=\s|$)/.exec(command);
  if (!portMatch) {
    return null;
  }
  const port = Number.parseInt(portMatch[1], 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return null;
  }

  const hostnameMatch = /(?:^|\s)--hostname(?:=|\s+)(\S+)(?=\s|$)/.exec(command);
  const hostname = hostnameMatch?.[1] ?? '127.0.0.1';
  if (!isLoopbackHostname(hostname)) {
    return null;
  }
  const normalizedHostname = hostname === '::1' ? '[::1]' : hostname;
  return `http://${normalizedHostname}:${port}`;
}

function processDetailsIncludeMarkers(details: string, markers: readonly string[]): boolean {
  return markers.every((marker) => processDetailsIncludeMarker(details, marker));
}

function processDetailsIncludeMarker(details: string, marker: string): boolean {
  const valueBoundary = marker.endsWith('=') ? '' : '(?=\\s|$)';
  return new RegExp(`(^|\\s)${escapeRegExp(marker)}${valueBoundary}`).test(details);
}

function stringIncludesAnyMarker(value: string, markers: readonly string[]): boolean {
  return markers.some((marker) => marker.length > 0 && value.includes(marker));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

async function disposeOpenCodeServeHost(baseUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    await fetch(`${baseUrl}/global/dispose`, {
      method: 'POST',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readOpenCodeServeHostConfig(baseUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(`${baseUrl}/config`, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readNativeProcessCommandWithEnv(pid: number): Promise<string | null> {
  return execFileText('ps', ['eww', '-p', String(pid), '-o', 'command='], 2_000, 2 * 1024 * 1024);
}

async function readNativeProcessStartTimeMs(pid: number): Promise<number | null> {
  const output = await execFileText('ps', ['-p', String(pid), '-o', 'lstart='], 2_000, 64 * 1024);
  if (!output) {
    return null;
  }
  const parsed = Date.parse(output.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

async function readWindowsProcessStartTimeMs(pid: number): Promise<number | null> {
  const normalizedPid = Math.trunc(pid);
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) {
    return null;
  }

  const script = [
    '$ErrorActionPreference = "Stop"',
    `$process = Get-Process -Id ${normalizedPid} -ErrorAction Stop`,
    '$process.StartTime.ToUniversalTime().ToString("o")',
  ].join('; ');
  const output = await execFileText(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    2_000,
    64 * 1024
  );
  if (!output) {
    return null;
  }
  const parsed = Date.parse(output.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function isNativeProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileText(
  command: string,
  args: string[],
  timeout: number,
  maxBuffer: number
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string | Buffer) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}
