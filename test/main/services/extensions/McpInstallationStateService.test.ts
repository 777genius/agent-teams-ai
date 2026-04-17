import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { McpInstallationStateService } from '@main/services/extensions/state/McpInstallationStateService';

const TEST_ROOT = path.parse(process.cwd()).root || path.sep;
const MOCK_HOME_PATH = path.join(TEST_ROOT, 'tmp', 'mock-home');
const PROJECT_A_PATH = path.join(TEST_ROOT, 'tmp', 'project-a');
const PROJECT_B_PATH = path.join(TEST_ROOT, 'tmp', 'project-b');

function normalizeMockPath(filePath: unknown): string {
  return String(filePath).replaceAll('\\', '/');
}

vi.mock('@main/utils/pathDecoder', () => ({
  getHomeDir: () => MOCK_HOME_PATH,
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
        const normalizedPath = normalizeMockPath(filePath);
        if (normalizedPath === normalizeMockPath(path.join(MOCK_HOME_PATH, '.claude.json'))) {
          return JSON.stringify({
            mcpServers: {
              context7: { command: 'npx -y @upstash/context7-mcp' },
            },
            projects: {
              [PROJECT_A_PATH]: {
                mcpServers: {
                  stripe: { url: 'https://mcp.stripe.com' },
                },
              },
            },
          });
        }

        if (normalizedPath === normalizeMockPath(path.join(PROJECT_A_PATH, '.mcp.json'))) {
          return JSON.stringify({
            mcpServers: {
              paypal: { url: 'https://mcp.paypal.com/mcp' },
            },
          });
        }

        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const entries = await service.getInstalled(PROJECT_A_PATH);

      expect(entries).toEqual([
        { name: 'context7', scope: 'user', transport: 'stdio' },
        { name: 'stripe', scope: 'local', transport: 'http' },
        { name: 'paypal', scope: 'project', transport: 'http' },
      ]);
    });

    it('caches results within TTL for the same project path', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = normalizeMockPath(filePath);
        if (normalizedPath === normalizeMockPath(path.join(MOCK_HOME_PATH, '.claude.json'))) {
          return JSON.stringify({
            mcpServers: {
              context7: { command: 'npx -y @upstash/context7-mcp' },
            },
          });
        }

        if (normalizedPath === normalizeMockPath(path.join(PROJECT_A_PATH, '.mcp.json'))) {
          return JSON.stringify({
            mcpServers: {
              'repo-a-server': { url: 'https://repo-a.example.com/mcp' },
            },
          });
        }

        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await service.getInstalled(PROJECT_A_PATH);
      await service.getInstalled(PROJECT_A_PATH);

      expect(mockedFs.readFile).toHaveBeenCalledTimes(2);
    });

    it('caches results independently per project path', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = normalizeMockPath(filePath);
        if (normalizedPath === normalizeMockPath(path.join(MOCK_HOME_PATH, '.claude.json'))) {
          return JSON.stringify({
            mcpServers: {
              context7: { command: 'npx -y @upstash/context7-mcp' },
            },
            projects: {
              [PROJECT_A_PATH]: {
                mcpServers: {
                  stripe: { url: 'https://mcp.stripe.com' },
                },
              },
              [PROJECT_B_PATH]: {
                mcpServers: {
                  github: { command: 'uvx github-mcp' },
                },
              },
            },
          });
        }

        if (normalizedPath === normalizeMockPath(path.join(PROJECT_A_PATH, '.mcp.json'))) {
          return JSON.stringify({
            mcpServers: {
              'repo-a-server': { url: 'https://repo-a.example.com/mcp' },
            },
          });
        }

        if (normalizedPath === normalizeMockPath(path.join(PROJECT_B_PATH, '.mcp.json'))) {
          return JSON.stringify({
            mcpServers: {
              'repo-b-server': { command: 'uvx repo-b-mcp' },
            },
          });
        }

        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const projectAEntries = await service.getInstalled(PROJECT_A_PATH);
      const projectBEntries = await service.getInstalled(PROJECT_B_PATH);

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
