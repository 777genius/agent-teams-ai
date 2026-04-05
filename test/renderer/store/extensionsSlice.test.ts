/**
 * Tests for extensionsSlice — global catalog caches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestStore, type TestStore } from './storeTestUtils';

// Mock the renderer api module
vi.mock('../../../src/renderer/api', () => ({
  api: {
    plugins: {
      getAll: vi.fn(),
      getReadme: vi.fn(),
      install: vi.fn(),
      uninstall: vi.fn(),
    },
    mcpRegistry: {
      search: vi.fn(),
      browse: vi.fn(),
      getById: vi.fn(),
      getInstalled: vi.fn(),
      diagnose: vi.fn(),
      install: vi.fn(),
      uninstall: vi.fn(),
    },
    skills: {
      list: vi.fn(),
      getDetail: vi.fn(),
      previewUpsert: vi.fn(),
      applyUpsert: vi.fn(),
      previewImport: vi.fn(),
      applyImport: vi.fn(),
      deleteSkill: vi.fn(),
      startWatching: vi.fn(),
      stopWatching: vi.fn(),
      onChanged: vi.fn(),
    },
  },
}));

import { api } from '../../../src/renderer/api';

import type {
  EnrichedPlugin,
  McpCatalogItem,
  SkillCatalogItem,
  SkillDetail,
} from '../../../src/shared/types/extensions';

const makePlugin = (overrides: Partial<EnrichedPlugin>): EnrichedPlugin => ({
  pluginId: 'test@marketplace',
  marketplaceId: 'test@marketplace',
  qualifiedName: 'test@marketplace',
  name: 'Test Plugin',
  source: 'official',
  description: 'A test plugin',
  category: 'testing',
  hasLspServers: false,
  hasMcpServers: false,
  hasAgents: false,
  hasCommands: false,
  hasHooks: false,
  isExternal: false,
  installCount: 100,
  isInstalled: false,
  installations: [],
  ...overrides,
});

const makeMcpServer = (overrides: Partial<McpCatalogItem>): McpCatalogItem => ({
  id: 'test-server',
  name: 'Test Server',
  description: 'A test MCP server',
  source: 'official',
  installSpec: null,
  envVars: [],
  tools: [],
  requiresAuth: false,
  ...overrides,
});

const makeSkill = (overrides: Partial<SkillCatalogItem>): SkillCatalogItem => ({
  id: '/tmp/skills/demo',
  sourceType: 'filesystem',
  name: 'Demo Skill',
  description: 'Helps with demo work',
  folderName: 'demo',
  scope: 'user',
  rootKind: 'claude',
  projectRoot: null,
  discoveryRoot: '/tmp/skills',
  skillDir: '/tmp/skills/demo',
  skillFile: '/tmp/skills/demo/SKILL.md',
  metadata: {},
  invocationMode: 'auto',
  flags: {
    hasScripts: false,
    hasReferences: false,
    hasAssets: false,
  },
  isValid: true,
  issues: [],
  modifiedAt: 1,
  ...overrides,
});

const makeSkillDetail = (overrides: Partial<SkillDetail> = {}): SkillDetail => ({
  item: makeSkill({ id: '/tmp/skills/demo', skillDir: '/tmp/skills/demo' }),
  body: 'body',
  rawContent: '# Demo',
  rawFrontmatter: null,
  referencesFiles: [],
  scriptFiles: [],
  assetFiles: [],
  ...overrides,
});

describe('extensionsSlice', () => {
  let store: TestStore;

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchPluginCatalog', () => {
    it('fetches and stores plugins', async () => {
      const plugins = [makePlugin({ pluginId: 'a@m' }), makePlugin({ pluginId: 'b@m' })];
      (api.plugins!.getAll as ReturnType<typeof vi.fn>).mockResolvedValue(plugins);

      await store.getState().fetchPluginCatalog();

      expect(store.getState().pluginCatalog).toHaveLength(2);
      expect(store.getState().pluginCatalogLoading).toBe(false);
      expect(store.getState().pluginCatalogError).toBeNull();
    });

    it('sets error on failure', async () => {
      (api.plugins!.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

      await store.getState().fetchPluginCatalog();

      expect(store.getState().pluginCatalog).toEqual([]);
      expect(store.getState().pluginCatalogError).toBe('boom');
      expect(store.getState().pluginCatalogLoading).toBe(false);
    });
  });

  describe('fetchPluginReadme', () => {
    it('fetches and caches README', async () => {
      (api.plugins!.getReadme as ReturnType<typeof vi.fn>).mockResolvedValue('# Hello');

      store.getState().fetchPluginReadme('test@m');

      // Wait for the async to resolve
      await vi.waitFor(() => {
        expect(store.getState().pluginReadmes['test@m']).toBe('# Hello');
      });
      expect(store.getState().pluginReadmeLoading['test@m']).toBe(false);
    });

    it('does not re-fetch cached README', () => {
      store.setState({ pluginReadmes: { 'test@m': 'cached' } });

      store.getState().fetchPluginReadme('test@m');

      expect(api.plugins!.getReadme).not.toHaveBeenCalled();
    });
  });

  describe('mcpBrowse', () => {
    it('fetches initial browse results', async () => {
      const servers = [makeMcpServer({ id: 's1' }), makeMcpServer({ id: 's2' })];
      (api.mcpRegistry!.browse as ReturnType<typeof vi.fn>).mockResolvedValue({
        servers,
        nextCursor: 'cursor-abc',
      });

      await store.getState().mcpBrowse();

      expect(store.getState().mcpBrowseCatalog).toHaveLength(2);
      expect(store.getState().mcpBrowseNextCursor).toBe('cursor-abc');
      expect(store.getState().mcpBrowseLoading).toBe(false);
    });

    it('appends on cursor-based pagination', async () => {
      store.setState({ mcpBrowseCatalog: [makeMcpServer({ id: 'existing' })] });
      const newServers = [makeMcpServer({ id: 'new1' })];
      (api.mcpRegistry!.browse as ReturnType<typeof vi.fn>).mockResolvedValue({
        servers: newServers,
        nextCursor: undefined,
      });

      await store.getState().mcpBrowse('cursor-1');

      expect(store.getState().mcpBrowseCatalog).toHaveLength(2);
      expect(store.getState().mcpBrowseNextCursor).toBeUndefined();
    });

    it('sets error on failure', async () => {
      (api.mcpRegistry!.browse as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));

      await store.getState().mcpBrowse();

      expect(store.getState().mcpBrowseError).toBe('fail');
      expect(store.getState().mcpBrowseLoading).toBe(false);
    });
  });

  describe('mcpFetchInstalled', () => {
    it('fetches installed MCP servers', async () => {
      const installed = [{ name: 'server-a', scope: 'user' as const }];
      (api.mcpRegistry!.getInstalled as ReturnType<typeof vi.fn>).mockResolvedValue(installed);

      await store.getState().mcpFetchInstalled();

      expect(store.getState().mcpInstalledServers).toEqual(installed);
    });
  });

  describe('openExtensionsTab', () => {
    it('opens a new extensions tab', () => {
      // Ensure we have a focused pane
      expect(store.getState().paneLayout.panes.length).toBeGreaterThan(0);

      store.getState().openExtensionsTab();

      const tabs = store.getState().paneLayout.panes.flatMap((p) => p.tabs);
      const extTab = tabs.find((t) => t.type === 'extensions');
      expect(extTab).toBeDefined();
      expect(extTab!.label).toBe('Extensions');
    });

    it('seeds projectId from activeProjectId when selectedProjectId is null', () => {
      store.setState({ selectedProjectId: null, activeProjectId: 'project-active' });

      store.getState().openExtensionsTab();

      const tabs = store.getState().paneLayout.panes.flatMap((p) => p.tabs);
      const extTab = tabs.find((t) => t.type === 'extensions');
      expect(extTab?.projectId).toBe('project-active');
    });

    it('activates existing extensions tab instead of creating new', () => {
      store.getState().openExtensionsTab();
      const tabs1 = store.getState().paneLayout.panes.flatMap((p) => p.tabs);
      const count1 = tabs1.filter((t) => t.type === 'extensions').length;

      store.getState().openExtensionsTab();
      const tabs2 = store.getState().paneLayout.panes.flatMap((p) => p.tabs);
      const count2 = tabs2.filter((t) => t.type === 'extensions').length;

      expect(count1).toBe(1);
      expect(count2).toBe(1); // no duplicate
    });
  });

  describe('installPlugin', () => {
    it('sets progress to pending then success', async () => {
      store.setState({
        cliStatus: {
          installed: true,
          installedVersion: '1.0.0',
          binaryPath: '/usr/local/bin/claude',
          latestVersion: '1.0.0',
          updateAvailable: false,
          authLoggedIn: true,
          authMethod: 'oauth_token',
        },
      });
      const plugins = [makePlugin({ pluginId: 'a@m' })];
      (api.plugins!.getAll as ReturnType<typeof vi.fn>).mockResolvedValue(plugins);
      (api.plugins!.install as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });

      const promise = store.getState().installPlugin({ pluginId: 'test@m', scope: 'user' });

      // During execution, should be pending
      expect(store.getState().pluginInstallProgress['test@m']).toBe('pending');

      await promise;
      expect(store.getState().pluginInstallProgress['test@m']).toBe('success');
    });

    it('sets progress to error on failure', async () => {
      store.setState({
        cliStatus: {
          installed: true,
          installedVersion: '1.0.0',
          binaryPath: '/usr/local/bin/claude',
          latestVersion: '1.0.0',
          updateAvailable: false,
          authLoggedIn: true,
          authMethod: 'oauth_token',
        },
      });
      (api.plugins!.install as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: 'error',
        error: 'Not found',
      });

      await store.getState().installPlugin({ pluginId: 'fail@m', scope: 'user' });

      expect(store.getState().pluginInstallProgress['fail@m']).toBe('error');
    });
  });

  describe('uninstallPlugin', () => {
    it('sets progress to pending then success', async () => {
      const plugins = [makePlugin({ pluginId: 'a@m', isInstalled: false })];
      (api.plugins!.getAll as ReturnType<typeof vi.fn>).mockResolvedValue(plugins);
      (api.plugins!.uninstall as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });

      const promise = store.getState().uninstallPlugin('test@m', 'user');

      expect(store.getState().pluginInstallProgress['test@m']).toBe('pending');

      await promise;
      expect(store.getState().pluginInstallProgress['test@m']).toBe('success');
    });
  });

  describe('installMcpServer', () => {
    it('sets progress to pending then success', async () => {
      (api.mcpRegistry!.install as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });
      (api.mcpRegistry!.getInstalled as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (api.mcpRegistry!.diagnose as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const promise = store.getState().installMcpServer({
        registryId: 'test-id',
        serverName: 'test-server',
        scope: 'user',
        envValues: {},
        headers: [],
      });

      expect(store.getState().mcpInstallProgress['test-id']).toBe('pending');

      await promise;
      expect(store.getState().mcpInstallProgress['test-id']).toBe('success');
    });
  });

  describe('uninstallMcpServer', () => {
    it('sets progress to pending then success', async () => {
      (api.mcpRegistry!.uninstall as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });
      (api.mcpRegistry!.getInstalled as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (api.mcpRegistry!.diagnose as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const promise = store.getState().uninstallMcpServer('test-id', 'test-server', 'user');

      expect(store.getState().mcpInstallProgress['test-id']).toBe('pending');

      await promise;
      expect(store.getState().mcpInstallProgress['test-id']).toBe('success');
    });
  });

  describe('skills state hardening', () => {
    it('ignores stale catalog responses for the same project key', async () => {
      let resolveFirst!: (value: SkillCatalogItem[]) => void;
      const firstPromise = new Promise<SkillCatalogItem[]>((resolve) => {
        resolveFirst = resolve;
      });
      const secondResult = [
        makeSkill({
          id: '/tmp/project/.claude/skills/newer',
          skillDir: '/tmp/project/.claude/skills/newer',
          skillFile: '/tmp/project/.claude/skills/newer/SKILL.md',
          scope: 'project',
          projectRoot: '/tmp/project',
          discoveryRoot: '/tmp/project/.claude/skills',
          name: 'Newer Skill',
        }),
      ];

      (api.skills!.list as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => firstPromise)
        .mockResolvedValueOnce(secondResult);

      const firstFetch = store.getState().fetchSkillsCatalog('/tmp/project');
      const secondFetch = store.getState().fetchSkillsCatalog('/tmp/project');

      await secondFetch;
      resolveFirst([
        makeSkill({
          id: '/tmp/project/.claude/skills/older',
          skillDir: '/tmp/project/.claude/skills/older',
          skillFile: '/tmp/project/.claude/skills/older/SKILL.md',
          scope: 'project',
          projectRoot: '/tmp/project',
          discoveryRoot: '/tmp/project/.claude/skills',
          name: 'Older Skill',
        }),
      ]);
      await firstFetch;

      expect(store.getState().skillsProjectCatalogByProjectPath['/tmp/project']).toEqual(
        secondResult
      );
    });

    it('keeps the previous detail cache when a detail fetch fails', async () => {
      const cachedDetail = makeSkillDetail();
      store.setState({
        skillsDetailsById: { [cachedDetail.item.id]: cachedDetail },
      });
      (api.skills!.getDetail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('detail fail'));

      await expect(
        store.getState().fetchSkillDetail(cachedDetail.item.id, '/tmp/project')
      ).rejects.toThrow('detail fail');

      expect(store.getState().skillsDetailsById[cachedDetail.item.id]).toEqual(cachedDetail);
      expect(store.getState().skillsDetailErrorById[cachedDetail.item.id]).toBe('detail fail');
    });
  });
});
