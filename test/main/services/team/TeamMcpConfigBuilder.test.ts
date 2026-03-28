import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let mockHomeDir = '';

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

  beforeEach(() => {
    tempAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'team-mcp-appdata-'));
    createdDirs.push(tempAppData);
    setAppDataBasePath(tempAppData);
  });

  afterEach(() => {
    setAppDataBasePath(null);
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

  it('prefers the source MCP entry when workspace source is available', async () => {
    const builder = new TeamMcpConfigBuilder();

    const configPath = await builder.writeConfigFile();
    createdPaths.push(configPath);

    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };

    const server = parsed.mcpServers?.['agent-teams'];
    expect(server?.command).toBe('pnpm');
    expect(server?.args).toEqual([
      '--dir',
      path.join(process.cwd(), 'mcp-server'),
      'exec',
      'tsx',
      path.join(process.cwd(), 'mcp-server', 'src', 'index.ts'),
    ]);
  });

  it('merges top-level user MCP with generated agent-teams config', async () => {
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

    expect(Object.keys(parsed.mcpServers).sort()).toEqual([
      'agent-teams',
      'duplicateServer',
      'globalOnly',
    ]);
    expect(parsed.mcpServers.globalOnly).toMatchObject({
      type: 'http',
      url: 'https://global.example.com/mcp',
    });
    expect(parsed.mcpServers.duplicateServer).toMatchObject({
      type: 'http',
      url: 'https://global.example.com/duplicate',
    });
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

  it('generated agent-teams server overrides same-named user MCP entry', async () => {
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

    expect(parsed.mcpServers['agent-teams']).toMatchObject({
      command: 'pnpm',
      args: [
        '--dir',
        path.join(process.cwd(), 'mcp-server'),
        'exec',
        'tsx',
        path.join(process.cwd(), 'mcp-server', 'src', 'index.ts'),
      ],
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
});
