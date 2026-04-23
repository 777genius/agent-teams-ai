import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import Module from 'module';
import * as os from 'os';
import * as path from 'path';

const hoisted = vi.hoisted(() => ({
  electronState: {
    isPackaged: false,
    version: '9.9.9-test',
  },
  execFileMock: vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _options:
        | { encoding?: string; timeout?: number }
        | ((error: Error | null, stdout: string, stderr: string) => void),
      callback?: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      const cb = typeof _options === 'function' ? _options : callback;
      cb?.(null, '/mock/node', '');
    }
  ),
}));

let mockHomeDir = '';
type ModuleLoad = (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
const moduleInternal = Module as unknown as { _load: ModuleLoad };
const originalModuleLoad = moduleInternal._load;

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: hoisted.execFileMock,
  };
});

vi.mock('@main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/pathDecoder')>();
  return {
    ...actual,
    getHomeDir: () => mockHomeDir || actual.getHomeDir(),
  };
});

import { setAppDataBasePath } from '@main/utils/pathDecoder';
import { TeamMcpConfigBuilder } from '@main/services/team/TeamMcpConfigBuilder';

describe('TeamMcpConfigBuilder', () => {
  const createdPaths: string[] = [];
  const createdDirs: string[] = [];
  let tempAppData: string;
  let originalResourcesPath: string | undefined;

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

  function readGeneratedServer(configPath: string): { command?: string; args?: string[] } | undefined {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    return parsed.mcpServers?.['agent-teams'];
  }

  function expectNodeEntry(server: { command?: string; args?: string[] } | undefined, entry: string): void {
    expect(server?.args).toEqual([entry]);
    expect(server?.command).toMatch(/(^node$|[\\/]node(?:\.exe)?$)/);
  }

  function mockPathExists(existingPaths: string[]): void {
    const originalAccess = fs.promises.access.bind(fs.promises);
    vi.spyOn(fs.promises, 'access').mockImplementation(async (targetPath, mode) => {
      const normalizedPath =
        typeof targetPath === 'string' ? targetPath : Buffer.isBuffer(targetPath) ? targetPath.toString() : `${targetPath}`;
      if (existingPaths.includes(normalizedPath)) {
        return;
      }
      await originalAccess(targetPath, mode);
    });
  }

  function mockBuiltWorkspaceEntryAvailable(): string {
    const builtEntry = path.join(process.cwd(), 'mcp-server', 'dist', 'index.js');
    mockPathExists([builtEntry]);
    return builtEntry;
  }

  beforeEach(() => {
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
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
    hoisted.execFileMock.mockClear();
  });

  afterEach(() => {
    setAppDataBasePath(null);
    setPackagedMode(false);
    setResourcesPath(originalResourcesPath);
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
    expect(filename).toMatch(
      new RegExp(`^agent-teams-mcp-${process.pid}-\\d+-[0-9a-f-]+\\.json$`)
    );
  });

  it('prefers the built workspace MCP entry when available', async () => {
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
      mcpServers: Record<string, { command?: string; args?: string[]; type?: string; url?: string }>;
    };

    expect(Object.keys(parsed.mcpServers)).toEqual(['agent-teams']);
    expect(parsed.mcpServers.globalOnly).toBeUndefined();
    expect(parsed.mcpServers.duplicateServer).toBeUndefined();
  });

  it('does not inline project MCP config to preserve native Claude precedence', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-project-'));
    createdDirs.push(homeDir, projectDir);
    mockHomeDir = homeDir;

    fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ mcpServers: {} }, null, 2));
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

  it('generated agent-teams server ignores same-named user MCP entry', async () => {
    const builtEntry = mockBuiltWorkspaceEntryAvailable();
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
      mcpServers: Record<string, { command?: string; args?: string[] }>;
    };

    expectNodeEntry(parsed.mcpServers['agent-teams'], builtEntry);
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

    expectNodeEntry(readGeneratedServer(configPath), path.join(resourcesDir, 'mcp-server', 'index.js'));
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

  it('packaged mode falls back to the built workspace MCP entry when resourcesPath bundle is missing', async () => {
    const builtEntry = mockBuiltWorkspaceEntryAvailable();
    setPackagedMode(true, '6.0.0');
    const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-resources-'));
    createdDirs.push(resourcesDir);
    setResourcesPath(resourcesDir);

    const builder = new TeamMcpConfigBuilder();
    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    expectNodeEntry(readGeneratedServer(configPath), builtEntry);
  });
});
