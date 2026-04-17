import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

import { McpInstallationStateService } from '@main/services/extensions/state/McpInstallationStateService';

vi.mock('@main/utils/pathDecoder', () => ({
  getHomeDir: () => '/tmp/mock-home',
}));

vi.mock('node:fs/promises');

describe('McpInstallationStateService', () => {
  let service: McpInstallationStateService;
  const mockedFs = vi.mocked(fs);

  beforeEach(() => {
    service = new McpInstallationStateService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getInstalled', () => {
    it('includes local scope from the current project entry in ~/.claude.json', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = String(filePath);
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
        const normalizedPath = String(filePath);
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
        const normalizedPath = String(filePath);
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
  });
});
