import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

import { PluginInstallationStateService } from '@main/services/extensions/state/PluginInstallationStateService';

// Mock pathDecoder to control ~/.claude path
vi.mock('@main/utils/pathDecoder', () => ({
  getClaudeBasePath: () => '/tmp/mock-claude',
}));

// Mock filesystem
vi.mock('node:fs/promises');

function toPortablePath(filePath: unknown): string {
  return String(filePath).replaceAll('\\', '/');
}

describe('PluginInstallationStateService', () => {
  let service: PluginInstallationStateService;
  const mockedFs = vi.mocked(fs);

  beforeEach(() => {
    service = new PluginInstallationStateService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getInstalledPlugins', () => {
    it('returns user-scoped plugins enabled in user settings', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = toPortablePath(filePath);
        if (normalizedPath.endsWith('/plugins/installed_plugins.json')) {
          return JSON.stringify({
            version: 2,
            plugins: {
              'context7@claude-plugins-official': [
                {
                  scope: 'user',
                  installPath:
                    '/Users/test/.claude/plugins/cache/claude-plugins-official/context7/1.0.0',
                  version: '1.0.0',
                  installedAt: '2026-03-01T11:14:21.926Z',
                },
              ],
              'typescript-lsp@claude-plugins-official': [
                {
                  scope: 'project',
                  version: '1.0.0',
                  installedAt: '2026-03-03T10:00:00.000Z',
                },
              ],
            },
          });
        }

        if (normalizedPath === '/tmp/mock-claude/settings.json') {
          return JSON.stringify({
            enabledPlugins: {
              'context7@claude-plugins-official': true,
            },
          });
        }

        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const entries = await service.getInstalledPlugins();

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        pluginId: 'context7@claude-plugins-official',
        scope: 'user',
        version: '1.0.0',
      });
    });

    it('includes project and local scopes only for the active project', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = toPortablePath(filePath);
        if (normalizedPath.endsWith('/plugins/installed_plugins.json')) {
          return JSON.stringify({
            version: 2,
            plugins: {
              'context7@claude-plugins-official': [
                {
                  scope: 'user',
                  version: '1.0.0',
                  installedAt: '2026-03-01T11:14:21.926Z',
                },
              ],
              'typescript-lsp@claude-plugins-official': [
                {
                  scope: 'project',
                  version: '1.1.0',
                  installedAt: '2026-03-03T10:00:00.000Z',
                },
              ],
              'formatter@claude-plugins-official': [
                {
                  scope: 'local',
                  version: '2.0.0',
                  installedAt: '2026-03-04T10:00:00.000Z',
                },
              ],
            },
          });
        }

        if (normalizedPath === '/tmp/mock-claude/settings.json') {
          return JSON.stringify({
            enabledPlugins: {
              'context7@claude-plugins-official': true,
            },
          });
        }

        if (normalizedPath === '/tmp/project-a/.claude/settings.json') {
          return JSON.stringify({
            enabledPlugins: {
              'typescript-lsp@claude-plugins-official': true,
            },
          });
        }

        if (normalizedPath === '/tmp/project-a/.claude/settings.local.json') {
          return JSON.stringify({
            enabledPlugins: {
              'formatter@claude-plugins-official': true,
            },
          });
        }

        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const entries = await service.getInstalledPlugins('/tmp/project-a');

      expect(entries.map((entry) => [entry.pluginId, entry.scope])).toEqual([
        ['context7@claude-plugins-official', 'user'],
        ['typescript-lsp@claude-plugins-official', 'project'],
        ['formatter@claude-plugins-official', 'local'],
      ]);
    });

    it('does not leak another project scope into the current project', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = toPortablePath(filePath);
        if (normalizedPath.endsWith('/plugins/installed_plugins.json')) {
          return JSON.stringify({
            version: 2,
            plugins: {
              'typescript-lsp@claude-plugins-official': [
                {
                  scope: 'project',
                  version: '1.1.0',
                  installedAt: '2026-03-03T10:00:00.000Z',
                },
              ],
            },
          });
        }

        if (normalizedPath.endsWith('/settings.json')) {
          return JSON.stringify({ enabledPlugins: {} });
        }

        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const entries = await service.getInstalledPlugins('/tmp/project-b');

      expect(entries).toEqual([]);
    });

    it('returns empty array when file does not exist', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      mockedFs.readFile.mockRejectedValue(enoent);

      const entries = await service.getInstalledPlugins();
      expect(entries).toEqual([]);
    });

    it('returns empty array for unexpected version', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = toPortablePath(filePath);
        if (normalizedPath.endsWith('/plugins/installed_plugins.json')) {
          return JSON.stringify({ version: 1, plugins: {} });
        }
        if (normalizedPath.endsWith('/settings.json')) {
          return JSON.stringify({ enabledPlugins: {} });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const entries = await service.getInstalledPlugins();
      expect(entries).toEqual([]);
    });

    it('caches within TTL', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = toPortablePath(filePath);
        if (normalizedPath.endsWith('/plugins/installed_plugins.json')) {
          return JSON.stringify({ version: 2, plugins: {} });
        }
        if (normalizedPath.endsWith('/settings.json')) {
          return JSON.stringify({ enabledPlugins: {} });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await service.getInstalledPlugins();
      await service.getInstalledPlugins();

      expect(mockedFs.readFile).toHaveBeenCalledTimes(2);
    });

    it('caches results independently per project path', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = toPortablePath(filePath);
        if (normalizedPath.endsWith('/plugins/installed_plugins.json')) {
          return JSON.stringify({ version: 2, plugins: {} });
        }
        if (normalizedPath.endsWith('/settings.json')) {
          return JSON.stringify({ enabledPlugins: {} });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await service.getInstalledPlugins('/tmp/project-a');
      await service.getInstalledPlugins('/tmp/project-b');

      expect(mockedFs.readFile).toHaveBeenCalledTimes(8);
    });
  });

  describe('getInstallCounts', () => {
    it('parses install-counts-cache.json', async () => {
      const countsData = {
        version: 1,
        fetchedAt: '2026-03-06T18:17:44.050Z',
        counts: [
          { plugin: 'frontend-design@claude-plugins-official', unique_installs: 277472 },
          { plugin: 'context7@claude-plugins-official', unique_installs: 150681 },
        ],
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(countsData));

      const counts = await service.getInstallCounts();

      expect(counts.get('frontend-design@claude-plugins-official')).toBe(277472);
      expect(counts.get('context7@claude-plugins-official')).toBe(150681);
      expect(counts.get('nonexistent')).toBeUndefined();
    });

    it('returns empty map when file does not exist', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      mockedFs.readFile.mockRejectedValue(enoent);

      const counts = await service.getInstallCounts();
      expect(counts.size).toBe(0);
    });

    it('caches within TTL', async () => {
      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({ version: 1, counts: [] }),
      );

      await service.getInstallCounts();
      await service.getInstallCounts();

      expect(mockedFs.readFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidateCache', () => {
    it('forces re-read after invalidation', async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const normalizedPath = String(filePath);
        if (normalizedPath.endsWith('/plugins/installed_plugins.json')) {
          return JSON.stringify({ version: 2, plugins: {} });
        }
        if (normalizedPath.endsWith('/settings.json')) {
          return JSON.stringify({ enabledPlugins: {} });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await service.getInstalledPlugins();
      service.invalidateCache();
      await service.getInstalledPlugins();

      expect(mockedFs.readFile).toHaveBeenCalledTimes(4);
    });
  });
});
