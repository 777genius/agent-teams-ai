// @vitest-environment node
import {
  cleanupManagedOpenCodeServeProcesses,
  getOpenCodeServeLoopbackBaseUrl,
  isAppManagedWindowsOpenCodeServeCommand,
  isManagedOpenCodeServeHostConfig,
  isManagedOpenCodeServeProcessDetails,
  isOpenCodeServeCommand,
  isOrchestratorServeCommand,
} from '@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup';
import { listWindowsProcessTable } from '@main/utils/windowsProcessTable';
import * as childProcess from 'child_process';
import { describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

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
  it.each([10_000, 20_000, null])(
    'rechecks Windows birth after force taskkill before direct fallback (%s)',
    async (birthAfterTaskkill) => {
      let birth: number | null = 10_000;
      let alive = true;
      const nativeKill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
        if (signal === 0) {
          if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        } else {
          alive = false;
        }
        return true;
      });
      const exec = vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[3] as (error: Error | null) => void;
        // Complete the external tree attempt asynchronously, with possible PID reuse.
        void Promise.resolve().then(() => {
          birth = birthAfterTaskkill;
          callback(new Error('fixture taskkill failed'));
        });
        return {} as ReturnType<typeof childProcess.execFile>;
      });
      const killProcess = vi.fn();
      try {
        const result = await cleanupManagedOpenCodeServeProcesses({
          mode: 'force',
          platform: 'win32',
          listProcessRows: () => resolved([{ pid: 42, ppid: 1, command: 'opencode serve' }]),
          readProcessDetails: () => resolved(MANAGED_DETAILS),
          readProcessStartTimeMs: () => resolved(birth),
          killProcess,
          isProcessAlive: () => alive,
          sleepMs: () => resolved(undefined),
        });
        expect(killProcess).toHaveBeenCalledWith(42);
        expect(exec).toHaveBeenCalledTimes(1);
        expect(nativeKill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual(
          birthAfterTaskkill === 10_000 ? [[42, 'SIGKILL']] : []
        );
        expect(result.killed).toBe(birthAfterTaskkill === 10_000 ? 1 : 0);
        if (birthAfterTaskkill !== 10_000) {
          expect(result.candidates[0]).toMatchObject({
            action: 'failed',
            reason: expect.stringContaining('refusing unsafe direct termination'),
          });
        }
      } finally {
        nativeKill.mockRestore();
        exec.mockRestore();
      }
    }
  );

  describe.each(['details', 'config', 'profile'] as const)('%s ownership probe', (proof) => {
    it.each([1, 2, 3])('rejects PID reuse during confirmation phase %s', async (phase) => {
      let birth = 10_000;
      let probes = 0;
      const changeBirthDuringProbe = async () => {
        await Promise.resolve();
        // Admission is the first probe, followed by dispose, kill, and force checks.
        if (++probes === phase + 1) birth = 20_000;
      };
      const disposeServeHost = vi.fn(() => resolved(undefined));
      const killProcess = vi.fn();
      const forceKillProcess = vi.fn();
      const result = await cleanupManagedOpenCodeServeProcesses({
        mode: 'force',
        platform: 'win32',
        listProcessRows: () =>
          resolved([{ pid: 42, ppid: 1, command: 'opencode serve --port 5001' }]),
        requiredDetailsMarkers: proof === 'details' ? ['OPENCODE_CONFIG_CONTENT='] : [],
        requiredServeConfigMarkersAny: proof === 'config' ? ['fixture-marker'] : [],
        requiredProfileScope: proof === 'profile' ? 'own' : undefined,
        readProcessDetails: async () => {
          if (proof === 'details') await changeBirthDuringProbe();
          return MANAGED_DETAILS;
        },
        readServeHostConfig: async () => {
          await changeBirthDuringProbe();
          return JSON.stringify({
            marker: 'fixture-marker',
            mcp: { 'agent-teams': { environment: { CLAUDE_TEAM_APP_PROFILE_SCOPE: 'own' } } },
          });
        },
        readProcessStartTimeMs: () => resolved(birth),
        disposeServeHost,
        killProcess,
        forceKillProcess,
        isProcessAlive: () => true,
        sleepMs: () => resolved(undefined),
      });
      expect(disposeServeHost).toHaveBeenCalledTimes(phase > 1 ? 1 : 0);
      expect(killProcess).toHaveBeenCalledTimes(phase > 2 ? 1 : 0);
      expect(forceKillProcess).not.toHaveBeenCalled();
      expect(result.killed).toBe(0);
      expect(result.candidates[0]).toMatchObject({
        action: 'kept_unmanaged',
        reason: [
          'pid identity changed before graceful dispose',
          'pid identity changed before cleanup signal',
          'pid identity changed before force kill',
        ][phase - 1],
      });
    });
  });

  it('records default identity probe diagnostics and never kills an unreadable Windows identity', async () => {
    const exec = vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error, stdout: string, stderr: string) => void;
      callback(
        Object.assign(new Error('private command'), { code: 5, killed: true }),
        'private stdout',
        'denied API_KEY=mock-secret'
      );
      return {} as ReturnType<typeof childProcess.execFile>;
    });
    const killProcess = vi.fn();
    const disposeServeHost = vi.fn();
    try {
      const result = await cleanupManagedOpenCodeServeProcesses({
        mode: 'force',
        platform: 'win32',
        listProcessRows: async () => [{ pid: 42, ppid: 1, command: 'opencode serve' }],
        readProcessDetails: async () => MANAGED_DETAILS,
        killProcess,
        disposeServeHost,
        isProcessAlive: () => true,
      });
      expect(result.diagnostics.join(' ')).toContain(
        'pid=42; process_start_time:powershell.exe: probe failed'
      );
      expect(result.diagnostics.join(' ')).toContain(
        'timeoutMs=2000; code=5; killed=true; timedOut=unknown'
      );
      expect(result.diagnostics.join(' ')).not.toMatch(/private|mock-secret/);
      expect(result.killed).toBe(0);
      expect(killProcess).not.toHaveBeenCalled();
      expect(disposeServeHost).not.toHaveBeenCalled();
    } finally {
      exec.mockRestore();
    }
  });

  it.each(['darwin', 'linux', 'win32'] as const)(
    'startup cleans only old orphaned hosts in the same profile on %s',
    async (platform) => {
      const killProcess = vi.fn();
      const disposeServeHost = vi.fn(async () => undefined);
      const alive = new Set([801, 802, 803, 804]);
      const scopes = ['profile-own', 'profile-foreign', 'profile-own-extra', null];
      const result = await cleanupManagedOpenCodeServeProcesses({
        mode: 'orphaned',
        platform,
        requiredProfileScope: 'profile-own',
        startedBeforeMs: 20_000,
        listProcessRows: async () =>
          scopes.map((_, index) => ({
            pid: 801 + index,
            ppid: 1,
            command:
              platform === 'win32'
                ? `"C:\\test\\runtimes\\opencode\\versions\\1.0\\opencode-windows-x64\\opencode.exe" serve --port ${5001 + index}`
                : `/test/opencode serve --port ${5001 + index}`,
          })),
        readProcessDetails: async (pid) =>
          platform === 'win32'
            ? null
            : `${MANAGED_DETAILS} CLAUDE_TEAM_APP_INSTANCE_ID=previous-instance` +
              (scopes[pid - 801] ? ` CLAUDE_TEAM_APP_PROFILE_SCOPE=${scopes[pid - 801]}` : ''),
        readServeHostConfig: async (baseUrl) =>
          JSON.stringify({
            mcp: {
              'agent-teams': {
                url: `http://127.0.0.1:41001/mcp#agent-teams-app-instance=previous-instance&agent-teams-app-profile=${scopes[Number(new URL(baseUrl).port) - 5001]}`,
              },
            },
          }),
        readProcessStartTimeMs: async () => 10_000,
        disposeServeHost,
        isProcessAlive: (pid) => alive.has(pid),
        killProcess: (pid) => {
          killProcess(pid);
          alive.delete(pid);
        },
      });
      expect(killProcess.mock.calls).toEqual([[801]]);
      expect(disposeServeHost.mock.calls).toEqual([['http://127.0.0.1:5001']]);
      expect([...alive]).toEqual([802, 803, 804]);
      expect(result.candidates.map(({ action }) => action)).toEqual([
        'killed',
        'kept_unmanaged',
        'kept_unmanaged',
        'kept_unmanaged',
      ]);
    }
  );

  it.each([
    [
      'local',
      { mcp: { 'agent-teams': { environment: { CLAUDE_TEAM_APP_PROFILE_SCOPE: 'own' } } } },
      true,
    ],
    [
      'unrelated config',
      { note: 'own', mcp: { other: { environment: { CLAUDE_TEAM_APP_PROFILE_SCOPE: 'own' } } } },
      false,
    ],
    [
      'foreign local',
      { mcp: { 'agent-teams': { environment: { CLAUDE_TEAM_APP_PROFILE_SCOPE: 'own-extra' } } } },
      false,
    ],
    [
      'legacy HTTP',
      { mcp: { 'agent-teams': { url: 'http://127.0.0.1:4000/mcp#agent-teams-app-instance=old' } } },
      false,
    ],
  ])('requires exact Windows profile ownership in %s config', async (_, config, expectedKill) => {
    const killProcess = vi.fn();
    let alive = true;
    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'orphaned',
      platform: 'win32',
      requiredProfileScope: 'own',
      startedBeforeMs: 20_000,
      listProcessRows: async () => [
        {
          pid: 900,
          ppid: 1,
          command:
            '"C:\\test\\runtimes\\opencode\\versions\\1.0\\opencode-windows-x64\\opencode.exe" serve --port 5000',
        },
      ],
      readProcessStartTimeMs: async () => 10_000,
      readServeHostConfig: async () => JSON.stringify(config),
      disposeServeHost: async () => undefined,
      isProcessAlive: (pid) => pid === 900 && alive,
      killProcess: (pid) => {
        killProcess(pid);
        alive = false;
      },
    });
    expect(killProcess).toHaveBeenCalledTimes(expectedKill ? 1 : 0);
    expect(result.killed).toBe(expectedKill ? 1 : 0);
  });

  it.each([true, false])(
    'handles Windows config disappearing before dispose=%s',
    async (beforeDispose) => {
      let alive = true;
      const config = JSON.stringify({
        mcp: { 'agent-teams': { environment: { CLAUDE_TEAM_APP_PROFILE_SCOPE: 'own' } } },
      });
      const readServeHostConfig = vi
        .fn<() => Promise<string | null>>()
        .mockResolvedValueOnce(config);
      if (!beforeDispose) readServeHostConfig.mockResolvedValueOnce(config);
      readServeHostConfig.mockResolvedValue(null);
      const disposeServeHost = vi.fn(async () => undefined);
      const killProcess = vi.fn(() => {
        alive = false;
      });
      const result = await cleanupManagedOpenCodeServeProcesses({
        mode: 'orphaned',
        platform: 'win32',
        requiredProfileScope: 'own',
        startedBeforeMs: 20_000,
        listProcessRows: async () => [
          {
            pid: 900,
            ppid: 1,
            command:
              '"C:\\test\\runtimes\\opencode\\versions\\1.0\\opencode-windows-x64\\opencode.exe" serve --port 5000',
          },
        ],
        readProcessStartTimeMs: async () => 10_000,
        readServeHostConfig,
        disposeServeHost,
        isProcessAlive: (pid) => pid === 900 && alive,
        killProcess,
      });
      expect(disposeServeHost).toHaveBeenCalledTimes(beforeDispose ? 0 : 1);
      expect(killProcess).toHaveBeenCalledTimes(beforeDispose ? 0 : 1);
      expect(result.killed).toBe(beforeDispose ? 0 : 1);
    }
  );

  it('rechecks profile ownership before disposing a host', async () => {
    const disposeServeHost = vi.fn(async () => undefined);
    const killProcess = vi.fn();
    const readProcessDetails = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(`${MANAGED_DETAILS} CLAUDE_TEAM_APP_PROFILE_SCOPE=own`)
      .mockResolvedValue(`${MANAGED_DETAILS} CLAUDE_TEAM_APP_PROFILE_SCOPE=foreign`);
    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'orphaned',
      platform: 'darwin',
      requiredProfileScope: 'own',
      startedBeforeMs: 20_000,
      listProcessRows: async () => [
        { pid: 900, ppid: 1, command: '/test/opencode serve --port 5000' },
      ],
      readProcessStartTimeMs: async () => 10_000,
      readProcessDetails,
      disposeServeHost,
      isProcessAlive: () => true,
      killProcess,
    });
    expect(disposeServeHost).not.toHaveBeenCalled();
    expect(killProcess).not.toHaveBeenCalled();
    expect(result.candidates[0].action).toBe('kept_unmanaged');
  });

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

  it('recognises the orchestrator serve host, which only this app runs', () => {
    expect(isOrchestratorServeCommand('/opt/app/bin/claude-multimodel serve --port 4096')).toBe(
      true
    );
    expect(isOrchestratorServeCommand('C:\\app\\claude-multimodel.exe serve --port 4096')).toBe(
      true
    );
    // Neither a different subcommand nor the standalone CLI a user runs.
    expect(isOrchestratorServeCommand('/opt/app/bin/claude-multimodel status')).toBe(false);
    expect(isOrchestratorServeCommand('/usr/local/bin/opencode serve --port 4096')).toBe(false);
  });

  it('recognises a managed host by its effective config when the environment is unreadable', () => {
    expect(
      isManagedOpenCodeServeHostConfig('{"mcp":{"url":"?agent-teams-app-instance=abc"}}')
    ).toBe(true);
    expect(
      isManagedOpenCodeServeHostConfig('{"environment":{"AGENT_TEAMS_MCP_CLAUDE_DIR":"/tmp"}}')
    ).toBe(true);
    expect(
      isManagedOpenCodeServeHostConfig('{"description":"claude-multimodel runtime orchestration"}')
    ).toBe(true);
    // A config a user's own `opencode serve` would publish.
    expect(isManagedOpenCodeServeHostConfig('{"model":"gpt-5","mcp":{"github":{}}}')).toBe(false);
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

  it('keeps a managed process that started after the force sweep was requested', async () => {
    const killProcess = vi.fn();
    const requestedAtMs = Date.parse('2026-05-13T17:00:00.000Z');

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'darwin',
      startedBeforeMs: requestedAtMs,
      listProcessRows: () =>
        resolved([
          {
            pid: 401,
            ppid: 123,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      readProcessStartTimeMs: () => resolved(requestedAtMs + 1_000),
      disposeServeHost: () => resolved(undefined),
      isProcessAlive: () => true,
      killProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(result.killed).toBe(0);
    expect(result.candidates[0]).toMatchObject({ pid: 401, action: 'kept_recent' });
  });

  it('kills a managed process that started before the force sweep was requested', async () => {
    const killProcess = vi.fn();
    const requestedAtMs = Date.parse('2026-05-13T17:00:00.000Z');

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'darwin',
      startedBeforeMs: requestedAtMs,
      listProcessRows: () =>
        resolved([
          {
            pid: 401,
            ppid: 123,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      readProcessStartTimeMs: () => resolved(requestedAtMs - 1_000),
      disposeServeHost: () => resolved(undefined),
      isProcessAlive: () => false,
      killProcess,
    });

    expect(killProcess).toHaveBeenCalledWith(401);
    expect(result.candidates[0]).toMatchObject({ pid: 401, action: 'killed' });
  });

  // Fail-safe direction: an unobservable start time means "cannot prove this is
  // mine", and the sweep reaches processes it never recorded a pid for. Reading
  // it the other way would reap somebody else's host on every sweep.
  it('keeps a fenced managed process whose start time cannot be read at all', async () => {
    const killProcess = vi.fn();
    const forceKillProcess = vi.fn();
    const requestedAtMs = Date.parse('2026-05-13T17:00:00.000Z');

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'darwin',
      startedBeforeMs: requestedAtMs,
      listProcessRows: () =>
        resolved([
          {
            pid: 402,
            ppid: 123,
            command: '/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 3000',
          },
        ]),
      readProcessDetails: () => resolved(MANAGED_DETAILS),
      // What `readProcessStartTimeMs` answers when the probe cannot run.
      readProcessStartTimeMs: () => resolved(null),
      disposeServeHost: () => resolved(undefined),
      isProcessAlive: () => true,
      killProcess,
      forceKillProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(forceKillProcess).not.toHaveBeenCalled();
    expect(result.killed).toBe(0);
    expect(result.candidates[0]).toMatchObject({ pid: 402, action: 'kept_recent' });
  });

  it('never kills a standalone opencode serve without the managed markers, even in force mode', async () => {
    const killProcess = vi.fn();
    const forceKillProcess = vi.fn();

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'darwin',
      listProcessRows: () =>
        resolved([
          {
            pid: 909,
            ppid: 1,
            command: '/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 4096',
          },
        ]),
      readProcessDetails: () =>
        resolved('/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 4096 HOME=/home/user'),
      disposeServeHost: () => resolved(undefined),
      isProcessAlive: () => true,
      killProcess,
      forceKillProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(forceKillProcess).not.toHaveBeenCalled();
    expect(result.killed).toBe(0);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        pid: 909,
        action: 'kept_unmanaged',
        reason: 'process does not carry Agent Teams managed OpenCode environment markers',
      }),
    ]);
  });

  it.each(['orphaned' as const, 'force' as const])(
    'spares a standalone opencode serve in %s mode even when the fence would allow a kill',
    async (mode) => {
      const killProcess = vi.fn();
      const forceKillProcess = vi.fn();
      const appStartedAtMs = Date.parse('2026-05-13T17:00:00.000Z');

      const result = await cleanupManagedOpenCodeServeProcesses({
        mode,
        platform: 'darwin',
        startedBeforeMs: appStartedAtMs,
        listProcessRows: () =>
          resolved([
            {
              pid: 910,
              ppid: 1,
              command: '/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 4096',
            },
          ]),
        readProcessDetails: () =>
          resolved(
            '/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 4096 HOME=/home/user'
          ),
        readProcessStartTimeMs: () => resolved(appStartedAtMs - 60_000),
        disposeServeHost: () => resolved(undefined),
        isProcessAlive: () => true,
        killProcess,
        forceKillProcess,
      });

      expect(killProcess).not.toHaveBeenCalled();
      expect(forceKillProcess).not.toHaveBeenCalled();
      expect(result.killed).toBe(0);
      expect(result.candidates[0]).toMatchObject({ pid: 910, action: 'kept_unmanaged' });
    }
  );

  // Windows cannot read another process's environment, and a PATH-resolved
  // runtime carries no app-managed install path, so the config the host serves
  // over loopback is the last remaining ownership signal.
  it('claims a Windows host whose loopback config carries this app instance', async () => {
    const killProcess = vi.fn();
    const appStartedAtMs = Date.parse('2026-05-13T17:00:00.000Z');

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      startedBeforeMs: appStartedAtMs,
      listProcessRows: () =>
        resolved([
          {
            pid: 920,
            ppid: 1,
            command: 'C:\\tools\\opencode.exe serve --hostname 127.0.0.1 --port 4096',
          },
        ]),
      readProcessDetails: () => resolved(null),
      readServeHostConfig: () =>
        resolved('{"environment":{"AGENT_TEAMS_MCP_CLAUDE_DIR":"C:/Users/dev/.claude"}}'),
      readProcessStartTimeMs: () => resolved(appStartedAtMs - 60_000),
      disposeServeHost: () => resolved(undefined),
      isProcessAlive: () => false,
      killProcess,
    });

    expect(killProcess).toHaveBeenCalledWith(920);
    expect(result.candidates[0]).toMatchObject({ pid: 920, action: 'killed' });
  });

  it('leaves a Windows host alone when its loopback config belongs to somebody else', async () => {
    const killProcess = vi.fn();
    const forceKillProcess = vi.fn();
    const appStartedAtMs = Date.parse('2026-05-13T17:00:00.000Z');

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      startedBeforeMs: appStartedAtMs,
      listProcessRows: () =>
        resolved([
          {
            pid: 921,
            ppid: 1,
            command: 'C:\\tools\\opencode.exe serve --hostname 127.0.0.1 --port 4096',
          },
        ]),
      readProcessDetails: () => resolved(null),
      readServeHostConfig: () => resolved('{"model":"gpt-5","mcp":{"github":{}}}'),
      readProcessStartTimeMs: () => resolved(appStartedAtMs - 60_000),
      disposeServeHost: () => resolved(undefined),
      isProcessAlive: () => true,
      killProcess,
      forceKillProcess,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(forceKillProcess).not.toHaveBeenCalled();
    expect(result.candidates[0]).toMatchObject({ pid: 921, action: 'kept_unmanaged' });
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

/**
 * An orchestrator serve host is in scope for the sweep, but being an
 * orchestrator is not the same as being THIS app's orchestrator. Treating the
 * binary name as proof made every `claude-multimodel serve` on the machine
 * app-managed by definition, including one belonging to a second installation
 * or to a copy of the app running side by side.
 */
describe('whose orchestrator serve host is it', () => {
  const ORCHESTRATOR = 'C:\\Program Files\\Other App\\claude-multimodel.exe serve --port 4096';

  it('does not kill a Windows orchestrator host that will not identify itself', async () => {
    const killProcess = vi.fn();

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: ORCHESTRATOR }]),
      readProcessDetails: async () => null,
      // The host is reachable but its config carries none of this app's marks.
      readServeHostConfig: async () => '{"description":"somebody else runtime"}',
      killProcess,
      isProcessAlive: () => true,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(result.killed).toBe(0);
    expect(result.candidates[0]?.action).toBe('kept_unmanaged');
  });

  it('does not kill a Windows orchestrator host that does not answer at all', async () => {
    const killProcess = vi.fn();

    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: ORCHESTRATOR }]),
      readProcessDetails: async () => null,
      readServeHostConfig: async () => {
        throw new Error('connection refused');
      },
      killProcess,
      isProcessAlive: () => true,
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(result.killed).toBe(0);
  });

  /** It stays in scope: a host that DOES identify itself is still reaped. */
  it('reaps a Windows orchestrator host whose config identifies this app', async () => {
    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: ORCHESTRATOR }]),
      readProcessDetails: async () => null,
      readServeHostConfig: async () => '{"description":"claude-multimodel runtime orchestration"}',
      disposeServeHost: async () => undefined,
      killProcess: vi.fn(),
      // The host is gone by the time the signal would have been sent, so the
      // sweep counts it as reaped without needing to signal it.
      isProcessAlive: () => false,
    });

    expect(result.killed).toBe(1);
    expect(result.candidates[0]?.action).toBe('killed');
  });
});
