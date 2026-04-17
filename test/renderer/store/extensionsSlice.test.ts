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
    apiKeys: {
      list: vi.fn(),
      save: vi.fn(),
      delete: vi.fn(),
      lookup: vi.fn(),
      getStorageStatus: vi.fn(),
    },
    cliInstaller: {
      getStatus: vi.fn(),
      getProviderStatus: vi.fn(),
      verifyProviderModels: vi.fn(),
      invalidateStatus: vi.fn(),
      onProgress: vi.fn(),
    },
  },
}));

import { api } from '../../../src/renderer/api';
import {
  getMcpDiagnosticKey,
  getMcpProjectStateKey,
  getMcpOperationKey,
  getPluginOperationKey,
} from '../../../src/shared/utils/extensionNormalizers';

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

const makeReadyCliStatus = () => ({
  flavor: 'claude' as const,
  displayName: 'Claude',
  supportsSelfUpdate: true,
  showVersionDetails: true,
  showBinaryPath: true,
  installed: true,
  installedVersion: '1.0.0',
  binaryPath: '/usr/local/bin/claude',
  latestVersion: '1.0.0',
  updateAvailable: false,
  authLoggedIn: true,
  authStatusChecking: false,
  authMethod: 'oauth_token' as const,
  providers: [],
});

const pluginOperationKey = (pluginId: string, scope: 'user' | 'project' | 'local' = 'user') =>
  getPluginOperationKey(pluginId, scope);
const mcpOperationKey = (
  registryId: string,
  scope: 'user' | 'project' | 'local' | 'global' = 'user',
  projectPath?: string
) => getMcpOperationKey(registryId, scope, projectPath);

describe('extensionsSlice', () => {
  let store: TestStore;

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
    (api.cliInstaller!.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(makeReadyCliStatus());
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it('clears stale catalog when a different project fetch fails', async () => {
      store.setState({
        pluginCatalog: [makePlugin({ pluginId: 'project-a@m' })],
        pluginCatalogProjectPath: '/tmp/project-a',
      });
      (api.plugins!.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

      await store.getState().fetchPluginCatalog('/tmp/project-b');

      expect(store.getState().pluginCatalog).toEqual([]);
      expect(store.getState().pluginCatalogProjectPath).toBe('/tmp/project-b');
      expect(store.getState().pluginCatalogError).toBe('boom');
    });

    it('clears plugin operation state when switching project context', async () => {
      store.setState({
        pluginCatalog: [makePlugin({ pluginId: 'project-a@m' })],
        pluginCatalogProjectPath: '/tmp/project-a',
        pluginInstallProgress: {
          [pluginOperationKey('project-a@m', 'project')]: 'error',
        },
        installErrors: {
          [pluginOperationKey('project-a@m', 'project')]: 'Install failed',
          'mcp-server': 'Keep me',
        },
      });
      (api.plugins!.getAll as ReturnType<typeof vi.fn>).mockResolvedValue([
        makePlugin({ pluginId: 'project-b@m' }),
      ]);

      await store.getState().fetchPluginCatalog('/tmp/project-b');

      expect(store.getState().pluginCatalogProjectPath).toBe('/tmp/project-b');
      expect(
        store.getState().pluginInstallProgress[pluginOperationKey('project-a@m', 'project')],
      ).toBeUndefined();
      expect(store.getState().installErrors[pluginOperationKey('project-a@m', 'project')]).toBeUndefined();
      expect(store.getState().installErrors['mcp-server']).toBe('Keep me');
    });

    it('dedups concurrent requests for the same project key', async () => {
      let resolveFetch!: (plugins: EnrichedPlugin[]) => void;
      const inFlight = new Promise<EnrichedPlugin[]>((resolve) => {
        resolveFetch = resolve;
      });
      (api.plugins!.getAll as ReturnType<typeof vi.fn>).mockImplementation(() => inFlight);

      const firstFetch = store.getState().fetchPluginCatalog('/tmp/project-a');
      const secondFetch = store.getState().fetchPluginCatalog('/tmp/project-a');

      expect(api.plugins!.getAll).toHaveBeenCalledTimes(1);

      resolveFetch([makePlugin({ pluginId: 'same@m' })]);
      await Promise.all([firstFetch, secondFetch]);

      expect(store.getState().pluginCatalogProjectPath).toBe('/tmp/project-a');
      expect(store.getState().pluginCatalog.map((plugin) => plugin.pluginId)).toEqual(['same@m']);
    });

    it('keeps the newest project catalog when project changes mid-flight', async () => {
      let resolveProjectA!: (plugins: EnrichedPlugin[]) => void;
      let resolveProjectB!: (plugins: EnrichedPlugin[]) => void;
      const projectAFetch = new Promise<EnrichedPlugin[]>((resolve) => {
        resolveProjectA = resolve;
      });
      const projectBFetch = new Promise<EnrichedPlugin[]>((resolve) => {
        resolveProjectB = resolve;
      });

      (api.plugins!.getAll as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => projectAFetch)
        .mockImplementationOnce(() => projectBFetch);

      const firstFetch = store.getState().fetchPluginCatalog('/tmp/project-a');
      const secondFetch = store.getState().fetchPluginCatalog('/tmp/project-b');

      expect(api.plugins!.getAll).toHaveBeenCalledTimes(2);

      resolveProjectB([makePlugin({ pluginId: 'project-b@m' })]);
      await secondFetch;

      expect(store.getState().pluginCatalogProjectPath).toBe('/tmp/project-b');
      expect(store.getState().pluginCatalog.map((plugin) => plugin.pluginId)).toEqual([
        'project-b@m',
      ]);

      resolveProjectA([makePlugin({ pluginId: 'project-a@m' })]);
      await firstFetch;

      expect(store.getState().pluginCatalogProjectPath).toBe('/tmp/project-b');
      expect(store.getState().pluginCatalog.map((plugin) => plugin.pluginId)).toEqual([
        'project-b@m',
      ]);
    });

    it('clears plugin operation state when a different project fetch fails', async () => {
      store.setState({
        pluginCatalog: [makePlugin({ pluginId: 'project-a@m' })],
        pluginCatalogProjectPath: '/tmp/project-a',
        pluginInstallProgress: {
          [pluginOperationKey('project-a@m', 'project')]: 'error',
        },
        installErrors: {
          [pluginOperationKey('project-a@m', 'project')]: 'Install failed',
          'mcp-server': 'Keep me',
        },
      });
      (api.plugins!.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

      await store.getState().fetchPluginCatalog('/tmp/project-b');

      expect(store.getState().pluginCatalog).toEqual([]);
      expect(
        store.getState().pluginInstallProgress[pluginOperationKey('project-a@m', 'project')],
      ).toBeUndefined();
      expect(store.getState().installErrors[pluginOperationKey('project-a@m', 'project')]).toBeUndefined();
      expect(store.getState().installErrors['mcp-server']).toBe('Keep me');
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

    it('retries README fetch when the cached value is null', () => {
      store.setState({ pluginReadmes: { 'test@m': null } });
      (api.plugins!.getReadme as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      store.getState().fetchPluginReadme('test@m');

      expect(api.plugins!.getReadme).toHaveBeenCalledWith('test@m');
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

    it('stores installed MCP servers independently per project context', async () => {
      (api.mcpRegistry!.getInstalled as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ name: 'global-server', scope: 'global' as const }])
        .mockResolvedValueOnce([{ name: 'project-server', scope: 'project' as const }]);

      await store.getState().mcpFetchInstalled();
      await store.getState().mcpFetchInstalled('/tmp/project-a');

      expect(store.getState().mcpInstalledServersByProjectPath).toMatchObject({
        [getMcpProjectStateKey()]: [{ name: 'global-server', scope: 'global' }],
        [getMcpProjectStateKey('/tmp/project-a')]: [{ name: 'project-server', scope: 'project' }],
      });
    });

    it('clears stale project- and local-scoped MCP operation state when project changes', async () => {
      store.setState({
        mcpInstalledProjectPath: '/tmp/project-a',
        mcpInstallProgress: {
          [mcpOperationKey('project-server', 'project', '/tmp/project-a')]: 'error',
          [mcpOperationKey('local-server', 'local', '/tmp/project-a')]: 'success',
          [mcpOperationKey('user-server', 'user')]: 'pending',
        },
        installErrors: {
          [mcpOperationKey('project-server', 'project', '/tmp/project-a')]: 'Project failed',
          [mcpOperationKey('local-server', 'local', '/tmp/project-a')]: 'Local failed',
          [mcpOperationKey('user-server', 'user')]: 'Keep user state',
          'plugin:test@marketplace:user': 'Keep plugin state',
          'mcp-custom:custom-server:project:/tmp/project-a': 'Clear custom project state',
        },
      });
      (api.mcpRegistry!.getInstalled as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await store.getState().mcpFetchInstalled('/tmp/project-b');

      expect(store.getState().mcpInstalledProjectPath).toBe('/tmp/project-b');
      expect(
        store.getState().mcpInstallProgress[mcpOperationKey('project-server', 'project', '/tmp/project-a')]
      ).toBeUndefined();
      expect(
        store.getState().mcpInstallProgress[mcpOperationKey('local-server', 'local', '/tmp/project-a')]
      ).toBeUndefined();
      expect(store.getState().mcpInstallProgress[mcpOperationKey('user-server', 'user')]).toBe(
        'pending',
      );
      expect(
        store.getState().installErrors[mcpOperationKey('project-server', 'project', '/tmp/project-a')]
      ).toBeUndefined();
      expect(
        store.getState().installErrors[mcpOperationKey('local-server', 'local', '/tmp/project-a')]
      ).toBeUndefined();
      expect(store.getState().installErrors[mcpOperationKey('user-server', 'user')]).toBe(
        'Keep user state',
      );
      expect(store.getState().installErrors['mcp-custom:custom-server:project']).toBeUndefined();
      expect(store.getState().installErrors['plugin:test@marketplace:user']).toBe(
        'Keep plugin state',
      );
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

    it('updates projectId on existing tab when selected project changes', () => {
      // Open Extensions with project-A
      store.setState({ selectedProjectId: 'project-A', activeProjectId: null });
      store.getState().openExtensionsTab();

      const tabsBefore = store.getState().paneLayout.panes.flatMap((p) => p.tabs);
      const extTabBefore = tabsBefore.find((t) => t.type === 'extensions');
      expect(extTabBefore?.projectId).toBe('project-A');

      // Switch to project-B and reopen Extensions
      store.setState({ selectedProjectId: 'project-B' });
      store.getState().openExtensionsTab();

      const tabsAfter = store.getState().paneLayout.panes.flatMap((p) => p.tabs);
      const extTabAfter = tabsAfter.find((t) => t.type === 'extensions');
      expect(extTabAfter?.projectId).toBe('project-B');
      // Still only one extensions tab
      expect(tabsAfter.filter((t) => t.type === 'extensions')).toHaveLength(1);
    });

    it('does not update projectId when it already matches', () => {
      store.setState({ selectedProjectId: 'project-A', activeProjectId: null });
      store.getState().openExtensionsTab();

      const layoutBefore = store.getState().paneLayout;

      // Reopen with same project — layout should be referentially stable (no set() call)
      store.getState().openExtensionsTab();

      const tabsBefore = layoutBefore.panes.flatMap((p) => p.tabs);
      const tabsAfter = store.getState().paneLayout.panes.flatMap((p) => p.tabs);
      const extBefore = tabsBefore.find((t) => t.type === 'extensions');
      const extAfter = tabsAfter.find((t) => t.type === 'extensions');
      expect(extAfter?.projectId).toBe(extBefore?.projectId);
    });
  });

  describe('installPlugin', () => {
    it('sets progress to pending then success', async () => {
      store.setState({ cliStatus: makeReadyCliStatus() });
      const plugins = [makePlugin({ pluginId: 'a@m' })];
      (api.plugins!.getAll as ReturnType<typeof vi.fn>).mockResolvedValue(plugins);
      (api.plugins!.install as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });

      const promise = store.getState().installPlugin({ pluginId: 'test@m', scope: 'user' });

      // During execution, should be pending
      expect(store.getState().pluginInstallProgress[pluginOperationKey('test@m')]).toBe('pending');

      await promise;
      expect(store.getState().pluginInstallProgress[pluginOperationKey('test@m')]).toBe('success');
    });

    it('sets progress to error on failure', async () => {
      store.setState({ cliStatus: makeReadyCliStatus() });
      (api.plugins!.install as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: 'error',
        error: 'Not found',
      });

      await store.getState().installPlugin({ pluginId: 'fail@m', scope: 'user' });

      expect(store.getState().pluginInstallProgress[pluginOperationKey('fail@m')]).toBe('error');
    });

    it('fills missing projectPath from the active Extensions project context', async () => {
      store.setState({
        cliStatus: makeReadyCliStatus(),
        pluginCatalogProjectPath: '/tmp/project-a',
      });
      (api.plugins!.install as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });

      await store.getState().installPlugin({ pluginId: 'project@m', scope: 'project' });

      expect(api.plugins!.install).toHaveBeenCalledWith({
        pluginId: 'project@m',
        scope: 'project',
        projectPath: '/tmp/project-a',
      });
    });

    it('fails fast for project scope when there is no active project path', async () => {
      store.setState({ cliStatus: makeReadyCliStatus(), pluginCatalogProjectPath: null });

      await store.getState().installPlugin({ pluginId: 'project@m', scope: 'project' });

      expect(api.plugins!.install).not.toHaveBeenCalled();
      expect(store.getState().pluginInstallProgress[pluginOperationKey('project@m', 'project')]).toBe(
        'error',
      );
      expect(store.getState().installErrors[pluginOperationKey('project@m', 'project')]).toContain(
        'active project',
      );
    });

    it('fills missing projectPath for local scope from the active Extensions project context', async () => {
      store.setState({
        cliStatus: makeReadyCliStatus(),
        pluginCatalogProjectPath: '/tmp/project-a',
      });
      (api.plugins!.install as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });

      await store.getState().installPlugin({ pluginId: 'local@m', scope: 'local' });

      expect(api.plugins!.install).toHaveBeenCalledWith({
        pluginId: 'local@m',
        scope: 'local',
        projectPath: '/tmp/project-a',
      });
    });

    it('fails fast for local scope when there is no active project path', async () => {
      store.setState({ cliStatus: makeReadyCliStatus(), pluginCatalogProjectPath: null });

      await store.getState().installPlugin({ pluginId: 'local@m', scope: 'local' });

      expect(api.plugins!.install).not.toHaveBeenCalled();
      expect(store.getState().pluginInstallProgress[pluginOperationKey('local@m', 'local')]).toBe(
        'error',
      );
      expect(store.getState().installErrors[pluginOperationKey('local@m', 'local')]).toContain(
        'active project',
      );
    });

    it('keeps user-scope state isolated from local-scope failures', async () => {
      store.setState({ cliStatus: makeReadyCliStatus(), pluginCatalogProjectPath: null });

      await store.getState().installPlugin({ pluginId: 'shared@m', scope: 'local' });

      expect(store.getState().pluginInstallProgress[pluginOperationKey('shared@m', 'local')]).toBe(
        'error',
      );
      expect(store.getState().pluginInstallProgress[pluginOperationKey('shared@m', 'user')]).toBeUndefined();
      expect(store.getState().installErrors[pluginOperationKey('shared@m', 'user')]).toBeUndefined();
    });

    it('clears older success reset timers before a new operation on the same plugin', async () => {
      vi.useFakeTimers();
      store.setState({ cliStatus: makeReadyCliStatus() });
      (api.plugins!.getAll as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (api.plugins!.install as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ state: 'success' })
        .mockResolvedValueOnce({ state: 'error', error: 'second failure' });

      await store.getState().installPlugin({ pluginId: 'test@m', scope: 'user' });
      expect(store.getState().pluginInstallProgress[pluginOperationKey('test@m')]).toBe('success');

      await store.getState().installPlugin({ pluginId: 'test@m', scope: 'user' });
      expect(store.getState().pluginInstallProgress[pluginOperationKey('test@m')]).toBe('error');

      await vi.advanceTimersByTimeAsync(2_000);

      expect(store.getState().pluginInstallProgress[pluginOperationKey('test@m')]).toBe('error');
    });
  });

  describe('uninstallPlugin', () => {
    it('sets progress to pending then success', async () => {
      const plugins = [makePlugin({ pluginId: 'a@m', isInstalled: false })];
      (api.plugins!.getAll as ReturnType<typeof vi.fn>).mockResolvedValue(plugins);
      (api.plugins!.uninstall as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });

      const promise = store.getState().uninstallPlugin('test@m', 'user');

      expect(store.getState().pluginInstallProgress[pluginOperationKey('test@m')]).toBe('pending');

      await promise;
      expect(store.getState().pluginInstallProgress[pluginOperationKey('test@m')]).toBe('success');
    });

    it('fills missing projectPath from the active Extensions project context', async () => {
      store.setState({ pluginCatalogProjectPath: '/tmp/project-a' });
      (api.plugins!.uninstall as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });

      await store.getState().uninstallPlugin('project@m', 'project');

      expect(api.plugins!.uninstall).toHaveBeenCalledWith('project@m', 'project', '/tmp/project-a');
    });

    it('fails fast for project uninstall when there is no active project path', async () => {
      store.setState({ pluginCatalogProjectPath: null });

      await store.getState().uninstallPlugin('project@m', 'project');

      expect(api.plugins!.uninstall).not.toHaveBeenCalled();
      expect(store.getState().pluginInstallProgress[pluginOperationKey('project@m', 'project')]).toBe(
        'error',
      );
      expect(store.getState().installErrors[pluginOperationKey('project@m', 'project')]).toContain(
        'active project',
      );
    });

    it('fills missing projectPath for local uninstall from the active Extensions project context', async () => {
      store.setState({ pluginCatalogProjectPath: '/tmp/project-a' });
      (api.plugins!.uninstall as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });

      await store.getState().uninstallPlugin('local@m', 'local');

      expect(api.plugins!.uninstall).toHaveBeenCalledWith('local@m', 'local', '/tmp/project-a');
    });

    it('fails fast for local uninstall when there is no active project path', async () => {
      store.setState({ pluginCatalogProjectPath: null });

      await store.getState().uninstallPlugin('local@m', 'local');

      expect(api.plugins!.uninstall).not.toHaveBeenCalled();
      expect(store.getState().pluginInstallProgress[pluginOperationKey('local@m', 'local')]).toBe(
        'error',
      );
      expect(store.getState().installErrors[pluginOperationKey('local@m', 'local')]).toContain(
        'active project',
      );
    });

    it('does not restore idle state after project switch clears a pending success timer', async () => {
      vi.useFakeTimers();
      store.setState({
        pluginCatalogProjectPath: '/tmp/project-a',
        pluginCatalog: [makePlugin({ pluginId: 'test@m' })],
      });
      (api.plugins!.getAll as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([makePlugin({ pluginId: 'test@m' })])
        .mockResolvedValueOnce([makePlugin({ pluginId: 'other@m' })]);
      (api.plugins!.uninstall as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });

      await store.getState().uninstallPlugin('test@m', 'user');
      expect(store.getState().pluginInstallProgress[pluginOperationKey('test@m')]).toBe('success');

      await store.getState().fetchPluginCatalog('/tmp/project-b');
      expect(store.getState().pluginInstallProgress[pluginOperationKey('test@m')]).toBeUndefined();

      await vi.advanceTimersByTimeAsync(2_000);

      expect(store.getState().pluginInstallProgress[pluginOperationKey('test@m')]).toBeUndefined();
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

      expect(store.getState().mcpInstallProgress[mcpOperationKey('test-id', 'user')]).toBe(
        'pending',
      );

      await promise;
      expect(store.getState().mcpInstallProgress[mcpOperationKey('test-id', 'user')]).toBe(
        'success',
      );
    });

    it('does not restore idle state after project switch clears a pending project-scope success timer', async () => {
      vi.useFakeTimers();
      store.setState({
        mcpInstalledProjectPath: '/tmp/project-a',
      });
      (api.mcpRegistry!.install as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });
      (api.mcpRegistry!.getInstalled as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (api.mcpRegistry!.diagnose as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await store.getState().installMcpServer({
        registryId: 'test-id',
        serverName: 'test-server',
        scope: 'project',
        projectPath: '/tmp/project-a',
        envValues: {},
        headers: [],
      });

      expect(
        store.getState().mcpInstallProgress[mcpOperationKey('test-id', 'project', '/tmp/project-a')]
      ).toBe('success');

      await store.getState().mcpFetchInstalled('/tmp/project-b');
      expect(
        store.getState().mcpInstallProgress[mcpOperationKey('test-id', 'project', '/tmp/project-a')]
      ).toBeUndefined();

      await vi.advanceTimersByTimeAsync(2_000);

      expect(
        store.getState().mcpInstallProgress[mcpOperationKey('test-id', 'project', '/tmp/project-a')]
      ).toBeUndefined();
    });
  });

  describe('uninstallMcpServer', () => {
    it('sets progress to pending then success', async () => {
      (api.mcpRegistry!.uninstall as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });
      (api.mcpRegistry!.getInstalled as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (api.mcpRegistry!.diagnose as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const promise = store.getState().uninstallMcpServer('test-id', 'test-server', 'user');

      expect(store.getState().mcpInstallProgress[mcpOperationKey('test-id', 'user')]).toBe(
        'pending',
      );

      await promise;
      expect(store.getState().mcpInstallProgress[mcpOperationKey('test-id', 'user')]).toBe(
        'success',
      );
    });
  });

  describe('provider-aware runtime refresh', () => {
    it('passes projectPath through MCP diagnostics', async () => {
      (api.mcpRegistry!.diagnose as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await store.getState().runMcpDiagnostics('/tmp/project-a');

      expect(api.mcpRegistry!.diagnose).toHaveBeenCalledWith('/tmp/project-a');
    });

    it('refreshes CLI status after saving an API key', async () => {
      (api.apiKeys!.save as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'k1' });
      (api.apiKeys!.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'k1',
          name: 'Codex key',
          envVarName: 'OPENAI_API_KEY',
          maskedValue: '***',
          scope: 'user',
          createdAt: '2026-04-17T10:00:00.000Z',
        },
      ]);

      await store.getState().saveApiKey({
        name: 'Codex key',
        envVarName: 'OPENAI_API_KEY',
        value: 'secret',
        scope: 'user',
      });

      expect(api.cliInstaller!.getStatus).toHaveBeenCalled();
      expect(store.getState().apiKeys).toHaveLength(1);
    });

    it('refreshes CLI status after deleting an API key', async () => {
      store.setState({
        apiKeys: [
          {
            id: 'k1',
            name: 'Codex key',
            envVarName: 'OPENAI_API_KEY',
            maskedValue: '***',
            scope: 'user',
            createdAt: '2026-04-17T10:00:00.000Z',
          },
        ],
      });
      (api.apiKeys!.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await store.getState().deleteApiKey('k1');

      expect(api.cliInstaller!.getStatus).toHaveBeenCalled();
      expect(store.getState().apiKeys).toEqual([]);
    });

    it('keys MCP diagnostics by scope when the same server exists in multiple scopes', async () => {
      (api.mcpRegistry!.diagnose as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          name: 'context7',
          scope: 'global',
          target: 'npx -y @upstash/context7-mcp',
          status: 'connected',
          statusLabel: 'Connected',
          rawLine: 'context7: npx -y @upstash/context7-mcp - Connected',
          checkedAt: 1,
        },
        {
          name: 'context7',
          scope: 'project',
          target: 'uvx context7-project',
          status: 'failed',
          statusLabel: 'Failed to connect',
          rawLine: 'context7: uvx context7-project - Failed to connect',
          checkedAt: 1,
        },
      ]);

      await store.getState().runMcpDiagnostics('/tmp/project-a');

      expect(store.getState().mcpDiagnostics).toMatchObject({
        [getMcpDiagnosticKey('context7', 'global')]: expect.objectContaining({
          target: 'npx -y @upstash/context7-mcp',
        }),
        [getMcpDiagnosticKey('context7', 'project')]: expect.objectContaining({
          target: 'uvx context7-project',
        }),
      });
    });

    it('stores MCP diagnostics independently per project context', async () => {
      (api.mcpRegistry!.diagnose as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          {
            name: 'global-server',
            scope: 'global',
            target: 'npx global-server',
            status: 'connected',
            statusLabel: 'Connected',
            rawLine: 'global-server: npx global-server - Connected',
            checkedAt: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            name: 'project-server',
            scope: 'project',
            target: 'uvx project-server',
            status: 'failed',
            statusLabel: 'Failed to connect',
            rawLine: 'project-server: uvx project-server - Failed to connect',
            checkedAt: 2,
          },
        ]);

      await store.getState().runMcpDiagnostics();
      await store.getState().runMcpDiagnostics('/tmp/project-a');

      expect(store.getState().mcpDiagnosticsByProjectPath).toMatchObject({
        [getMcpProjectStateKey()]: {
          [getMcpDiagnosticKey('global-server', 'global')]: expect.objectContaining({
            target: 'npx global-server',
          }),
        },
        [getMcpProjectStateKey('/tmp/project-a')]: {
          [getMcpDiagnosticKey('project-server', 'project')]: expect.objectContaining({
            target: 'uvx project-server',
          }),
        },
      });
    });

    it('refreshes MCP install state using the operation project context instead of the last viewed tab', async () => {
      store.setState({
        mcpInstalledProjectPath: '/tmp/project-b',
      });
      (api.mcpRegistry!.install as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'success' });
      (api.mcpRegistry!.getInstalled as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (api.mcpRegistry!.diagnose as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await store.getState().installMcpServer({
        registryId: 'test-id',
        serverName: 'test-server',
        scope: 'project',
        projectPath: '/tmp/project-a',
        envValues: {},
        headers: [],
      });

      expect(api.mcpRegistry!.getInstalled).toHaveBeenLastCalledWith('/tmp/project-a');
      expect(api.mcpRegistry!.diagnose).toHaveBeenLastCalledWith('/tmp/project-a');
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
