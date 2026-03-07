import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

import { PluginInstallationStateService } from '@main/services/extensions/state/PluginInstallationStateService';

// Mock pathDecoder to control ~/.claude path
vi.mock('@main/utils/pathDecoder', () => ({
  getClaudeBasePath: () => '/tmp/mock-claude',
}));

// Mock filesystem
vi.mock('node:fs/promises');

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
    it('parses installed_plugins.json version 2 format', async () => {
      const installedData = {
        version: 2,
        plugins: {
          'context7@claude-plugins-official': [
            {
              scope: 'user',
              installPath: '/Users/test/.claude/plugins/cache/claude-plugins-official/context7/1.0.0',
              version: '1.0.0',
              installedAt: '2026-03-01T11:14:21.926Z',
            },
          ],
          'typescript-lsp@claude-plugins-official': [
            {
              scope: 'user',
              version: '1.0.0',
              installedAt: '2026-03-02T10:00:00.000Z',
            },
            {
              scope: 'project',
              version: '1.0.0',
              installedAt: '2026-03-03T10:00:00.000Z',
            },
          ],
        },
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(installedData));

      const entries = await service.getInstalledPlugins();

      expect(entries).toHaveLength(3);
      expect(entries[0].pluginId).toBe('context7@claude-plugins-official');
      expect(entries[0].scope).toBe('user');
      expect(entries[0].version).toBe('1.0.0');

      expect(entries[1].pluginId).toBe('typescript-lsp@claude-plugins-official');
      expect(entries[1].scope).toBe('user');

      expect(entries[2].pluginId).toBe('typescript-lsp@claude-plugins-official');
      expect(entries[2].scope).toBe('project');
    });

    it('returns empty array when file does not exist', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      mockedFs.readFile.mockRejectedValue(enoent);

      const entries = await service.getInstalledPlugins();
      expect(entries).toEqual([]);
    });

    it('returns empty array for unexpected version', async () => {
      mockedFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, plugins: {} }));

      const entries = await service.getInstalledPlugins();
      expect(entries).toEqual([]);
    });

    it('caches within TTL', async () => {
      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({ version: 2, plugins: {} }),
      );

      await service.getInstalledPlugins();
      await service.getInstalledPlugins();

      // Only one read
      expect(mockedFs.readFile).toHaveBeenCalledTimes(1);
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
      mockedFs.readFile.mockResolvedValue(
        JSON.stringify({ version: 2, plugins: {} }),
      );

      await service.getInstalledPlugins();
      service.invalidateCache();
      await service.getInstalledPlugins();

      expect(mockedFs.readFile).toHaveBeenCalledTimes(2);
    });
  });
});
