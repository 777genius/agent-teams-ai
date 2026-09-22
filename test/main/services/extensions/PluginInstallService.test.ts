import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginInstallService } from '@main/services/extensions/install/PluginInstallService';

import type { PluginCatalogService } from '@main/services/extensions/catalog/PluginCatalogService';

// ── Mock execCli ─────────────────────────────────────────────────────────────

vi.mock('@main/utils/childProcess', () => ({
  execCli: vi.fn(),
}));

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: {
    resolve: vi.fn().mockResolvedValue('/usr/local/bin/claude'),
  },
}));

import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';

import { execCli } from '@main/utils/childProcess';

const mockExecCli = vi.mocked(execCli);

// ── Mock catalog service ──────────────────────────────────────────────────────

function createMockCatalog(overrides?: Partial<PluginCatalogService>): PluginCatalogService {
  return {
    getPlugins: vi.fn(),
    getPluginReadme: vi.fn(),
    resolvePlugin: vi.fn().mockResolvedValue({
      qualifiedName: 'context7@claude-plugins-official',
    }),
    ...overrides,
  } as unknown as PluginCatalogService;
}

describe('PluginInstallService', () => {
  let service: PluginInstallService;
  let catalog: PluginCatalogService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');
    catalog = createMockCatalog();
    service = new PluginInstallService(catalog);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── install ─────────────────────────────────────────────────────────────────

  describe('install', () => {
    it('builds correct CLI args for user scope', async () => {
      mockExecCli.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await service.install({
        pluginId: 'context7',
        scope: 'user',
      });

      expect(result.state).toBe('success');
      expect(mockExecCli).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['plugin', 'install', 'context7@claude-plugins-official'],
        expect.objectContaining({ timeout: 120_000 }),
      );
    });

    it('adds scope flag for non-user scope', async () => {
      mockExecCli.mockResolvedValue({ stdout: '', stderr: '' });

      await service.install({
        pluginId: 'context7',
        scope: 'project',
        projectPath: '/tmp/test-project',
      });

      expect(mockExecCli).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['plugin', 'install', '-s', 'project', 'context7@claude-plugins-official'],
        expect.objectContaining({ cwd: '/tmp/test-project' }),
      );
    });

    it('adds local scope flag and cwd for local installs', async () => {
      mockExecCli.mockResolvedValue({ stdout: '', stderr: '' });

      await service.install({
        pluginId: 'context7',
        scope: 'local',
        projectPath: '/tmp/test-project',
      });

      expect(mockExecCli).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['plugin', 'install', '-s', 'local', 'context7@claude-plugins-official'],
        expect.objectContaining({ cwd: '/tmp/test-project' }),
      );
    });

    it('returns error if plugin not found in catalog', async () => {
      catalog = createMockCatalog({
        resolvePlugin: vi.fn().mockResolvedValue(null) as PluginCatalogService['resolvePlugin'],
      });
      service = new PluginInstallService(catalog);

      const result = await service.install({ pluginId: 'nonexistent', scope: 'user' });

      expect(result.state).toBe('error');
      expect(result.error).toContain('not found in catalog');
      expect(mockExecCli).not.toHaveBeenCalled();
    });

    it('returns error if qualifiedName has invalid format', async () => {
      catalog = createMockCatalog({
        resolvePlugin: vi.fn().mockResolvedValue({
          qualifiedName: '../../../etc/passwd',
        }) as PluginCatalogService['resolvePlugin'],
      });
      service = new PluginInstallService(catalog);

      const result = await service.install({ pluginId: 'evil', scope: 'user' });

      expect(result.state).toBe('error');
      expect(result.error).toContain('Invalid plugin identifier');
      expect(mockExecCli).not.toHaveBeenCalled();
    });

    it('returns error if CLI execution fails', async () => {
      mockExecCli.mockRejectedValue(new Error('Command failed: exit code 1'));

      const result = await service.install({ pluginId: 'context7', scope: 'user' });

      expect(result.state).toBe('error');
      expect(result.error).toContain('Command failed');
    });

    it('rejects project scope when projectPath is missing', async () => {
      const result = await service.install({ pluginId: 'context7', scope: 'project' });

      expect(result.state).toBe('error');
      expect(result.error).toContain('projectPath is required');
      expect(mockExecCli).not.toHaveBeenCalled();
    });

    it('rejects local scope when projectPath is missing', async () => {
      const result = await service.install({ pluginId: 'context7', scope: 'local' });

      expect(result.state).toBe('error');
      expect(result.error).toContain('local-scoped');
      expect(mockExecCli).not.toHaveBeenCalled();
    });
  });

  // ── uninstall ───────────────────────────────────────────────────────────────

  describe('uninstall', () => {
    it('builds correct CLI args for user scope', async () => {
      mockExecCli.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await service.uninstall('context7');

      expect(result.state).toBe('success');
      expect(mockExecCli).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['plugin', 'uninstall', 'context7@claude-plugins-official'],
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('adds scope flag for project scope', async () => {
      mockExecCli.mockResolvedValue({ stdout: '', stderr: '' });

      await service.uninstall('context7', 'project', '/tmp/test-project');

      expect(mockExecCli).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['plugin', 'uninstall', '-s', 'project', 'context7@claude-plugins-official'],
        expect.objectContaining({ cwd: '/tmp/test-project' }),
      );
    });

    it('adds scope flag for local scope', async () => {
      mockExecCli.mockResolvedValue({ stdout: '', stderr: '' });

      await service.uninstall('context7', 'local', '/tmp/test-project');

      expect(mockExecCli).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['plugin', 'uninstall', '-s', 'local', 'context7@claude-plugins-official'],
        expect.objectContaining({ cwd: '/tmp/test-project' }),
      );
    });

    it('returns error if plugin not in catalog', async () => {
      catalog = createMockCatalog({
        resolvePlugin: vi.fn().mockResolvedValue(null) as PluginCatalogService['resolvePlugin'],
      });
      service = new PluginInstallService(catalog);

      const result = await service.uninstall('nonexistent');

      expect(result.state).toBe('error');
      expect(result.error).toContain('not found in catalog');
    });

    it('returns error if CLI fails', async () => {
      mockExecCli.mockRejectedValue(new Error('Cannot uninstall'));

      const result = await service.uninstall('context7');

      expect(result.state).toBe('error');
      expect(result.error).toContain('Cannot uninstall');
    });

    it('rejects project scope when projectPath is missing', async () => {
      const result = await service.uninstall('context7', 'project');

      expect(result.state).toBe('error');
      expect(result.error).toContain('projectPath is required');
      expect(mockExecCli).not.toHaveBeenCalled();
    });

    it('rejects local scope when projectPath is missing', async () => {
      const result = await service.uninstall('context7', 'local');

      expect(result.state).toBe('error');
      expect(result.error).toContain('local-scoped');
      expect(mockExecCli).not.toHaveBeenCalled();
    });
  });
});
