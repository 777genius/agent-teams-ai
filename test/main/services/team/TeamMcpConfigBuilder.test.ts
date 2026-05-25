import * as fs from 'fs';
import Module from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecCliMock = (
  binaryPath: string | null,
  args: string[],
  options?: {
    encoding?: BufferEncoding;
    timeout?: number;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  }
) => Promise<{ stdout: string; stderr: string }>;

type ResolveInteractiveShellEnvMock = (options?: unknown) => Promise<NodeJS.ProcessEnv>;

const hoisted = vi.hoisted(() => ({
  electronState: {
    isPackaged: false,
    version: '9.9.9-test',
  },
  execCliMock: vi.fn<ExecCliMock>(async () => ({
    stdout: JSON.stringify({ execPath: '/mock/node', version: '20.11.0' }),
    stderr: '',
  })),
  cachedShellEnv: null as NodeJS.ProcessEnv | null,
  resolveInteractiveShellEnvMock: vi.fn<ResolveInteractiveShellEnvMock>(
    async () => ({}) as NodeJS.ProcessEnv
  ),
}));

let mockHomeDir = '';
type ModuleLoad = (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
const moduleInternal = Module as unknown as { _load: ModuleLoad };
const originalModuleLoad = moduleInternal._load;

vi.mock('@main/utils/childProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/childProcess')>();
  return {
    ...actual,
    execCli: hoisted.execCliMock,
  };
});

vi.mock('@main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/pathDecoder')>();
  return {
    ...actual,
    getHomeDir: () => mockHomeDir || actual.getHomeDir(),
  };
});

vi.mock('@main/utils/shellEnv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/shellEnv')>();
  return {
    ...actual,
    getCachedShellEnv: () => hoisted.cachedShellEnv,
    resolveInteractiveShellEnv: hoisted.resolveInteractiveShellEnvMock,
  };
});

import {
  clearResolvedNodePathForTests,
  resolveAgentTeamsMcpLaunchSpec,
  TeamMcpConfigBuilder,
} from '@main/services/team/TeamMcpConfigBuilder';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';

function nodeRuntimeProbeStdout(execPath: string, version = '20.11.0'): string {
  return JSON.stringify({ execPath, version });
}

describe('TeamMcpConfigBuilder', () => {
  const createdPaths: string[] = [];
  const createdDirs: string[] = [];
  let tempAppData: string;
  let originalResourcesPath: string | undefined;
  let originalControlUrl: string | undefined;

  function setPackagedMode(isPackaged: boolean, version = '9.9.9-test'): void {
    hoisted.electronState.isPackaged = isPackaged;
    hoisted.electronState.version = version;
  }

  function setResourcesPath(resourcesPath: string | undefined): void {
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesPath,
      configurable: true,
      writable: true,
    });
  }

  function createPackagedServerBundle(baseDir: string, body = '// packaged server'): string {
    const dir = path.join(baseDir, 'mcp-server');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), body);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-teams-mcp' }));
    return dir;
  }

  function readGeneratedServer(
    configPath: string
  ):
    | { command?: string; args?: string[]; enabled?: boolean; env?: Record<string, string> }
    | undefined {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<
        string,
        { command?: string; args?: string[]; enabled?: boolean; env?: Record<string, string> }
      >;
    };
    return parsed.mcpServers?.['agent-teams'];
  }

  function expectNodeEntry(
    server: { command?: string; args?: string[] } | undefined,
    entry: string
  ): void {
    expect(server?.args).toEqual([entry]);
    expect(server?.command).toMatch(/(^node(?:-\d+)?$|[\\/]node(?:-\d+)?(?:\.exe)?$)/);
  }

  function expectNodeTsxSourceEntry(
    server: { command?: string; args?: string[] } | undefined,
    tsxCli: string,
    sourceEntry: string
  ): void {
    expect(server?.args).toEqual([tsxCli, sourceEntry]);
    expect(server?.command).toMatch(/(^node(?:-\d+)?$|[\\/]node(?:-\d+)?(?:\.exe)?$)/);
  }

  function getBuiltWorkspaceEntry(): string {
    return path.join(process.cwd(), 'mcp-server', 'dist', 'index.js');
  }

  function getSourceWorkspaceEntry(): string {
    return path.join(process.cwd(), 'mcp-server', 'src', 'index.ts');
  }

  function getWorkspaceTsxPackageJson(): string {
    return path.join(process.cwd(), 'mcp-server', 'node_modules', 'tsx', 'package.json');
  }

  function getWorkspaceTsxCli(): string {
    return path.join(process.cwd(), 'mcp-server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  }

  function mockPathExists(existingPaths: string[], options: { strict?: boolean } = {}): void {
    const originalAccess = fs.promises.access.bind(fs.promises);
    vi.spyOn(fs.promises, 'access').mockImplementation(async (targetPath, mode) => {
      const normalizedPath =
        typeof targetPath === 'string'
          ? targetPath
          : Buffer.isBuffer(targetPath)
            ? targetPath.toString()
            : `${targetPath}`;
      if (existingPaths.includes(normalizedPath)) {
        return;
      }
      if (options.strict) {
        const error = new Error(
          `ENOENT: no such file or directory, access '${normalizedPath}'`
        ) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      await originalAccess(targetPath, mode);
    });
  }

  function mockSourceWorkspaceEntryAvailable(): {
    sourceEntry: string;
    tsxPackageJson: string;
    tsxCli: string;
    builtEntry: string;
  } {
    const sourceEntry = getSourceWorkspaceEntry();
    const tsxPackageJson = getWorkspaceTsxPackageJson();
    const tsxCli = getWorkspaceTsxCli();
    const builtEntry = getBuiltWorkspaceEntry();
    mockPathExists([sourceEntry, tsxPackageJson, tsxCli, builtEntry], { strict: true });
    return { sourceEntry, tsxPackageJson, tsxCli, builtEntry };
  }

  function mockBuiltWorkspaceEntryAvailable(): string {
    const builtEntry = getBuiltWorkspaceEntry();
    mockPathExists([builtEntry], { strict: true });
    return builtEntry;
  }

  beforeEach(() => {
    clearResolvedNodePathForTests();
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    originalControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;
    tempAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-appdata-'));
    createdDirs.push(tempAppData);
    moduleInternal._load = ((request, parent, isMain) => {
      if (request === 'electron') {
        return {
          app: {
            get isPackaged() {
              return hoisted.electronState.isPackaged;
            },
            getVersion: () => hoisted.electronState.version,
            getPath: () => '/mock/electron-user-data',
          },
        };
      }
      return originalModuleLoad(request, parent, isMain);
    }) as ModuleLoad;
    setAppDataBasePath(tempAppData);
    setPackagedMode(false);
    setResourcesPath(undefined);
    hoisted.execCliMock.mockClear();
    hoisted.execCliMock.mockResolvedValue({
      stdout: nodeRuntimeProbeStdout('/mock/node'),
      stderr: '',
    });
    hoisted.cachedShellEnv = null;
    hoisted.resolveInteractiveShellEnvMock.mockClear();
    hoisted.resolveInteractiveShellEnvMock.mockResolvedValue({});
  });

  afterEach(() => {
    setAppDataBasePath(null);
    setClaudeBasePathOverride(null);
    setPackagedMode(false);
    setResourcesPath(originalResourcesPath);
    if (originalControlUrl === undefined) {
      delete process.env.CLAUDE_TEAM_CONTROL_URL;
    } else {
      process.env.CLAUDE_TEAM_CONTROL_URL = originalControlUrl;
    }
    moduleInternal._load = originalModuleLoad;
    vi.restoreAllMocks();
    for (const filePath of createdPaths.splice(0)) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // ignore cleanup issues in temp dir
      }
    }
    for (const dirPath of createdDirs.splice(0)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch {
        // ignore cleanup issues in temp dir
      }
    }
    mockHomeDir = '';
  });

  // ── Config storage ──

  it('writes config to userData/mcp-configs/, not the system default tmp', async () => {
    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    const expectedDir = path.join(tempAppData, 'mcp-configs');
    expect(configPath.startsWith(expectedDir)).toBe(true);
    // Config must NOT be in the old hardcoded location
    expect(configPath).not.toContain('claude-team-mcp');
  });

  it('config filename contains pid, timestamp, and uuid', async () => {
    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    const filename = path.basename(configPath);
    expect(filename).toMatch(new RegExp(`^agent-teams-mcp-${process.pid}-\\d+-[0-9a-f-]+\\.json$`));
  });

  it('prefers the source workspace MCP entry in dev mode when available', async () => {
    const { sourceEntry, tsxCli } = mockSourceWorkspaceEntryAvailable();
    const builder = new TeamMcpConfigBuilder();

    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };

    const server = parsed.mcpServers?.['agent-teams'];
    expectNodeTsxSourceEntry(server, tsxCli, sourceEntry);
  });

  it('pins the MCP controller to the active Claude base path', async () => {
    const claudeDir = path.join(tempAppData, 'custom-claude-root');
    setClaudeBasePathOverride(claudeDir);
    mockSourceWorkspaceEntryAvailable();
    const builder = new TeamMcpConfigBuilder();

    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    const server = readGeneratedServer(configPath);
    expect(server?.env?.AGENT_TEAMS_MCP_CLAUDE_DIR).toBe(claudeDir);
  });

  it('falls back to the built workspace MCP entry when source execution is unavailable', async () => {
    const builtEntry = mockBuiltWorkspaceEntryAvailable();
    const builder = new TeamMcpConfigBuilder();

    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };

    const server = parsed.mcpServers?.['agent-teams'];
    expectNodeEntry(server, builtEntry);
  });

  it('uses the shared CLI helper for the Node.js runtime resolver', async () => {
    mockBuiltWorkspaceEntryAvailable();
    const builder = new TeamMcpConfigBuilder();

    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    expect(readGeneratedServer(configPath)?.command).toBe('/mock/node');
    expect(hoisted.execCliMock).toHaveBeenCalledWith(
      'node',
      ['-e', expect.stringContaining('process.versions.node')],
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 5000,
        env: expect.objectContaining({ PATH: expect.any(String) }),
      })
    );
    expect(hoisted.resolveInteractiveShellEnvMock).not.toHaveBeenCalled();
  });

  it('resolves packaged MCP Node through cached shell PATH without spawning shell', async () => {
    setPackagedMode(true, '2.0.0');
    const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-resources-'));
    createdDirs.push(resourcesDir);
    createPackagedServerBundle(resourcesDir, '// packaged server');
    setResourcesPath(resourcesDir);
    hoisted.cachedShellEnv = {
      PATH: ['/mock-shell-node-bin', '/usr/bin'].join(path.delimiter),
      HOME: '/Users/tester',
    };
    hoisted.resolveInteractiveShellEnvMock.mockResolvedValue(hoisted.cachedShellEnv);
    hoisted.execCliMock.mockImplementationOnce(async () => {
      throw new Error('Electron-as-Node unavailable');
    });
    hoisted.execCliMock.mockImplementationOnce(async (command, _args, options) => {
      expect(command).toBe('node');
      const env = options?.env as NodeJS.ProcessEnv | undefined;
      expect(env?.PATH?.split(path.delimiter)[0]).toBe('/mock-shell-node-bin');
      return { stdout: nodeRuntimeProbeStdout('/mock-shell-node-bin/node'), stderr: '' };
    });

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    expect(readGeneratedServer(configPath)?.command).toBe('/mock-shell-node-bin/node');
    expect(readGeneratedServer(configPath)?.command).not.toBe('node');
    expect(hoisted.resolveInteractiveShellEnvMock).not.toHaveBeenCalled();
  });

  it.each(['linux', 'darwin', 'win32'] as const)(
    'uses the packaged Electron Node runtime for %s packaged MCP launches',
    async (platform) => {
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
      const electronBinary =
        platform === 'win32'
          ? 'C:\\Program Files\\Agent Teams AI\\agent-teams-ai.exe'
          : '/opt/Agent Teams AI/agent-teams-ai';
      setPackagedMode(true, '3.0.0');
      const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-resources-'));
      createdDirs.push(resourcesDir);
      createPackagedServerBundle(resourcesDir, '// packaged server');
      setResourcesPath(resourcesDir);
      hoisted.execCliMock.mockResolvedValue({
        stdout: 'agent-teams-electron-node-ok',
        stderr: '',
      });

      Object.defineProperty(process, 'platform', {
        value: platform,
        configurable: true,
      });
      Object.defineProperty(process, 'execPath', {
        value: electronBinary,
        configurable: true,
        writable: true,
      });

      try {
        const launchSpec = await resolveAgentTeamsMcpLaunchSpec();
        const builder = new TeamMcpConfigBuilder();
        const configPath = await builder.writeConfigFile();
        createdPaths.push(configPath);
        const server = readGeneratedServer(configPath);
        const expectedEntry = path.join(tempAppData, 'mcp-server', '3.0.0', 'index.js');

        expect(launchSpec).toEqual({
          command: electronBinary,
          args: [expectedEntry],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        });
        expect(server?.command).toBe(electronBinary);
        expect(server?.args).toEqual([expectedEntry]);
        expect(server?.env?.ELECTRON_RUN_AS_NODE).toBe('1');
        expect(hoisted.execCliMock).toHaveBeenCalledTimes(1);
        expect(hoisted.execCliMock).toHaveBeenCalledWith(
          electronBinary,
          ['-e', 'process.stdout.write("agent-teams-electron-node-ok")'],
          expect.objectContaining({
            env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
          })
        );
      } finally {
        if (platformDescriptor) {
          Object.defineProperty(process, 'platform', platformDescriptor);
        }
        if (execPathDescriptor) {
          Object.defineProperty(process, 'execPath', execPathDescriptor);
        }
      }
    }
  );

  it('falls back to strict shell env lookup when fast Node lookup cannot resolve Node', async () => {
    mockBuiltWorkspaceEntryAvailable();
    const previousNodeBinary = process.env.NODE_BINARY;
    const previousNpmNodeExecPath = process.env.npm_node_execpath;
    delete process.env.NODE_BINARY;
    delete process.env.npm_node_execpath;
    hoisted.resolveInteractiveShellEnvMock.mockResolvedValue({
      PATH: ['/strict-shell-node-bin', '/usr/bin'].join(path.delimiter),
      HOME: '/Users/tester',
    });
    hoisted.execCliMock.mockImplementation(async (command, _args, options) => {
      const env = options?.env as NodeJS.ProcessEnv | undefined;
      if (env?.PATH?.split(path.delimiter)[0] === '/strict-shell-node-bin') {
        expect(command).toBe('node');
        return { stdout: nodeRuntimeProbeStdout('/strict-shell-node-bin/node'), stderr: '' };
      }
      throw new Error(`spawn ${command} ENOENT`);
    });

    try {
      const builder = new TeamMcpConfigBuilder();
      const configPath = await builder.writeConfigFile();
      createdPaths.push(configPath);

      expect(readGeneratedServer(configPath)?.command).toBe('/strict-shell-node-bin/node');
      expect(hoisted.resolveInteractiveShellEnvMock).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'mcp-node-runtime' })
      );
    } finally {
      if (previousNodeBinary === undefined) {
        delete process.env.NODE_BINARY;
      } else {
        process.env.NODE_BINARY = previousNodeBinary;
      }
      if (previousNpmNodeExecPath === undefined) {
        delete process.env.npm_node_execpath;
      } else {
        process.env.npm_node_execpath = previousNpmNodeExecPath;
      }
    }
  });

  it('prefers strict shell env lookup over fast Node lookup from a minimal GUI PATH', async () => {
    mockBuiltWorkspaceEntryAvailable();
    const previousPath = process.env.PATH;
    process.env.PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
    hoisted.resolveInteractiveShellEnvMock.mockResolvedValue({
      PATH: ['/strict-shell-node-bin', '/usr/bin'].join(path.delimiter),
      HOME: '/Users/tester',
    });
    hoisted.execCliMock.mockImplementation(async (command, _args, options) => {
      const env = options?.env as NodeJS.ProcessEnv | undefined;
      if (env?.PATH?.split(path.delimiter)[0] === '/strict-shell-node-bin') {
        expect(command).toBe('node');
        return { stdout: nodeRuntimeProbeStdout('/strict-shell-node-bin/node'), stderr: '' };
      }
      return { stdout: nodeRuntimeProbeStdout('/fast/node'), stderr: '' };
    });

    try {
      const builder = new TeamMcpConfigBuilder();
      const configPath = await builder.writeConfigFile();
      createdPaths.push(configPath);

      expect(readGeneratedServer(configPath)?.command).toBe('/strict-shell-node-bin/node');
      expect(hoisted.resolveInteractiveShellEnvMock).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'mcp-node-runtime' })
      );
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it('falls back to strict shell env lookup when the fast Node runtime is too old', async () => {
    mockBuiltWorkspaceEntryAvailable();
    const previousNodeBinary = process.env.NODE_BINARY;
    const previousNpmNodeExecPath = process.env.npm_node_execpath;
    const previousPath = process.env.PATH;
    delete process.env.NODE_BINARY;
    delete process.env.npm_node_execpath;
    process.env.PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
    hoisted.resolveInteractiveShellEnvMock.mockResolvedValue({
      PATH: ['/strict-shell-node-bin', '/usr/bin'].join(path.delimiter),
      HOME: '/Users/tester',
    });
    hoisted.execCliMock.mockImplementation(async (command, _args, options) => {
      const env = options?.env as NodeJS.ProcessEnv | undefined;
      if (env?.PATH?.split(path.delimiter)[0] === '/strict-shell-node-bin') {
        expect(command).toBe('node');
        return {
          stdout: nodeRuntimeProbeStdout('/strict-shell-node-bin/node', '20.11.0'),
          stderr: '',
        };
      }
      return { stdout: nodeRuntimeProbeStdout('/usr/bin/node', '18.19.0'), stderr: '' };
    });

    try {
      const builder = new TeamMcpConfigBuilder();
      const configPath = await builder.writeConfigFile();
      createdPaths.push(configPath);

      expect(readGeneratedServer(configPath)?.command).toBe('/strict-shell-node-bin/node');
      expect(hoisted.resolveInteractiveShellEnvMock).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'mcp-node-runtime' })
      );
    } finally {
      if (previousNodeBinary === undefined) {
        delete process.env.NODE_BINARY;
      } else {
        process.env.NODE_BINARY = previousNodeBinary;
      }
      if (previousNpmNodeExecPath === undefined) {
        delete process.env.npm_node_execpath;
      } else {
        process.env.npm_node_execpath = previousNpmNodeExecPath;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it('falls back to strict shell env lookup when fast Node lookup reports an empty path', async () => {
    mockBuiltWorkspaceEntryAvailable();
    hoisted.resolveInteractiveShellEnvMock.mockResolvedValue({
      PATH: ['/strict-shell-node-bin', '/usr/bin'].join(path.delimiter),
      HOME: '/Users/tester',
    });
    let returnedEmptyPath = false;
    hoisted.execCliMock.mockImplementation(async (command, _args, options) => {
      const env = options?.env as NodeJS.ProcessEnv | undefined;
      if (env?.PATH?.split(path.delimiter)[0] === '/strict-shell-node-bin') {
        expect(command).toBe('node');
        return { stdout: nodeRuntimeProbeStdout('/strict-shell-node-bin/node'), stderr: '' };
      }
      if (!returnedEmptyPath) {
        returnedEmptyPath = true;
        return { stdout: '   ', stderr: '' };
      }
      throw new Error(`spawn ${command} ENOENT`);
    });

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    expect(readGeneratedServer(configPath)?.command).toBe('/strict-shell-node-bin/node');
    expect(hoisted.resolveInteractiveShellEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'mcp-node-runtime' })
    );
  });

  it('prefers an explicit NODE_BINARY over PATH-based node lookup', async () => {
    mockBuiltWorkspaceEntryAvailable();
    const previousNodeBinary = process.env.NODE_BINARY;
    process.env.NODE_BINARY = '/explicit/node';
    hoisted.execCliMock.mockImplementationOnce(async (command) => {
      expect(command).toBe('/explicit/node');
      return { stdout: nodeRuntimeProbeStdout('/explicit/node'), stderr: '' };
    });

    try {
      const builder = new TeamMcpConfigBuilder();
      const configPath = await builder.writeConfigFile();
      createdPaths.push(configPath);

      expect(readGeneratedServer(configPath)?.command).toBe('/explicit/node');
      expect(hoisted.resolveInteractiveShellEnvMock).not.toHaveBeenCalled();
    } finally {
      if (previousNodeBinary === undefined) {
        delete process.env.NODE_BINARY;
      } else {
        process.env.NODE_BINARY = previousNodeBinary;
      }
    }
  });

  it('fails fast when Node cannot be resolved instead of emitting a broken bare node command', async () => {
    mockBuiltWorkspaceEntryAvailable();
    hoisted.execCliMock.mockRejectedValue(new Error('spawn node ENOENT'));
    const builder = new TeamMcpConfigBuilder();

    await expect(builder.writeConfigFile()).rejects.toThrow(
      'Node.js runtime for Agent Teams MCP was not found'
    );
  });

  it('keeps generated team MCP config minimal and does not inline top-level user MCP', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-project-'));
    createdDirs.push(homeDir, projectDir);
    mockHomeDir = homeDir;

    fs.writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify(
        {
          mcpServers: {
            globalOnly: { type: 'http', url: 'https://global.example.com/mcp' },
            duplicateServer: { type: 'http', url: 'https://global.example.com/duplicate' },
          },
        },
        null,
        2
      )
    );

    fs.writeFileSync(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            projectOnly: { command: 'node', args: ['project-server.js'] },
            duplicateServer: { command: 'node', args: ['project-override.js'] },
          },
        },
        null,
        2
      )
    );

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile(projectDir);
    createdPaths.push(configPath);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; type?: string; url?: string }
      >;
    };

    expect(Object.keys(parsed.mcpServers)).toEqual(['agent-teams']);
    expect(parsed.mcpServers.globalOnly).toBeUndefined();
    expect(parsed.mcpServers.duplicateServer).toBeUndefined();
  });

  it('writes Agent Teams MCP only member config even when user and project MCP exist', async () => {
    const { sourceEntry, tsxCli } = mockSourceWorkspaceEntryAvailable();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-project-'));
    const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-claude-root-'));
    createdDirs.push(homeDir, projectDir, claudeRoot);
    mockHomeDir = homeDir;
    setClaudeBasePathOverride(claudeRoot);

    fs.writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify(
        {
          mcpServers: {
            'brave-real-browser': {
              command: 'node',
              args: ['brave-real-browser.js'],
            },
            context7: {
              type: 'http',
              url: 'https://context7.example.com/mcp',
            },
            'agent-teams': {
              command: 'node',
              args: ['user-shadow-agent-teams.js'],
              enabled: false,
            },
          },
          projects: {
            [projectDir]: {
              mcpServers: {
                'chrome-devtools': {
                  command: 'node',
                  args: ['chrome-devtools.js'],
                },
              },
            },
          },
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            tavily: {
              command: 'node',
              args: ['tavily.js'],
            },
          },
        },
        null,
        2
      )
    );

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile(projectDir, { mode: 'appOnly' });
    createdPaths.push(configPath);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; enabled?: boolean; env?: Record<string, string> }
      >;
    };

    expect(Object.keys(parsed.mcpServers)).toEqual(['agent-teams']);
    expectNodeTsxSourceEntry(parsed.mcpServers['agent-teams'], tsxCli, sourceEntry);
    expect(parsed.mcpServers['agent-teams']).toMatchObject({
      enabled: true,
      env: {
        AGENT_TEAMS_MCP_CLAUDE_DIR: claudeRoot,
      },
    });
    expect(parsed.mcpServers['brave-real-browser']).toBeUndefined();
    expect(parsed.mcpServers.context7).toBeUndefined();
    expect(parsed.mcpServers['chrome-devtools']).toBeUndefined();
    expect(parsed.mcpServers.tavily).toBeUndefined();
  });

  it('does not inline project MCP config to preserve native Claude precedence', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-project-'));
    createdDirs.push(homeDir, projectDir);
    mockHomeDir = homeDir;

    fs.writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify({ mcpServers: {} }, null, 2)
    );
    fs.writeFileSync(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            projectOnly: { command: 'node', args: ['project-server.js'] },
          },
        },
        null,
        2
      )
    );

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile(projectDir);
    createdPaths.push(configPath);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, { command?: string; args?: string[] }>;
    };

    expect(parsed.mcpServers.projectOnly).toBeUndefined();
    expect(Object.keys(parsed.mcpServers)).toEqual(['agent-teams']);
  });

  it('inlines allowlisted MCP servers for strict member policies with Claude precedence', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-project-'));
    createdDirs.push(homeDir, projectDir);
    mockHomeDir = homeDir;

    fs.writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify(
        {
          mcpServers: {
            github: { type: 'http', url: 'https://user.example.com/mcp' },
            sentry: { command: 'node', args: ['sentry.js'] },
          },
          projects: {
            [projectDir]: {
              mcpServers: {
                github: { type: 'http', url: 'https://local.example.com/mcp' },
              },
            },
          },
        },
        null,
        2
      )
    );

    fs.writeFileSync(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            github: { type: 'http', url: 'https://project.example.com/mcp' },
            linear: { type: 'http', url: 'https://linear.example.com/mcp' },
          },
        },
        null,
        2
      )
    );

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile(projectDir, {
      mode: 'strictAllowlist',
      serverNames: ['GitHub', 'LINEAR'],
    });
    createdPaths.push(configPath);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; type?: string; url?: string }
      >;
    };

    expect(Object.keys(parsed.mcpServers).sort()).toEqual(['agent-teams', 'github', 'linear']);
    expect(parsed.mcpServers.github).toEqual({
      type: 'http',
      url: 'https://local.example.com/mcp',
    });
    expect(parsed.mcpServers.linear).toEqual({
      type: 'http',
      url: 'https://linear.example.com/mcp',
    });
    expect(parsed.mcpServers.sentry).toBeUndefined();
  });

  it('generated agent-teams server ignores same-named user MCP entry', async () => {
    const { sourceEntry, tsxCli } = mockSourceWorkspaceEntryAvailable();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-home-'));
    createdDirs.push(homeDir);
    mockHomeDir = homeDir;

    fs.writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify(
        {
          mcpServers: {
            'agent-teams': { command: 'node', args: ['user-server.js'] },
          },
        },
        null,
        2
      )
    );

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, { command?: string; args?: string[]; enabled?: boolean }>;
    };

    expectNodeTsxSourceEntry(parsed.mcpServers['agent-teams'], tsxCli, sourceEntry);
    expect(parsed.mcpServers['agent-teams']?.enabled).toBe(true);
  });

  it('forces generated agent-teams MCP even when user, project, local, or allowlist settings shadow it', async () => {
    const { sourceEntry, tsxCli } = mockSourceWorkspaceEntryAvailable();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-project-'));
    createdDirs.push(homeDir, projectDir);
    mockHomeDir = homeDir;

    fs.writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify(
        {
          mcpServers: {
            'agent-teams': { command: 'node', args: ['user-shadow.js'], enabled: false },
          },
          projects: {
            [projectDir]: {
              mcpServers: {
                'agent-teams': {
                  command: 'node',
                  args: ['local-shadow.js'],
                  enabled: false,
                },
              },
            },
          },
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            'agent-teams': { command: 'node', args: ['project-shadow.js'], enabled: false },
          },
        },
        null,
        2
      )
    );

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile(projectDir, {
      mode: 'strictAllowlist',
      serverNames: ['agent-teams'],
    });
    createdPaths.push(configPath);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, { command?: string; args?: string[]; enabled?: boolean }>;
    };

    expect(Object.keys(parsed.mcpServers)).toEqual(['agent-teams']);
    expectNodeTsxSourceEntry(parsed.mcpServers['agent-teams'], tsxCli, sourceEntry);
    expect(parsed.mcpServers['agent-teams']?.enabled).toBe(true);
  });

  it('forces the generated agent-teams MCP server on regardless of user, local, or project settings', async () => {
    const { sourceEntry, tsxCli } = mockSourceWorkspaceEntryAvailable();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-project-'));
    createdDirs.push(homeDir, projectDir);
    mockHomeDir = homeDir;

    fs.writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify(
        {
          mcpServers: {
            'agent-teams': { command: 'node', args: ['user-disabled.js'], enabled: false },
          },
          projects: {
            [projectDir]: {
              mcpServers: {
                'agent-teams': { command: 'node', args: ['local-disabled.js'], enabled: false },
              },
            },
          },
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            'agent-teams': { command: 'node', args: ['project-disabled.js'], enabled: false },
          },
        },
        null,
        2
      )
    );

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile(projectDir);
    createdPaths.push(configPath);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, { command?: string; args?: string[]; enabled?: boolean }>;
    };

    expect(Object.keys(parsed.mcpServers)).toEqual(['agent-teams']);
    expect(parsed.mcpServers['agent-teams']?.enabled).toBe(true);
    expectNodeTsxSourceEntry(parsed.mcpServers['agent-teams'], tsxCli, sourceEntry);
  });

  it('passes the configured Claude root to the MCP server', async () => {
    const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-claude-root-'));
    createdDirs.push(claudeRoot);
    setClaudeBasePathOverride(claudeRoot);

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    expect(readGeneratedServer(configPath)?.env).toMatchObject({
      AGENT_TEAMS_MCP_CLAUDE_DIR: claudeRoot,
    });
  });

  it('passes the published control API URL to the MCP server', async () => {
    process.env.CLAUDE_TEAM_CONTROL_URL = 'http://127.0.0.1:43123';

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    expect(readGeneratedServer(configPath)?.env).toMatchObject({
      CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43123',
    });
  });

  it('allows an explicit control API URL when no MCP policy is provided', async () => {
    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile(undefined, {
      controlApiBaseUrl: 'http://127.0.0.1:43124',
    });
    createdPaths.push(configPath);

    expect(readGeneratedServer(configPath)?.env).toMatchObject({
      CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43124',
    });
  });

  it('ignores malformed user MCP file', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-project-'));
    createdDirs.push(homeDir, projectDir);
    mockHomeDir = homeDir;

    fs.writeFileSync(path.join(homeDir, '.claude.json'), '{ invalid json');

    const builder = new TeamMcpConfigBuilder();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let configPath = '';
    try {
      configPath = await builder.writeConfigFile(projectDir);
    } finally {
      warnSpy.mockRestore();
    }
    createdPaths.push(configPath);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, { command?: string; args?: string[] }>;
    };

    expect(Object.keys(parsed.mcpServers)).toEqual(['agent-teams']);
  });

  // ── Cleanup: removeConfigFile ──

  it('removeConfigFile deletes the file', async () => {
    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();

    expect(fs.existsSync(configPath)).toBe(true);
    await builder.removeConfigFile(configPath);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('removeConfigFile ignores ENOENT', async () => {
    const builder = new TeamMcpConfigBuilder();
    const bogusPath = path.join(tempAppData, 'nonexistent.json');

    // Should not throw
    await builder.removeConfigFile(bogusPath);
  });

  it('removeConfigFile defers Windows locked temp config cleanup without warning', async () => {
    const builder = new TeamMcpConfigBuilder();
    const configPath = path.join(
      tempAppData,
      'mcp-configs',
      `agent-teams-mcp-${process.pid}-locked.json`
    );
    const originalUnlink = fs.promises.unlink.bind(fs.promises);
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (targetPath) => {
      if (targetPath === configPath) {
        const error = new Error('EPERM: operation not permitted, unlink') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      await originalUnlink(targetPath);
    });

    await builder.removeConfigFile(configPath);

    expect(unlinkSpy).toHaveBeenCalledTimes(4);
  });

  // ── Cleanup: gcOwnConfigs ──

  it('gcOwnConfigs removes only files owned by current pid', async () => {
    const configDir = path.join(tempAppData, 'mcp-configs');
    fs.mkdirSync(configDir, { recursive: true });

    const ownFile = path.join(configDir, `agent-teams-mcp-${process.pid}-12345-abc.json`);
    const otherFile = path.join(configDir, `agent-teams-mcp-99999-12345-xyz.json`);
    fs.writeFileSync(ownFile, '{}');
    fs.writeFileSync(otherFile, '{}');

    const builder = new TeamMcpConfigBuilder();
    await builder.gcOwnConfigs();

    expect(fs.existsSync(ownFile)).toBe(false);
    expect(fs.existsSync(otherFile)).toBe(true);
  });

  // ── Cleanup: gcStaleConfigs ──

  it('gcStaleConfigs removes files older than TTL', async () => {
    const configDir = path.join(tempAppData, 'mcp-configs');
    fs.mkdirSync(configDir, { recursive: true });

    const oldFile = path.join(configDir, `agent-teams-mcp-999-1-old.json`);
    fs.writeFileSync(oldFile, '{}');
    // Set mtime to 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, twoDaysAgo, twoDaysAgo);

    const freshFile = path.join(configDir, `agent-teams-mcp-999-2-fresh.json`);
    fs.writeFileSync(freshFile, '{}');

    const builder = new TeamMcpConfigBuilder();
    await builder.gcStaleConfigs(24 * 60 * 60 * 1000); // 24h TTL

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });

  it('gcStaleConfigs does not remove fresh files', async () => {
    const configDir = path.join(tempAppData, 'mcp-configs');
    fs.mkdirSync(configDir, { recursive: true });

    const freshFile = path.join(configDir, `agent-teams-mcp-1-1234-abc.json`);
    fs.writeFileSync(freshFile, '{}');

    const builder = new TeamMcpConfigBuilder();
    await builder.gcStaleConfigs(24 * 60 * 60 * 1000);

    expect(fs.existsSync(freshFile)).toBe(true);
  });

  it('gcStaleConfigs handles empty or missing directory gracefully', async () => {
    const builder = new TeamMcpConfigBuilder();
    // Should not throw when directory doesn't exist
    await builder.gcStaleConfigs();
  });

  // ── Packaged copy / fallback ──

  it('packaged mode reuses an existing valid stable copy', async () => {
    setPackagedMode(true, '1.2.3');
    setResourcesPath(tempAppData);
    const stableDir = path.join(tempAppData, 'mcp-server', '1.2.3');
    fs.mkdirSync(stableDir, { recursive: true });
    fs.writeFileSync(path.join(stableDir, 'index.js'), '// stable copy');
    fs.writeFileSync(path.join(stableDir, 'package.json'), JSON.stringify({ name: 'stable' }));

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    expectNodeEntry(readGeneratedServer(configPath), path.join(stableDir, 'index.js'));
  });

  it('packaged mode copies the MCP server from resourcesPath into userData', async () => {
    setPackagedMode(true, '2.0.0');
    const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-resources-'));
    createdDirs.push(resourcesDir);
    createPackagedServerBundle(resourcesDir, '// copied server');
    setResourcesPath(resourcesDir);

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    const stableDir = path.join(tempAppData, 'mcp-server', '2.0.0');
    expect(fs.existsSync(path.join(stableDir, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(stableDir, 'package.json'))).toBe(true);
    expectNodeEntry(readGeneratedServer(configPath), path.join(stableDir, 'index.js'));
  });

  it('packaged mode heals a partial stable copy and rebuilds it from resourcesPath', async () => {
    setPackagedMode(true, '3.0.0');
    const stableDir = path.join(tempAppData, 'mcp-server', '3.0.0');
    fs.mkdirSync(stableDir, { recursive: true });
    fs.writeFileSync(path.join(stableDir, 'index.js'), '// partial copy only');

    const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-resources-'));
    createdDirs.push(resourcesDir);
    createPackagedServerBundle(resourcesDir, '// healed server');
    setResourcesPath(resourcesDir);

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    expect(fs.readFileSync(path.join(stableDir, 'index.js'), 'utf8')).toContain('healed server');
    expect(fs.existsSync(path.join(stableDir, 'package.json'))).toBe(true);
    expect(readGeneratedServer(configPath)?.args).toEqual([path.join(stableDir, 'index.js')]);
  });

  it('packaged mode falls back to resourcesPath when stable copy creation fails', async () => {
    setPackagedMode(true, '4.0.0');
    const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-resources-'));
    createdDirs.push(resourcesDir);
    createPackagedServerBundle(resourcesDir, '// fallback server');
    setResourcesPath(resourcesDir);

    vi.spyOn(fs.promises, 'copyFile').mockRejectedValueOnce(new Error('copy failed'));

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    expectNodeEntry(
      readGeneratedServer(configPath),
      path.join(resourcesDir, 'mcp-server', 'index.js')
    );
  });

  it('packaged mode uses the winner stable copy when atomic rename loses the race', async () => {
    setPackagedMode(true, '5.0.0');
    const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-resources-'));
    createdDirs.push(resourcesDir);
    createPackagedServerBundle(resourcesDir, '// race source');
    setResourcesPath(resourcesDir);

    const stableDir = path.join(tempAppData, 'mcp-server', '5.0.0');
    const originalRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (to === stableDir) {
        fs.mkdirSync(stableDir, { recursive: true });
        fs.writeFileSync(path.join(stableDir, 'index.js'), '// winner copy');
        fs.writeFileSync(path.join(stableDir, 'package.json'), JSON.stringify({ name: 'winner' }));
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      return originalRename(from, to);
    });

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    expect(fs.readFileSync(path.join(stableDir, 'index.js'), 'utf8')).toContain('winner copy');
    expectNodeEntry(readGeneratedServer(configPath), path.join(stableDir, 'index.js'));
  });

  it('packaged mode falls back to the source workspace MCP entry when resourcesPath bundle is missing', async () => {
    const { sourceEntry, tsxCli } = mockSourceWorkspaceEntryAvailable();
    setPackagedMode(true, '6.0.0');
    const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-resources-'));
    createdDirs.push(resourcesDir);
    setResourcesPath(resourcesDir);

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    expectNodeTsxSourceEntry(readGeneratedServer(configPath), tsxCli, sourceEntry);
  });
});
