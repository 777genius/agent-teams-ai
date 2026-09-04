import { addLogSink, type LogSinkEntry } from '@shared/utils/logger';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeReadinessBridge } from './OpenCodeReadinessBridge';

import type { OpenCodeReadinessBridgeCommandExecutor } from './OpenCodeReadinessBridge';

describe('production Cursor MCP launch hook (mock executor only)', () => {
  let root: string;
  let home: string;
  let configPath: string;
  let removeSink: () => void;
  let logs: LogSinkEntry[];
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-launch-config-'));
    home = path.join(root, 'home');
    configPath = path.join(home, '.cursor', 'mcp.json');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CLAUDE_MULTIMODEL_DATA_HOME', path.join(root, 'data'));
    expect(os.homedir()).toBe(home);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logs = [];
    removeSink = addLogSink((entry) => {
      if (entry.namespace === 'CursorMcpConfigWriter') logs.push(entry);
    });
  });
  afterEach(async () => {
    removeSink();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  const seed = async (contents: string) => {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, contents);
  };
  const launch = async (
    selectedModel = 'cursor-acp/auto',
    url: string | undefined = 'http://127.0.0.1:9999/mcp#first'
  ) => {
    const execute = vi.fn(async () => ({ ok: true, data: { runId: 'fixture' } }));
    const resolveUrl = vi.fn(async () => url);
    const bridge = new OpenCodeReadinessBridge(
      { execute } as unknown as OpenCodeReadinessBridgeCommandExecutor,
      { resolveAgentTeamsMcpUrl: resolveUrl }
    );
    const result = await bridge.launchOpenCodeTeam({
      teamName: 'fixture',
      laneId: 'fixture',
      runId: 'fixture',
      projectPath: root,
      selectedModel,
      members: [],
      expectedCapabilitySnapshotId: null,
      executionProof: { profileRootKey: 'test-profile' },
    } as unknown as Parameters<OpenCodeReadinessBridge['launchOpenCodeTeam']>[0]);
    expect(result).toEqual({ runId: 'fixture' });
    expect(execute).toHaveBeenCalledTimes(1);
    return { resolveUrl };
  };

  it('creates working config before dispatch and refreshes it after app restart without touching profile homes', async () => {
    const profile = path.join(root, 'data', 'opencode', 'profiles', 'other', 'home', '.cursor');
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, 'mcp.json'), 'user-profile-config');
    const execute = vi.fn(async () => {
      expect(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers['agent-teams']).toEqual({
        type: 'http',
        url: 'http://127.0.0.1:9999/mcp',
      });
      return { ok: true, data: { runId: 'fixture' } };
    });
    const bridge = new OpenCodeReadinessBridge(
      { execute } as unknown as OpenCodeReadinessBridgeCommandExecutor,
      { resolveAgentTeamsMcpUrl: async () => 'http://127.0.0.1:9999/mcp#first' }
    );
    await bridge.launchOpenCodeTeam({
      selectedModel: 'cursor-acp/auto',
      members: [],
      projectPath: root,
    } as unknown as Parameters<OpenCodeReadinessBridge['launchOpenCodeTeam']>[0]);
    expect(execute).toHaveBeenCalledOnce();
    await launch('cursor-acp/auto', 'http://127.0.0.1:9998/mcp#second');
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers['agent-teams'].url).toBe(
      'http://127.0.0.1:9998/mcp'
    );
    expect(await fs.readFile(path.join(profile, 'mcp.json'), 'utf8')).toBe('user-profile-config');
    expect(await fs.readdir(path.join(root, 'data', 'opencode', 'profiles'))).toEqual(['other']);
    expect(await fs.readdir(path.dirname(configPath))).not.toContain('cli-config.json');
  });

  it.each(['openrouter/test-model', 'grok-4.6-fast', 'kiro/auto'])(
    'never accesses Cursor configuration for %s',
    async (model) => {
      const original = '{"mcpServers":{"agent-teams":{"command":"mine","disabled":true}}}';
      await seed(original);
      const { resolveUrl } = await launch(model);
      expect(resolveUrl).not.toHaveBeenCalled();
      expect(await fs.readFile(configPath, 'utf8')).toBe(original);
      expect(await fs.readdir(path.dirname(configPath))).toEqual(['mcp.json']);
    }
  );

  it.each([
    { command: 'node', args: ['user.js'], env: { AUTH: 'private' }, disabled: true },
    {
      type: 'http',
      url: 'https://user.example/mcp',
      headers: { Authorization: 'private' },
      custom: 1,
    },
  ])('preserves conflicting user config and emits an observable conflict', async (entry) => {
    const original = JSON.stringify({
      custom: true,
      mcpServers: { 'agent-teams': entry, docs: { command: 'docs' } },
    });
    await seed(original);
    await launch();
    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
    expect(
      logs.some(
        (entry) => entry.level === 'error' && String(entry.args[0]).includes('user-owned-entry')
      )
    ).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('private');
  });

  it('leaves JSONC byte-for-byte unchanged and logs the skip', async () => {
    const original = '{ /* mine */ "mcpServers": {} }';
    await seed(original);
    await launch();
    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
    expect(logs.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('writes nothing when the endpoint is unavailable', async () => {
    await launch('cursor-acp/auto', '');
    expect(await fs.readdir(root)).toEqual([]);
  });
});
