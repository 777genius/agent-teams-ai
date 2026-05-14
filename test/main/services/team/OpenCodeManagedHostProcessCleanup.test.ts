import { describe, expect, it, vi } from 'vitest';

import {
  cleanupManagedOpenCodeServeProcesses,
  getOpenCodeServeLoopbackBaseUrl,
  isManagedOpenCodeServeProcessDetails,
  isOpenCodeServeCommand,
} from '@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup';

const MANAGED_DETAILS = [
  '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 54171',
  'CLAUDE_MULTIMODEL_DATA_HOME=/tmp/agent-teams-runtime',
  'OPENCODE_CONFIG_CONTENT={}',
  'AGENT_TEAMS_MCP_CLAUDE_DIR=/tmp/claude',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY=/tmp/mcp-entry.js',
].join(' ');
const MANAGED_DETAILS_WITH_WORKSPACE_MCP = [
  '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 54171',
  'CLAUDE_MULTIMODEL_DATA_HOME=/tmp/agent-teams-runtime',
  'OPENCODE_CONFIG_CONTENT={}',
  'AGENT_TEAMS_MCP_CLAUDE_DIR=/tmp/claude',
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

  it('requires Agent Teams managed environment markers', () => {
    expect(isManagedOpenCodeServeProcessDetails(MANAGED_DETAILS)).toBe(true);
    expect(isManagedOpenCodeServeProcessDetails(MANAGED_DETAILS_WITH_WORKSPACE_MCP)).toBe(true);
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

  it('skips fallback cleanup on Windows because environment markers are unavailable', async () => {
    const killProcess = vi.fn();

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      listProcessRows: () =>
        resolved([
          {
            pid: 500,
            ppid: 1,
            command: 'opencode.exe serve --hostname 127.0.0.1',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      killProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(result.scanned).toBe(0);
    expect(result.diagnostics[0]).toContain('skipped on Windows');
  });
});
