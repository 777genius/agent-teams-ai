// @vitest-environment node
import {
  cleanupManagedOpenCodeServeProcesses,
  DEFAULT_OPEN_CODE_MANAGED_HOST_SWEEP_PORT,
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
  return {
    ...actual,
    execFile: vi.fn(() => {
      throw new Error('TEST unexpected native query');
    }),
  };
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

describe('OpenCodeManagedHostProcessCleanup', () => {
  // Marker/name/profile observations cannot authorize even the first probe.
  // Termination under retained native custody is delegated to the runtime bridge.
  it.each(
    (['darwin', 'linux', 'win32'] as const).flatMap((platform) =>
      (['orphaned', 'force'] as const).map((mode) => ({ platform, mode }))
    )
  )(
    'preserves unattributed candidates before all I/O ($platform/$mode)',
    async ({ platform, mode }) => {
      const ports = {
        listProcessRows: vi.fn(async () => [
          { pid: 424242, ppid: 1, command: 'opencode serve --port 54321' },
        ]),
        readProcessDetails: vi.fn(async () => MANAGED_DETAILS),
        readProcessStartTimeMs: vi.fn(async () => 1),
        readServeHostConfig: vi.fn(
          async () =>
            '{"mcp":{"agent-teams":{"url":"http://127.0.0.1:54322/mcp#agent-teams-app-profile=TEST"}}}'
        ),
        disposeServeHost: vi.fn(async () => undefined),
        killProcess: vi.fn(),
        forceKillProcess: vi.fn(),
        isProcessAlive: vi.fn(() => true),
        sleepMs: vi.fn(async () => undefined),
      };
      const result = await cleanupManagedOpenCodeServeProcesses({
        mode,
        platform,
        ...ports,
        requiredDetailsMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID=TEST'],
        requiredProfileScope: 'TEST',
        requiredServeConfigMarkersAny: ['agent-teams-app-instance=TEST'],
        startedBeforeMs: 60000,
      });
      for (const port of Object.values(ports)) expect(port).not.toHaveBeenCalled();
      expect(result).toEqual({
        scanned: 0,
        killed: 0,
        candidates: [],
        diagnostics: [
          'Managed host process sweep preserved candidates: retained native custody is required.',
        ],
      });
    }
  );

  it('disables the generic default port and never falls back to native queries or HTTP', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('TEST unexpected HTTP'));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('TEST unexpected signal');
    });
    try {
      expect(DEFAULT_OPEN_CODE_MANAGED_HOST_SWEEP_PORT.isEnabled()).toBe(false);
      expect(
        await DEFAULT_OPEN_CODE_MANAGED_HOST_SWEEP_PORT.sweepManagedHosts({ startedBeforeMs: 1 })
      ).toMatchObject({ scanned: 0, killed: 0, candidates: [] });
      await cleanupManagedOpenCodeServeProcesses({ mode: 'force', platform: 'win32' });
      expect(childProcess.execFile).not.toHaveBeenCalled();
      expect(listWindowsProcessTable).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      kill.mockRestore();
    }
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

  it('recognises orchestrator serve syntax without granting cleanup custody', () => {
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
});
