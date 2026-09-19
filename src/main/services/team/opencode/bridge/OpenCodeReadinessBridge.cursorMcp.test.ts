import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareCursorAcpLaunchMcpConfig } from '../config/CursorMcpConfigWriter';

import { OpenCodeReadinessBridge } from './OpenCodeReadinessBridge';

import type { OpenCodeReadinessBridgeCommandExecutor } from './OpenCodeReadinessBridge';

// Never invoke the real writer or redirect HOME. These fixtures represent the
// create/update cases without permitting access to native user configuration.
vi.mock('../config/CursorMcpConfigWriter', () => ({
  prepareCursorAcpLaunchMcpConfig: vi.fn(() => {
    throw new Error('Global Cursor registration must not run');
  }),
}));

describe('desktop Cursor launch dispatch without global registration', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-launch-config-'));
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps desktop HTTP MCP refresh on the command client without global registration wiring', async () => {
    const source = await fs.readFile(path.resolve(process.cwd(), 'src/main/index.ts'), 'utf8');
    expect(source).toContain('envProvider: resolveBridgeCommandEnv');
    expect(source).toContain('nextEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = appScopedMcpUrl');
    expect(source).not.toContain('resolveAgentTeamsMcpUrl');
  });

  it.each(['create', 'update', 'user-owned'])(
    'does not call the writer for %s, including retry and bridge restart',
    async (scenario) => {
      const configDir = path.join(root, '.cursor');
      await fs.mkdir(configDir);
      if (scenario !== 'create') {
        await fs.writeFile(
          path.join(configDir, 'mcp.json'),
          JSON.stringify({
            mcpServers: {
              'agent-teams':
                scenario === 'update'
                  ? { type: 'http', url: 'http://127.0.0.1:9998/mcp' }
                  : { command: 'user-owned' },
              unrelated: { command: 'untouched' },
            },
          })
        );
        await fs.writeFile(
          path.join(configDir, 'mcp.agent-teams-managed.json'),
          'fixture ownership'
        );
      }
      const snapshot = async () =>
        Promise.all(
          (await fs.readdir(configDir))
            .sort()
            .map(async (name) => [name, await fs.readFile(path.join(configDir, name), 'utf8')])
        );
      const original = await snapshot();
      const execute = vi
        .fn()
        .mockRejectedValueOnce(new Error('fixture dispatch failure'))
        .mockResolvedValue({ ok: true, data: { runId: 'fixture' } });
      const makeBridge = () =>
        new OpenCodeReadinessBridge(
          {
            execute: vi.fn(() => {
              throw new Error('Must use desktop command service');
            }),
          } as unknown as OpenCodeReadinessBridgeCommandExecutor,
          { stateChangingCommands: { execute } }
        );
      const input: Parameters<OpenCodeReadinessBridge['launchOpenCodeTeam']>[0] = {
        selectedModel: 'cursor-acp/auto',
        members: [],
        projectPath: root,
        runId: 'fixture',
        teamName: 'fixture',
        laneId: 'primary',
        expectedCapabilitySnapshotId: null,
        teamId: 'fixture',
        leadPrompt: 'fixture',
        manifestHighWatermark: null,
        expectedBehaviorFingerprint: 'fixture',
      };
      const bridge = makeBridge();
      await expect(bridge.launchOpenCodeTeam(input)).resolves.toMatchObject({
        runId: 'fixture',
        teamLaunchState: 'failed',
      });
      await expect(bridge.launchOpenCodeTeam(input)).resolves.toEqual({ runId: 'fixture' });
      await expect(makeBridge().launchOpenCodeTeam(input)).resolves.toEqual({ runId: 'fixture' });
      expect(execute).toHaveBeenCalledTimes(3);
      expect(execute).toHaveBeenLastCalledWith(
        expect.objectContaining({
          command: 'opencode.launchTeam',
          body: input,
        })
      );
      expect(prepareCursorAcpLaunchMcpConfig).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(original);
    }
  );

  it.each(['openrouter/test-model', 'grok-4.6-fast', 'kiro/auto'])(
    'preserves dispatch for %s without Cursor registration',
    async (selectedModel) => {
      const execute = vi.fn(async () => ({ ok: true, data: { runId: 'fixture' } }));
      const bridge = new OpenCodeReadinessBridge({
        execute,
      } as unknown as OpenCodeReadinessBridgeCommandExecutor);
      await bridge.launchOpenCodeTeam({
        selectedModel,
        members: [],
        projectPath: root,
        runId: 'fixture',
        laneId: 'primary',
        teamId: 'fixture',
        teamName: 'fixture',
        leadPrompt: 'fixture',
        expectedCapabilitySnapshotId: null,
        manifestHighWatermark: null,
        expectedBehaviorFingerprint: 'fixture',
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(prepareCursorAcpLaunchMcpConfig).not.toHaveBeenCalled();
    }
  );
});
