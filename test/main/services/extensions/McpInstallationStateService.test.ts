import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

import { ClaudeExtensionsAdapter } from '@main/services/extensions/runtime/ExtensionsRuntimeAdapter';
import { McpConfigStateReader } from '@main/services/extensions/runtime/McpConfigStateReader';
import { McpInstallationStateService } from '@main/services/extensions/state/McpInstallationStateService';

vi.mock('@main/utils/pathDecoder', () => ({
  getHomeDir: () => '/tmp/mock-home',
  getClaudeBasePath: () => '/tmp/mock-home/.claude',
  setClaudeBasePathOverride: vi.fn(),
}));

vi.mock('node:fs/promises');

function toPortablePath(filePath: unknown): string {
  return String(filePath).replaceAll('\\', '/');
}

describe('McpInstallationStateService', () => {
  let service: McpInstallationStateService;
  const mockedFs = vi.mocked(fs);

  beforeEach(() => {
    service = new McpInstallationStateService(
      new ClaudeExtensionsAdapter(new McpConfigStateReader())
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getInstalled', () => {
    it('includes local scope from the current project entry in ~/.claude.json', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = toPortablePath(filePath);
        if (normalizedPath === '/tmp/mock-home/.claude.json') {
          return JSON.stringify({
            mcpServers: {
              context7: { command: 'npx -y @upstash/context7-mcp' },
            },
            projects: {
              '/tmp/project-a': {
                mcpServers: {
                  stripe: { url: 'https://mcp.stripe.com' },
                },
              },
            },
          });
        }

        if (normalizedPath === '/tmp/project-a/.mcp.json') {
          return JSON.stringify({
            mcpServers: {
              paypal: { url: 'https://mcp.paypal.com/mcp' },
            },
          });
        }

        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const entries = await service.getInstalled('/tmp/project-a');

      expect(entries).toEqual([
        { name: 'context7', scope: 'user', transport: 'stdio' },
        { name: 'stripe', scope: 'local', transport: 'http' },
        { name: 'paypal', scope: 'project', transport: 'http' },
      ]);
    });

    it('caches results within TTL for the same project path', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = toPortablePath(filePath);
        if (normalizedPath === '/tmp/mock-home/.claude.json') {
          return JSON.stringify({
            mcpServers: {
              context7: { command: 'npx -y @upstash/context7-mcp' },
            },
          });
        }

        if (normalizedPath === '/tmp/project-a/.mcp.json') {
          return JSON.stringify({
            mcpServers: {
              'repo-a-server': { url: 'https://repo-a.example.com/mcp' },
            },
          });
        }

        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await service.getInstalled('/tmp/project-a');
      await service.getInstalled('/tmp/project-a');

      expect(mockedFs.readFile).toHaveBeenCalledTimes(2);
    });

    it('caches results independently per project path', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = toPortablePath(filePath);
        if (normalizedPath === '/tmp/mock-home/.claude.json') {
          return JSON.stringify({
            mcpServers: {
              context7: { command: 'npx -y @upstash/context7-mcp' },
            },
            projects: {
              '/tmp/project-a': {
                mcpServers: {
                  stripe: { url: 'https://mcp.stripe.com' },
                },
              },
              '/tmp/project-b': {
                mcpServers: {
                  github: { command: 'uvx github-mcp' },
                },
              },
            },
          });
        }

        if (normalizedPath === '/tmp/project-a/.mcp.json') {
          return JSON.stringify({
            mcpServers: {
              'repo-a-server': { url: 'https://repo-a.example.com/mcp' },
            },
          });
        }

        if (normalizedPath === '/tmp/project-b/.mcp.json') {
          return JSON.stringify({
            mcpServers: {
              'repo-b-server': { command: 'uvx repo-b-mcp' },
            },
          });
        }

        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const projectAEntries = await service.getInstalled('/tmp/project-a');
      const projectBEntries = await service.getInstalled('/tmp/project-b');

      expect(projectAEntries).toEqual([
        { name: 'context7', scope: 'user', transport: 'stdio' },
        { name: 'stripe', scope: 'local', transport: 'http' },
        { name: 'repo-a-server', scope: 'project', transport: 'http' },
      ]);
      expect(projectBEntries).toEqual([
        { name: 'context7', scope: 'user', transport: 'stdio' },
        { name: 'github', scope: 'local', transport: 'stdio' },
        { name: 'repo-b-server', scope: 'project', transport: 'stdio' },
      ]);
      expect(mockedFs.readFile).toHaveBeenCalledTimes(4);
    });

    it('supports multimodel MCP state through the runtime adapter contract', async () => {
      const getInstalledMcp = vi
        .fn()
        .mockResolvedValueOnce([{ name: 'context7', scope: 'user', transport: 'stdio' }])
        .mockResolvedValueOnce([{ name: 'repo-mcp', scope: 'project', transport: 'http' }]);
      service = new McpInstallationStateService({
        flavor: 'agent_teams_orchestrator',
        buildManagementCliEnv: vi.fn(),
        diagnoseMcp: vi.fn(),
        getInstalledMcp,
      });

      await expect(service.getInstalled('/tmp/project-a')).resolves.toEqual([
        { name: 'context7', scope: 'user', transport: 'stdio' },
      ]);
      await expect(service.getInstalled('/tmp/project-b')).resolves.toEqual([
        { name: 'repo-mcp', scope: 'project', transport: 'http' },
      ]);
      expect(getInstalledMcp).toHaveBeenCalledTimes(2);
      expect(getInstalledMcp).toHaveBeenNthCalledWith(1, '/tmp/project-a');
      expect(getInstalledMcp).toHaveBeenNthCalledWith(2, '/tmp/project-b');
    });
  });
});
