import {
  cleanupManagedOpenCodeServeProcesses,
  getOpenCodeServeLoopbackBaseUrl,
  isAppManagedWindowsOpenCodeServeCommand,
  isManagedOpenCodeServeProcessDetails,
  isOpenCodeServeCommand,
} from '@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup';
import { listWindowsProcessTable } from '@main/utils/windowsProcessTable';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/utils/windowsProcessTable', () => ({
  listWindowsProcessTable: vi.fn(async () => []),
}));

const MANAGED_DETAILS = [
  '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 54171',
  'CLAUDE_MULTIMODEL_DATA_HOME=/tmp/agent-teams-runtime',
  'OPENCODE_CONFIG_CONTENT={}',
  'AGENT_TEAMS_MCP_CLAUDE_DIR=/tmp/claude',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY=/tmp/mcp-entry.js',
].join(' ');
const MANAGED_DETAILS_WITH_REMOTE_MCP = [
  '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 54171',
  'CLAUDE_MULTIMODEL_DATA_HOME=/tmp/agent-teams-runtime',
  'OPENCODE_CONFIG_CONTENT={}',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL=http://127.0.0.1:58461/mcp',
].join(' ');
const MANAGED_DETAILS_WITH_WORKSPACE_MCP = [
  '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 54171',
  'CLAUDE_MULTIMODEL_DATA_HOME=/tmp/agent-teams-runtime',
  'OPENCODE_CONFIG_CONTENT={}',
  'AGENT_TEAMS_MCP_CLAUDE_DIR=/tmp/claude',
].join(' ');
const MANAGED_DETAILS_WITH_INLINE_OPENCODE_CONFIG_MCP = [
  '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 54171',
  'CLAUDE_MULTIMODEL_DATA_HOME=/tmp/agent-teams-runtime',
  'OPENCODE_CONFIG_CONTENT={"mcp":{"agent-teams":{"type":"local","command":["node","mcp-server/dist/index.js"],"environment":{"AGENT_TEAMS_MCP_CLAUDE_DIR":"/tmp/claude"},"enabled":true}}}',
].join(' ');
const MANAGED_DETAILS_WITH_INLINE_OPENCODE_AGENT_PERMISSIONS = [
  '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 54171',
  'CLAUDE_MULTIMODEL_DATA_HOME=/tmp/agent-teams-runtime',
  'OPENCODE_CONFIG_CONTENT={"agent":{"teammate":{"description":"Managed teammate agent for claude-multimodel runtime orchestration.","permission":{"agent-teams_*":"allow","mcp__agent-teams__*":"allow"}}}}',
].join(' ');

function resolved<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

describe('OpenCodeManagedHostProcessCleanup', () => {
  it('bypasses the shared Windows process cache for default cleanup scans', async () => {
    await cleanupManagedOpenCodeServeProcesses({ mode: 'force', platform: 'win32' });

    expect(listWindowsProcessTable).toHaveBeenCalledWith(4_000, { bypassCache: true });
  });

  it('identifies OpenCode serve commands without matching other OpenCode commands', () => {
    expect(isOpenCodeServeCommand('/opt/homebrew/bin/opencode serve --hostname 127.0.0.1')).toBe(
      true
    );
    expect(isOpenCodeServeCommand('opencode runtime opencode-command --json')).toBe(false);
    expect(isOpenCodeServeCommand('node mcp-server/src/index.ts')).toBe(false);
  });

  it('identifies app-managed Windows OpenCode serve commands', () => {
    expect(
      isAppManagedWindowsOpenCodeServeCommand(
        '"C:\\Users\\User\\AppData\\Roaming\\claude-agent-teams-ui\\data\\runtimes\\opencode\\versions\\1.14.48\\opencode-windows-x64\\opencode.exe" serve --hostname 127.0.0.1 --port 49913'
      )
    ).toBe(true);
    expect(
      isAppManagedWindowsOpenCodeServeCommand(
        'C:\\tools\\opencode.exe serve --hostname 127.0.0.1 --port 49913'
      )
    ).toBe(false);
    expect(
      isAppManagedWindowsOpenCodeServeCommand(
        'C:\\Users\\User\\AppData\\Roaming\\claude-agent-teams-ui\\data\\runtimes\\opencode\\versions\\1.14.48\\opencode-windows-x64\\opencode.exe auth login'
      )
    ).toBe(false);
  });

  it('requires Agent Teams managed environment markers', () => {
    expect(isManagedOpenCodeServeProcessDetails(MANAGED_DETAILS)).toBe(true);
    expect(isManagedOpenCodeServeProcessDetails(MANAGED_DETAILS_WITH_REMOTE_MCP)).toBe(true);
    expect(isManagedOpenCodeServeProcessDetails(MANAGED_DETAILS_WITH_WORKSPACE_MCP)).toBe(true);
    expect(
      isManagedOpenCodeServeProcessDetails(MANAGED_DETAILS_WITH_INLINE_OPENCODE_CONFIG_MCP)
    ).toBe(true);
    expect(
      isManagedOpenCodeServeProcessDetails(MANAGED_DETAILS_WITH_INLINE_OPENCODE_AGENT_PERMISSIONS)
    ).toBe(true);
    expect(
      isManagedOpenCodeServeProcessDetails(
        'opencode serve CLAUDE_MULTIMODEL_DATA_HOME=/tmp OPENCODE_CONFIG_CONTENT={}'
      )
    ).toBe(false);
    expect(
      isManagedOpenCodeServeProcessDetails(
        'opencode serve OPENCODE_CONFIG_CONTENT={} AGENT_TEAMS_MCP_CLAUDE_DIR=/tmp/claude'
      )
    ).toBe(false);
    expect(
      isManagedOpenCodeServeProcessDetails(
        'opencode serve NOT_CLAUDE_MULTIMODEL_DATA_HOME=/tmp OPENCODE_CONFIG_CONTENT={} AGENT_TEAMS_MCP_CLAUDE_DIR=/tmp/claude'
      )
    ).toBe(false);
    expect(
      isManagedOpenCodeServeProcessDetails(
        'opencode serve OPENCODE_CONFIG_CONTENT={"mcp":{"agent-teams":{"enabled":true}}}'
      )
    ).toBe(false);
    expect(
      isManagedOpenCodeServeProcessDetails(
        'opencode serve OPENCODE_CONFIG_CONTENT={"agent":{"teammate":{"permission":{"agent-teams_*":"allow"}}}}'
      )
    ).toBe(false);
  });

  it('extracts only loopback OpenCode serve base URLs for disposal', () => {
    expect(
      getOpenCodeServeLoopbackBaseUrl(
        '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 54171'
      )
    ).toBe('http://127.0.0.1:54171');
    expect(getOpenCodeServeLoopbackBaseUrl('opencode serve --hostname=localhost --port=3000')).toBe(
      'http://localhost:3000'
    );
    expect(getOpenCodeServeLoopbackBaseUrl('opencode serve --hostname ::1 --port 3001')).toBe(
      ['http:', '//[::1]:3001'].join('')
    );
    expect(getOpenCodeServeLoopbackBaseUrl('opencode serve --hostname 0.0.0.0 --port 3000')).toBe(
      null
    );
    expect(
      getOpenCodeServeLoopbackBaseUrl('opencode serve --hostname 127.0.0.1 --port 70000')
    ).toBe(null);
  });

  it('kills old orphaned managed OpenCode serve processes that are missing from registry cleanup', async () => {
    const killProcess = vi.fn();
    const disposeServeHost = vi.fn(() => resolved(undefined));

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'orphaned',
      platform: 'darwin',
      startedBeforeMs: Date.parse('2026-05-13T17:00:00.000Z'),
      listProcessRows: () =>
        resolved([
          {
            pid: 51569,
            ppid: 1,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 54171',
          },
          {
            pid: 51570,
            ppid: 1,
            command: '/opt/homebrew/bin/opencode runtime opencode-command --json',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      readProcessStartTimeMs: () => resolved(Date.parse('2026-05-13T16:27:14.000Z')),
      disposeServeHost,
      isProcessAlive: () => false,
      killProcess,
    });

    expect(disposeServeHost).toHaveBeenCalledWith('http://127.0.0.1:54171');
    expect(killProcess).toHaveBeenCalledWith(51569);
    expect(result.killed).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.candidates[0]).toMatchObject({ pid: 51569, action: 'killed' });
  });

  it('keeps registry-known pids during startup fallback cleanup', async () => {
    const killProcess = vi.fn();
    const readProcessDetails = vi.fn(() => resolved(MANAGED_DETAILS));

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'orphaned',
      platform: 'darwin',
      excludePids: new Set([99469]),
      startedBeforeMs: Date.parse('2026-05-13T17:00:00.000Z'),
      listProcessRows: () =>
        resolved([
          {
            pid: 99469,
            ppid: 1,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 60130',
          },
        ]),
      readProcessDetails,
      readProcessStartTimeMs: () => resolved(Date.parse('2026-05-13T16:27:14.000Z')),
      killProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(readProcessDetails).not.toHaveBeenCalled();
    expect(result.candidates[0]).toMatchObject({ pid: 99469, action: 'kept_excluded' });
  });

  it('does not kill unmanaged OpenCode serve processes', async () => {
    const killProcess = vi.fn();

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'orphaned',
      platform: 'darwin',
      startedBeforeMs: Date.parse('2026-05-13T17:00:00.000Z'),
      listProcessRows: () =>
        resolved([
          {
            pid: 200,
            ppid: 1,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
        ]),
      readProcessDetails: () => resolved('opencode serve HOME=/Users/belief'),
      readProcessStartTimeMs: () => resolved(Date.parse('2026-05-13T16:27:14.000Z')),
      killProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(result.candidates[0]).toMatchObject({ pid: 200, action: 'kept_unmanaged' });
  });

  it('continues killing a managed orphan when loopback dispose fails', async () => {
    const killProcess = vi.fn();
    const disposeServeHost = vi.fn(() => Promise.reject(new Error('dispose failed')));

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'orphaned',
      platform: 'darwin',
      startedBeforeMs: Date.parse('2026-05-13T17:00:00.000Z'),
      listProcessRows: () =>
        resolved([
          {
            pid: 210,
            ppid: 1,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      readProcessStartTimeMs: () => resolved(Date.parse('2026-05-13T16:27:14.000Z')),
      disposeServeHost,
      isProcessAlive: () => false,
      killProcess,
    });

    expect(disposeServeHost).toHaveBeenCalledWith('http://127.0.0.1:3000');
    expect(killProcess).toHaveBeenCalledWith(210);
    expect(result.diagnostics).toEqual([]);
  });

  it('does not signal a pid reused after an orphan cleanup scan', async () => {
    const killProcess = vi.fn();
    const readProcessStartTimeMs = vi
      .fn<() => Promise<number | null>>()
      .mockResolvedValueOnce(Date.parse('2026-05-13T16:27:14.000Z'))
      .mockResolvedValueOnce(Date.parse('2026-05-13T16:59:59.000Z'));

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'orphaned',
      platform: 'darwin',
      startedBeforeMs: Date.parse('2026-05-13T17:00:00.000Z'),
      listProcessRows: () =>
        resolved([
          {
            pid: 211,
            ppid: 1,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      readProcessStartTimeMs,
      disposeServeHost: () => resolved(undefined),
      isProcessAlive: () => true,
      killProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(result.candidates[0]).toMatchObject({
      pid: 211,
      action: 'kept_unmanaged',
      reason: 'pid identity changed before graceful dispose',
    });
  });

  it('keeps orphaned managed processes that started after this app instance began', async () => {
    const killProcess = vi.fn();

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'orphaned',
      platform: 'darwin',
      startedBeforeMs: Date.parse('2026-05-13T17:00:00.000Z'),
      listProcessRows: () =>
        resolved([
          {
            pid: 300,
            ppid: 1,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      readProcessStartTimeMs: () => resolved(Date.parse('2026-05-13T17:00:01.000Z')),
      killProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(result.candidates[0]).toMatchObject({ pid: 300, action: 'kept_recent' });
  });

  it('force-cleans managed OpenCode serve processes regardless of parent pid', async () => {
    const killProcess = vi.fn();

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'darwin',
      listProcessRows: () =>
        resolved([
          {
            pid: 400,
            ppid: 123,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      disposeServeHost: () => resolved(undefined),
      isProcessAlive: () => false,
      killProcess,
    });

    expect(killProcess).toHaveBeenCalledWith(400);
    expect(result.candidates[0]).toMatchObject({ pid: 400, action: 'killed' });
  });

  it('escalates force cleanup when a managed OpenCode serve process survives SIGTERM', async () => {
    const killProcess = vi.fn();
    let processAlive = true;
    const forceKillProcess = vi.fn(() => {
      processAlive = false;
    });
    const isProcessAlive = vi.fn(() => processAlive);
    const sleepMs = vi.fn(() => resolved(undefined));

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'darwin',
      listProcessRows: () =>
        resolved([
          {
            pid: 401,
            ppid: 123,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      disposeServeHost: () => resolved(undefined),
      killProcess,
      forceKillProcess,
      isProcessAlive,
      sleepMs,
    });

    expect(killProcess).toHaveBeenCalledWith(401);
    expect(sleepMs).toHaveBeenCalledWith(250);
    expect(forceKillProcess).toHaveBeenCalledWith(401);
    expect(result.killed).toBe(1);
  });

  it('reports Windows access-denied cleanup as failed and does not claim the host was killed', async () => {
    const killProcess = vi.fn(() => Promise.reject(new Error('Access is denied')));

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      listProcessRows: () =>
        resolved([
          {
            pid: 71633,
            ppid: 86256,
            command:
              '"C:\\Users\\User\\AppData\\Roaming\\claude-agent-teams-ui\\data\\runtimes\\opencode\\versions\\1.18.2\\opencode-windows-x64\\opencode.exe" serve --hostname 127.0.0.1 --port 49918',
          },
        ]),
      readProcessStartTimeMs: () => resolved(Date.parse('2026-05-16T00:35:31.000Z')),
      disposeServeHost: () => resolved(undefined),
      isProcessAlive: () => true,
      killProcess,
    });

    expect(result.killed).toBe(0);
    expect(result.candidates[0]).toMatchObject({
      pid: 71633,
      action: 'failed',
      reason: 'Access is denied',
    });
    expect(result.diagnostics).toContain(
      'Failed to kill managed OpenCode serve pid=71633: Access is denied'
    );
  });

  it('does not report a reused pid as killed when identity changes before force kill', async () => {
    const startedAtMs = Date.parse('2026-05-13T16:27:14.000Z');
    const killProcess = vi.fn();
    const forceKillProcess = vi.fn();
    const readProcessStartTimeMs = vi
      .fn<() => Promise<number | null>>()
      .mockResolvedValueOnce(startedAtMs)
      .mockResolvedValueOnce(startedAtMs)
      .mockResolvedValueOnce(startedAtMs)
      .mockResolvedValueOnce(startedAtMs + 1_000);

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'darwin',
      startedBeforeMs: startedAtMs + 10_000,
      listProcessRows: () =>
        resolved([
          {
            pid: 402,
            ppid: 123,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      readProcessStartTimeMs,
      disposeServeHost: () => resolved(undefined),
      killProcess,
      forceKillProcess,
      isProcessAlive: () => true,
      sleepMs: () => resolved(undefined),
    });

    expect(killProcess).toHaveBeenCalledWith(402);
    expect(forceKillProcess).not.toHaveBeenCalled();
    expect(result.killed).toBe(0);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        pid: 402,
        action: 'kept_unmanaged',
        reason: 'pid identity changed before force kill',
      }),
    ]);
    expect(result.diagnostics).toContain(
      'Skipped force kill for managed OpenCode serve pid=402: pid identity changed'
    );
  });

  it('treats a raced force-kill ESRCH as success when the process is already gone', async () => {
    const killProcess = vi.fn();
    const forceKillProcess = vi.fn(() => {
      throw new Error('ESRCH');
    });
    const isProcessAlive = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'darwin',
      listProcessRows: () =>
        resolved([
          {
            pid: 402,
            ppid: 123,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      disposeServeHost: () => resolved(undefined),
      killProcess,
      forceKillProcess,
      isProcessAlive,
      sleepMs: () => resolved(undefined),
    });

    expect(result.killed).toBe(1);
    expect(result.diagnostics).toEqual([]);
  });

  it('treats a raced initial-kill ESRCH as success when the process is already gone', async () => {
    const killProcess = vi.fn(() => {
      throw new Error('ESRCH');
    });
    const isProcessAlive = vi.fn(() => false);

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'darwin',
      listProcessRows: () =>
        resolved([
          {
            pid: 403,
            ppid: 123,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      disposeServeHost: () => resolved(undefined),
      killProcess,
      isProcessAlive,
    });

    expect(result.killed).toBe(1);
    expect(result.candidates[0]).toMatchObject({ pid: 403, action: 'killed' });
    expect(result.diagnostics).toEqual([]);
  });

  it('requires additional process detail markers when provided', async () => {
    const killProcess = vi.fn();

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'darwin',
      requiredDetailsMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID=app-1'],
      listProcessRows: () =>
        resolved([
          {
            pid: 410,
            ppid: 123,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
          {
            pid: 411,
            ppid: 123,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3001',
          },
          {
            pid: 412,
            ppid: 123,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3002',
          },
        ]),
      readProcessDetails: (pid) => {
        if (pid === 410) {
          return resolved(`${MANAGED_DETAILS} CLAUDE_TEAM_APP_INSTANCE_ID=app-1`);
        }
        if (pid === 412) {
          return resolved(`${MANAGED_DETAILS} CLAUDE_TEAM_APP_INSTANCE_ID=app-10`);
        }
        return resolved(MANAGED_DETAILS);
      },
      readProcessStartTimeMs: () => resolved(Date.parse('2026-05-13T16:27:14.000Z')),
      disposeServeHost: () => resolved(undefined),
      isProcessAlive: () => false,
      killProcess,
    });

    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(410);
    expect(result.candidates.map((candidate) => [candidate.pid, candidate.action])).toEqual([
      [410, 'killed'],
      [411, 'kept_unmanaged'],
      [412, 'kept_unmanaged'],
    ]);
  });

  it('kills old orphaned app-managed Windows OpenCode serve processes', async () => {
    const killProcess = vi.fn();
    const disposeServeHost = vi.fn(() => resolved(undefined));

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'orphaned',
      platform: 'win32',
      startedBeforeMs: Date.parse('2026-05-16T00:47:55.000Z'),
      listProcessRows: () =>
        resolved([
          {
            pid: 71628,
            ppid: 86256,
            command:
              '"C:\\Users\\User\\AppData\\Roaming\\claude-agent-teams-ui\\data\\runtimes\\opencode\\versions\\1.14.48\\opencode-windows-x64\\opencode.exe" serve --hostname 127.0.0.1 --port 49913',
          },
        ]),
      readProcessStartTimeMs: () => resolved(Date.parse('2026-05-16T00:35:31.000Z')),
      disposeServeHost,
      isProcessAlive: () => false,
      killProcess,
    });

    expect(disposeServeHost).toHaveBeenCalledWith('http://127.0.0.1:49913');
    expect(killProcess).toHaveBeenCalledWith(71628);
    expect(result.killed).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.diagnostics).toEqual([]);
  });

  it('honors required markers when Windows details are unavailable', async () => {
    const killProcess = vi.fn();

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      requiredDetailsMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID=app-1'],
      listProcessRows: () =>
        resolved([
          {
            pid: 71629,
            ppid: 86256,
            command:
              '"C:\\Users\\User\\AppData\\Roaming\\claude-agent-teams-ui\\data\\runtimes\\opencode\\versions\\1.14.48\\opencode-windows-x64\\opencode.exe" serve --hostname 127.0.0.1 --port 49914',
          },
        ]),
      readProcessDetails: () => resolved(null),
      disposeServeHost: () => resolved(undefined),
      isProcessAlive: () => false,
      killProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(result.candidates[0]).toMatchObject({ pid: 71629, action: 'kept_unmanaged' });
    expect(result.diagnostics).toEqual([]);
  });

  it('uses resolved serve config to confirm Windows app-instance ownership', async () => {
    let processAlive = true;
    const killProcess = vi.fn(() => {
      processAlive = false;
    });
    const isProcessAlive = vi.fn(() => processAlive);
    const readServeHostConfig = vi.fn((baseUrl: string) =>
      resolved(
        baseUrl.endsWith(':49915')
          ? '{"mcp":{"agent-teams":{"url":"http://127.0.0.1:41001/mcp#agent-teams-app-instance=123-456"}}}'
          : '{"legacyOwner":"123-456","mcp":{"agent-teams":{"url":"http://127.0.0.1:41001/mcp#agent-teams-app-instance=999-000"}}}'
      )
    );

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      requiredServeConfigMarkersAny: ['agent-teams-app-instance=123-456'],
      listProcessRows: () =>
        resolved([
          {
            pid: 71630,
            ppid: 86256,
            command:
              '"C:\\Users\\User\\AppData\\Roaming\\claude-agent-teams-ui\\data\\runtimes\\opencode\\versions\\1.14.48\\opencode-windows-x64\\opencode.exe" serve --hostname 127.0.0.1 --port 49915',
          },
          {
            pid: 71631,
            ppid: 86256,
            command:
              '"C:\\Users\\User\\AppData\\Roaming\\claude-agent-teams-ui\\data\\runtimes\\opencode\\versions\\1.14.48\\opencode-windows-x64\\opencode.exe" serve --hostname 127.0.0.1 --port 49916',
          },
        ]),
      readProcessStartTimeMs: () => resolved(Date.parse('2026-05-16T00:35:31.000Z')),
      readServeHostConfig,
      disposeServeHost: () => resolved(undefined),
      isProcessAlive,
      killProcess,
    });

    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(71630);
    expect(result.candidates.map((candidate) => [candidate.pid, candidate.action])).toEqual([
      [71630, 'killed'],
      [71631, 'kept_unmanaged'],
    ]);
  });

  it('does not dispose or signal a reused Windows pid', async () => {
    const killProcess = vi.fn();
    const disposeServeHost = vi.fn(() => resolved(undefined));
    const readProcessStartTimeMs = vi
      .fn<() => Promise<number | null>>()
      .mockResolvedValueOnce(Date.parse('2026-05-16T00:35:31.000Z'))
      .mockResolvedValueOnce(Date.parse('2026-05-16T00:35:32.000Z'));

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      requiredServeConfigMarkersAny: ['agent-teams-app-instance=123-456'],
      listProcessRows: () =>
        resolved([
          {
            pid: 71632,
            ppid: 86256,
            command:
              '"C:\\Users\\User\\AppData\\Roaming\\claude-agent-teams-ui\\data\\runtimes\\opencode\\versions\\1.14.48\\opencode-windows-x64\\opencode.exe" serve --hostname 127.0.0.1 --port 49917',
          },
        ]),
      readProcessStartTimeMs,
      readServeHostConfig: () => resolved('{"owner":"agent-teams-app-instance=123-456"}'),
      disposeServeHost,
      isProcessAlive: () => true,
      killProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(disposeServeHost).not.toHaveBeenCalled();
    expect(result.candidates[0]).toMatchObject({
      pid: 71632,
      action: 'kept_unmanaged',
      reason: 'pid identity changed before graceful dispose',
    });
  });

  it('does not signal a Windows pid when its process start time is unavailable', async () => {
    const killProcess = vi.fn();
    const disposeServeHost = vi.fn(() => resolved(undefined));

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      requiredServeConfigMarkersAny: ['agent-teams-app-instance=123-456'],
      listProcessRows: () =>
        resolved([
          {
            pid: 71635,
            ppid: 86256,
            command:
              '"C:\\Users\\User\\AppData\\Roaming\\claude-agent-teams-ui\\data\\runtimes\\opencode\\versions\\1.18.2\\opencode-windows-x64\\opencode.exe" serve --hostname 127.0.0.1 --port 49919',
          },
        ]),
      readProcessStartTimeMs: () => resolved(null),
      readServeHostConfig: () => resolved('{"owner":"agent-teams-app-instance=123-456"}'),
      disposeServeHost,
      isProcessAlive: () => true,
      killProcess,
    });

    expect(disposeServeHost).not.toHaveBeenCalled();
    expect(killProcess).not.toHaveBeenCalled();
    expect(result.killed).toBe(0);
    expect(result.candidates[0]).toMatchObject({
      pid: 71635,
      action: 'failed',
      reason: 'Windows process start time could not be verified',
    });
    expect(result.diagnostics).toContain(
      'Skipped managed OpenCode serve pid=71635: windows process start time could not be verified'
    );
  });

  it('keeps app-managed Windows OpenCode serve processes while their parent is still alive', async () => {
    const killProcess = vi.fn();

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'orphaned',
      platform: 'win32',
      startedBeforeMs: Date.parse('2026-05-16T00:47:55.000Z'),
      listProcessRows: () =>
        resolved([
          {
            pid: 71628,
            ppid: 86256,
            command:
              '"C:\\Users\\User\\AppData\\Roaming\\claude-agent-teams-ui\\data\\runtimes\\opencode\\versions\\1.14.48\\opencode-windows-x64\\opencode.exe" serve --hostname 127.0.0.1 --port 49913',
          },
        ]),
      readProcessStartTimeMs: () => resolved(Date.parse('2026-05-16T00:35:31.000Z')),
      isProcessAlive: (pid) => pid === 86256,
      killProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(result.candidates[0]).toMatchObject({ pid: 71628, action: 'kept_recent' });
  });

  it('does not kill unmanaged Windows OpenCode serve commands', async () => {
    const killProcess = vi.fn();

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      listProcessRows: () =>
        resolved([
          {
            pid: 500,
            ppid: 1,
            command: 'C:\\tools\\opencode.exe serve --hostname 127.0.0.1',
          },
        ]),
      killProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(result.scanned).toBe(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.candidates[0]).toMatchObject({ pid: 500, action: 'kept_unmanaged' });
  });
});
