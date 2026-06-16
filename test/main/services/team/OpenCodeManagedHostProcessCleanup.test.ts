import {
  cleanupManagedOpenCodeServeProcesses,
  getOpenCodeServeLoopbackBaseUrl,
  isAppManagedWindowsOpenCodeServeCommand,
  isManagedOpenCodeServeProcessDetails,
  isOpenCodeServeCommand,
} from '@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup';
import { describe, expect, it, vi } from 'vitest';

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
    expect(isManagedOpenCodeServeProcessDetails(MANAGED_DETAILS_WITH_INLINE_OPENCODE_CONFIG_MCP)).toBe(
      true
    );
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
      killProcess,
    });

    expect(disposeServeHost).toHaveBeenCalledWith('http://127.0.0.1:3000');
    expect(killProcess).toHaveBeenCalledWith(210);
    expect(result.diagnostics).toEqual([]);
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
    const forceKillProcess = vi.fn();
    const isProcessAlive = vi.fn(() => true);
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
