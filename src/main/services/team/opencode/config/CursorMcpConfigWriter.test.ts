import { addLogSink, type LogSinkEntry } from '@shared/utils/logger';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CURSOR_AGENT_TEAMS_MCP_SERVER_NAME,
  ensureCursorAgentTeamsMcpConfig,
  ensureCursorCliConfigSeed,
  listCursorAcpProfileHomes,
  prepareCursorAcpLaunchMcpConfig,
  resolveCursorAcpProfileHome,
  type ResolveCursorAcpProfileHomeOptions,
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

  describe('listCursorAcpProfileHomes', () => {
    const buildPaths = (dataHome: string): ResolveCursorAcpProfileHomeOptions => ({
      platform: 'linux',
      env: { CLAUDE_MULTIMODEL_DATA_HOME: dataHome } as NodeJS.ProcessEnv,
      homeDir: '/home/example',
    });

    const profilesDirIn = (dataHome: string): string => path.join(dataHome, 'opencode', 'profiles');

    it('returns nothing when the app has never created a profile directory', async () => {
      await expect(
        listCursorAcpProfileHomes(buildPaths(path.join(workspace, 'absent')))
      ).resolves.toEqual([]);
    });

    it('returns only the profile directories that already have a home', async () => {
      const dataHome = path.join(workspace, 'data');
      const profilesDir = profilesDirIn(dataHome);
      await fs.mkdir(path.join(profilesDir, 'account-1', 'home'), { recursive: true });
      await fs.mkdir(path.join(profilesDir, 'account-2', 'home'), { recursive: true });
      // Created but never populated: the runtime has no home there to register in.
      await fs.mkdir(path.join(profilesDir, 'account-3'), { recursive: true });
      // A file where a profile directory would be, and a key the writer rejects.
      await fs.writeFile(path.join(profilesDir, 'stray.txt'), 'x', 'utf8');
      await fs.mkdir(path.join(profilesDir, 'account.4', 'home'), { recursive: true });

      const homes = await listCursorAcpProfileHomes(buildPaths(dataHome));

      const keys = homes
        .map((home) => path.basename(path.dirname(home)))
        .toSorted((a, b) => a.localeCompare(b));
      expect(keys).toEqual(['account-1', 'account-2']);
    });
  });

  describe('ensureCursorCliConfigSeed', () => {
    // Built from one list so the assertion below cannot drift from the fixture.
    const SECRETS = [
      'secret-auth-token',
      'secret-api-key',
      'secret-cookie',
      'secret-sign-in',
      'secret-bearer',
    ];
    const [authToken, apiKey, cookie, signIn, bearer] = SECRETS;

    const writeUserCliConfig = async (userHome: string, config: unknown): Promise<void> => {
      await fs.mkdir(path.join(userHome, '.cursor'), { recursive: true });
      await fs.writeFile(
        path.join(userHome, '.cursor', 'cli-config.json'),
        JSON.stringify(config),
        'utf8'
      );
    };

    it('copies no credential out of the user CLI config, at any depth', async () => {
      const userHome = path.join(workspace, 'home');
      const profileHome = path.join(workspace, 'profile');
      await writeUserCliConfig(userHome, {
        version: 1,
        editor: { vimMode: true },
        authToken,
        profile: { name: 'example', apiKey },
        cookies: [cookie],
        sessions: { last: { password: signIn, bearer } },
      });

      await expect(ensureCursorCliConfigSeed(profileHome, { homeDir: userHome })).resolves.toBe(
        'seeded'
      );

      const seeded = await fs.readFile(
        path.join(profileHome, '.cursor', 'cli-config.json'),
        'utf8'
      );
      for (const secret of SECRETS) {
        expect(seeded).not.toContain(secret);
      }
      expect(JSON.parse(seeded)).toEqual({
        version: 1,
        editor: { vimMode: true },
        profile: { name: 'example' },
      });
    });

    it('seeds a minimal config when the user has none', async () => {
      const profileHome = path.join(workspace, 'profile');

      await expect(
        ensureCursorCliConfigSeed(profileHome, { homeDir: path.join(workspace, 'home') })
      ).resolves.toBe('seeded');

      const seeded = await fs.readFile(
        path.join(profileHome, '.cursor', 'cli-config.json'),
        'utf8'
      );
      expect(JSON.parse(seeded)).toEqual({ version: 1 });
    });

    it('never overwrites a CLI config the profile already has', async () => {
      const profileHome = path.join(workspace, 'profile');
      const target = path.join(profileHome, '.cursor', 'cli-config.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, '{ "version": 2 }', 'utf8');
      const userHome = path.join(workspace, 'home');
      await writeUserCliConfig(userHome, { version: 1, authToken });

      await expect(ensureCursorCliConfigSeed(profileHome, { homeDir: userHome })).resolves.toBe(
        'exists'
      );

      expect(await fs.readFile(target, 'utf8')).toBe('{ "version": 2 }');
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

    it('registers the endpoint in every profile home and in the user home', async () => {
      const dataHome = path.join(workspace, 'data');
      const userHome = path.join(workspace, 'home');
      const paths = buildPaths(dataHome, userHome);
      // The lead runs out of a different profile than the one the proof names.
      const leadHome = resolveCursorAcpProfileHome('account-2', paths);
      await fs.mkdir(leadHome!, { recursive: true });

      await prepareCursorAcpLaunchMcpConfig({
        profileRootKey: 'account-1',
        mcpUrl: `${MCP_URL}#instance-1`,
        paths,
      });

      const profileHome = resolveCursorAcpProfileHome('account-1', paths);
      expect(profileHome).not.toBeNull();
      for (const home of [profileHome!, leadHome!, userHome]) {
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

    /**
     * The level is the whole signal here: the launch discards the outcome, so a
     * registration that did not happen is recorded nowhere else.
     */
    describe('failure logging', () => {
      const captureWriterLogs = (): {
        entries: LogSinkEntry[];
        consoleErrorCalls: string[];
        restore: () => void;
      } => {
        const entries: LogSinkEntry[] = [];
        const removeSink = addLogSink((entry) => {
          if (entry.namespace === 'CursorMcpConfigWriter') entries.push(entry);
        });
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        // `mockRestore` clears the call history, so it is copied out first.
        const consoleErrorCalls: string[] = [];
        return {
          entries,
          consoleErrorCalls,
          restore: (): void => {
            removeSink();
            consoleErrorCalls.push(...consoleError.mock.calls.map((call) => String(call[1])));
            consoleWarn.mockRestore();
            consoleError.mockRestore();
          },
        };
      };

      it('records a failed write at error level, once per failing step', async () => {
        const userHome = path.join(workspace, 'home');
        const paths = buildPaths(path.join(workspace, 'data'), userHome);
        const profileHome = resolveCursorAcpProfileHome('account-1', paths);
        await fs.mkdir(profileHome!, { recursive: true });
        // `.cursor` is a file, so neither the seed nor the entry can be written there.
        await fs.writeFile(path.join(profileHome!, '.cursor'), 'not a directory', 'utf8');
        const logs = captureWriterLogs();

        try {
          await prepareCursorAcpLaunchMcpConfig({
            profileRootKey: 'account-1',
            mcpUrl: MCP_URL,
            paths,
          });
        } finally {
          logs.restore();
        }

        expect(logs.entries.map((entry) => [entry.level, String(entry.args[0])])).toEqual([
          ['error', expect.stringContaining('Cursor CLI config seed failed')],
          ['error', expect.stringContaining('Cursor MCP config write failed')],
        ]);
        // Error is also the only level that survives the production console threshold.
        expect(logs.consoleErrorCalls).toEqual([
          expect.stringContaining('Cursor CLI config seed failed'),
          expect.stringContaining('Cursor MCP config write failed'),
        ]);
        // The launch still proceeds, and the home that can take the entry gets it.
        await expect(fs.readFile(configPathIn(userHome), 'utf8')).resolves.toContain(
          CURSOR_AGENT_TEAMS_MCP_SERVER_NAME
        );
      });

      it('logs nothing durable when every home takes the entry', async () => {
        const userHome = path.join(workspace, 'home');
        const paths = buildPaths(path.join(workspace, 'data'), userHome);
        const logs = captureWriterLogs();

        try {
          await prepareCursorAcpLaunchMcpConfig({
            profileRootKey: 'account-1',
            mcpUrl: MCP_URL,
            paths,
          });
        } finally {
          logs.restore();
        }

        expect(logs.entries).toEqual([]);
        await expect(fs.readFile(configPathIn(userHome), 'utf8')).resolves.toContain(
          CURSOR_AGENT_TEAMS_MCP_SERVER_NAME
        );
      });

      it('keeps the deliberate skip on an unparsable config at warning level', async () => {
        const userHome = path.join(workspace, 'home');
        const paths = buildPaths(path.join(workspace, 'data'), userHome);
        // Cursor tolerates JSONC; declining to rewrite that file is a decision.
        await writeConfig(userHome, '{ /* mine */ "mcpServers": {} }');
        const logs = captureWriterLogs();

        try {
          await prepareCursorAcpLaunchMcpConfig({
            profileRootKey: 'account-1',
            mcpUrl: MCP_URL,
            paths,
          });
        } finally {
          logs.restore();
        }

        expect(logs.entries.map((entry) => entry.level)).toEqual(['warn']);
        expect(String(logs.entries[0]?.args[0])).toContain('Cursor MCP config left untouched');
        expect(logs.consoleErrorCalls).toEqual([]);
      });
    });
  });
});
