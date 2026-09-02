import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CURSOR_AGENT_TEAMS_MCP_SERVER_NAME,
  ensureCursorAgentTeamsMcpConfig,
  prepareCursorAcpLaunchMcpConfig,
  resolveCursorAcpProfileHome,
  stripUrlFragment,
} from './CursorMcpConfigWriter';

const MCP_URL = 'http://127.0.0.1:9999/mcp';

describe('CursorMcpConfigWriter', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-mcp-writer-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const configPathIn = (profileHome: string): string =>
    path.join(profileHome, '.cursor', 'mcp.json');

  const writeConfig = async (profileHome: string, contents: string): Promise<string> => {
    const configPath = configPathIn(profileHome);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, contents, 'utf8');
    return configPath;
  };

  describe('ensureCursorAgentTeamsMcpConfig', () => {
    it('creates the entry when the profile home has no Cursor config yet', async () => {
      const result = await ensureCursorAgentTeamsMcpConfig({
        profileHome: workspace,
        mcpUrl: MCP_URL,
      });

      expect(result.action).toBe('created');
      const written = JSON.parse(await fs.readFile(configPathIn(workspace), 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(written.mcpServers[CURSOR_AGENT_TEAMS_MCP_SERVER_NAME]).toEqual({
        type: 'http',
        url: MCP_URL,
      });
    });

    it('leaves an unparsable config byte-for-byte alone instead of replacing it', async () => {
      const contents = '{\n  // a comment Cursor tolerates\n  "mcpServers": { "docs": {} },\n}\n';
      const configPath = await writeConfig(workspace, contents);

      const result = await ensureCursorAgentTeamsMcpConfig({
        profileHome: workspace,
        mcpUrl: MCP_URL,
      });

      expect(result).toEqual({
        path: configPath,
        action: 'skipped',
        reason: 'unparsable-config',
      });
      expect(await fs.readFile(configPath, 'utf8')).toBe(contents);
    });

    it('leaves a config whose root is not an object alone', async () => {
      const contents = '["not", "an", "object"]\n';
      const configPath = await writeConfig(workspace, contents);

      const result = await ensureCursorAgentTeamsMcpConfig({
        profileHome: workspace,
        mcpUrl: MCP_URL,
      });

      expect(result.action).toBe('skipped');
      expect(await fs.readFile(configPath, 'utf8')).toBe(contents);
    });

    it('preserves foreign MCP servers and every top-level key outside mcpServers', async () => {
      const existing = {
        $schema: 'https://cursor.sh/schemas/mcp.json',
        editor: { fontSize: 13 },
        mcpServers: {
          docs: { type: 'http', url: 'http://127.0.0.1:9998/docs' },
          linter: { command: 'lint-mcp', args: ['--stdio'] },
          notes: { type: 'sse', url: 'http://127.0.0.1:9997/sse', env: { NOTES: 'on' } },
        },
      };
      const configPath = await writeConfig(workspace, `${JSON.stringify(existing, null, 2)}\n`);

      const result = await ensureCursorAgentTeamsMcpConfig({
        profileHome: workspace,
        mcpUrl: MCP_URL,
      });

      expect(result.action).toBe('updated');
      const written = JSON.parse(await fs.readFile(configPath, 'utf8')) as typeof existing & {
        mcpServers: Record<string, unknown>;
      };
      expect(written.$schema).toBe(existing.$schema);
      expect(written.editor).toEqual(existing.editor);
      expect(written.mcpServers.docs).toEqual(existing.mcpServers.docs);
      expect(written.mcpServers.linter).toEqual(existing.mcpServers.linter);
      expect(written.mcpServers.notes).toEqual(existing.mcpServers.notes);
      expect(written.mcpServers[CURSOR_AGENT_TEAMS_MCP_SERVER_NAME]).toEqual({
        type: 'http',
        url: MCP_URL,
      });
    });

    it('reports the second call with the same URL as unchanged and writes nothing', async () => {
      await ensureCursorAgentTeamsMcpConfig({ profileHome: workspace, mcpUrl: MCP_URL });
      const configPath = configPathIn(workspace);
      const firstWrite = await fs.stat(configPath);
      const firstContents = await fs.readFile(configPath, 'utf8');

      const result = await ensureCursorAgentTeamsMcpConfig({
        profileHome: workspace,
        mcpUrl: MCP_URL,
      });

      expect(result.action).toBe('unchanged');
      expect(await fs.readFile(configPath, 'utf8')).toBe(firstContents);
      expect((await fs.stat(configPath)).mtimeMs).toBe(firstWrite.mtimeMs);
      expect(await fs.readdir(path.dirname(configPath))).toEqual(['mcp.json']);
    });

    it('rewrites the entry when the registered URL changed', async () => {
      await ensureCursorAgentTeamsMcpConfig({ profileHome: workspace, mcpUrl: MCP_URL });

      const result = await ensureCursorAgentTeamsMcpConfig({
        profileHome: workspace,
        mcpUrl: 'http://127.0.0.1:9998/mcp',
      });

      expect(result.action).toBe('updated');
    });

    it('refuses to write without an MCP URL', async () => {
      await expect(
        ensureCursorAgentTeamsMcpConfig({ profileHome: workspace, mcpUrl: '  ' })
      ).rejects.toThrow(/MCP URL is required/);
    });
  });

  describe('resolveCursorAcpProfileHome', () => {
    const paths = {
      platform: 'linux' as NodeJS.Platform,
      env: { XDG_DATA_HOME: '/data' } as NodeJS.ProcessEnv,
      homeDir: '/home/example',
    };

    it('resolves a well-formed profile key below the app data directory', () => {
      const home = resolveCursorAcpProfileHome('account-1_A', paths);

      expect(home?.split(/[\\/]/).slice(-4)).toEqual([
        'opencode',
        'profiles',
        'account-1_A',
        'home',
      ]);
    });

    it.each([
      ['a path separator', 'account/1'],
      ['a parent traversal', '..'],
      ['a traversal segment', '../evil'],
      ['an empty key', '   '],
      ['a non-ASCII key', 'räume'],
      ['a dotted key', 'account.1'],
    ])('rejects %s', (_label, key) => {
      expect(resolveCursorAcpProfileHome(key, paths)).toBeNull();
    });
  });

  describe('stripUrlFragment', () => {
    it('removes the fragment and nothing else', () => {
      expect(stripUrlFragment('http://127.0.0.1:9999/mcp#instance-1')).toBe(
        'http://127.0.0.1:9999/mcp'
      );
      expect(stripUrlFragment('http://127.0.0.1:9999/mcp?token=1')).toBe(
        'http://127.0.0.1:9999/mcp?token=1'
      );
      expect(stripUrlFragment('http://127.0.0.1:9999/mcp')).toBe('http://127.0.0.1:9999/mcp');
      expect(stripUrlFragment('')).toBe('');
    });
  });

  describe('prepareCursorAcpLaunchMcpConfig', () => {
    const buildPaths = (
      dataHome: string,
      homeDir: string
    ): { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; homeDir: string } => ({
      platform: 'linux',
      env: { CLAUDE_MULTIMODEL_DATA_HOME: dataHome } as NodeJS.ProcessEnv,
      homeDir,
    });

    it('registers the endpoint in the proof profile home and in the user home', async () => {
      const dataHome = path.join(workspace, 'data');
      const userHome = path.join(workspace, 'home');
      const paths = buildPaths(dataHome, userHome);

      await prepareCursorAcpLaunchMcpConfig({
        profileRootKey: 'account-1',
        mcpUrl: `${MCP_URL}#instance-1`,
        paths,
      });

      const profileHome = resolveCursorAcpProfileHome('account-1', paths);
      expect(profileHome).not.toBeNull();
      for (const home of [profileHome!, userHome]) {
        const written = JSON.parse(await fs.readFile(configPathIn(home), 'utf8')) as {
          mcpServers: Record<string, { url: string }>;
        };
        // The app-instance fragment is stripped: cursor-agent does not accept it.
        expect(written.mcpServers[CURSOR_AGENT_TEAMS_MCP_SERVER_NAME]?.url).toBe(MCP_URL);
      }
    });

    it('writes nothing at all when the launch has no MCP URL', async () => {
      const userHome = path.join(workspace, 'home');
      const paths = buildPaths(path.join(workspace, 'data'), userHome);

      await prepareCursorAcpLaunchMcpConfig({
        profileRootKey: 'account-1',
        mcpUrl: undefined,
        paths,
      });
      await prepareCursorAcpLaunchMcpConfig({ profileRootKey: 'account-1', mcpUrl: '  ', paths });
      await prepareCursorAcpLaunchMcpConfig({
        profileRootKey: 'account-1',
        mcpUrl: '#instance-1',
        paths,
      });

      await expect(fs.readdir(workspace)).resolves.toEqual([]);
    });

    it('still registers the user home when the profile key is unusable', async () => {
      const userHome = path.join(workspace, 'home');
      const paths = buildPaths(path.join(workspace, 'data'), userHome);

      await prepareCursorAcpLaunchMcpConfig({
        profileRootKey: '../escape',
        mcpUrl: MCP_URL,
        paths,
      });

      await expect(fs.readdir(workspace)).resolves.toEqual(['home']);
      await expect(fs.readFile(configPathIn(userHome), 'utf8')).resolves.toContain(
        CURSOR_AGENT_TEAMS_MCP_SERVER_NAME
      );
    });
  });
});
