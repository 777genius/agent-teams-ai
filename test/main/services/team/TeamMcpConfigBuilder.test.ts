import { afterEach, describe, expect, it, vi } from 'vitest';
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

import { TeamMcpConfigBuilder } from '@main/services/team/TeamMcpConfigBuilder';

describe('TeamMcpConfigBuilder', () => {
  const createdPaths: string[] = [];
  const createdDirs: string[] = [];

  afterEach(() => {
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
      `${process.cwd()}/mcp-server`,
      'exec',
      'tsx',
      `${process.cwd()}/mcp-server/src/index.ts`,
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
        `${process.cwd()}/mcp-server`,
        'exec',
        'tsx',
        `${process.cwd()}/mcp-server/src/index.ts`,
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
});
