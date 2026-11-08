import { execFile, type ExecFileException } from 'child_process';

import type { OpenCodeStartupCleanupBudget } from './OpenCodeStartupCleanupBudget';
import type { RuntimeProcessTableRow } from '@features/tmux-installer/main';

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
  startupBudget?: OpenCodeStartupCleanupBudget;
  canAdmitStartupWork?: () => boolean;
  mode: OpenCodeManagedHostCleanupMode;
  excludePids?: ReadonlySet<number>;
  requiredDetailsMarkers?: readonly string[];
  requiredProfileScope?: string;
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
// Command and configuration recognizers below are diagnostic observations only.
// Even an app installation path or copied ownership marker cannot grant native custody.
const ORCHESTRATOR_SERVE_COMMAND_RE =
  /(^|[/\\\s"])claude-multimodel(?:\.exe)?(?:"?)(?=\s|$).*?(?:^|\s)serve(?=\s|$)/i;
const WINDOWS_APP_MANAGED_OPENCODE_SERVE_RE =
  /[\\/]runtimes[\\/]opencode[\\/]versions[\\/][^"'\s]+[\\/]opencode-windows-[^"'\s]+[\\/]opencode\.exe(?:"|\s|$)/i;
// Recognizable app configuration hints. These may be copied by another process
// and remain diagnostic data, regardless of how many markers match.
const MANAGED_SERVE_HOST_CONFIG_PATTERNS = [
  /agent-teams-app-instance=/i,
  /"AGENT_TEAMS_MCP_CLAUDE_DIR"/,
  /claude-multimodel runtime orchestration/i,
] as const;
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

/**
 * Compatibility port for lifecycle callers. The generic implementation cannot
 * establish retained native custody and stays disabled. Known managed hosts
 * remain eligible for cleanup through their authenticated runtime bridge.
 */
export interface OpenCodeManagedHostSweepPort {
  isEnabled(): boolean;
  sweepManagedHosts(input: {
    startedBeforeMs: number;
    /**
     * `force` reaps a confirmed-managed host outright; `orphaned` additionally
     * spares one whose parent is still alive. Defaults to `force`.
     */
    mode?: OpenCodeManagedHostCleanupMode;
  }): Promise<OpenCodeManagedHostCleanupResult>;
}

export const DEFAULT_OPEN_CODE_MANAGED_HOST_SWEEP_PORT: OpenCodeManagedHostSweepPort = {
  isEnabled: () => false,
  sweepManagedHosts: (input) =>
    cleanupManagedOpenCodeServeProcesses({
      mode: input.mode ?? 'force',
      startedBeforeMs: input.startedBeforeMs,
    }),
};

export async function cleanupManagedOpenCodeServeProcesses(
  _options: OpenCodeManagedHostProcessCleanupOptions
): Promise<OpenCodeManagedHostCleanupResult> {
  // Known managed hosts are handled by the runtime bridge using retained native
  // custody. Names, installation paths, environment markers and HTTP config do
  // not authorize requests or signals to an otherwise unattributed process.
  return {
    scanned: 0,
    killed: 0,
    candidates: [],
    diagnostics: [
      'Managed host process sweep preserved candidates: retained native custody is required.',
    ],
  };
}

export function isOpenCodeServeCommand(command: string): boolean {
  return OPENCODE_SERVE_COMMAND_RE.test(command.trim());
}

export function isOrchestratorServeCommand(command: string): boolean {
  return ORCHESTRATOR_SERVE_COMMAND_RE.test(command.trim());
}

export function isManagedOpenCodeServeHostConfig(config: string): boolean {
  return MANAGED_SERVE_HOST_CONFIG_PATTERNS.some((pattern) => pattern.test(config));
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

/**
 * A process's command line WITH its environment. This is observational
 * diagnostic data; it cannot authorize HTTP or a destructive action. Exported
 * for other observational callers; a second `ps eww` spelling
 * would be a second thing to keep correct.
 *
 * POSIX-only helper. Its output never grants cleanup authority.
 */
export async function readNativeProcessCommandWithEnv(pid: number): Promise<string | null> {
  return execFileText('ps', ['eww', '-p', String(pid), '-o', 'command='], 2_000, 2 * 1024 * 1024);
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
