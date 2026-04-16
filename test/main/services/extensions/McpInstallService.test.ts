import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpInstallService } from '@main/services/extensions/install/McpInstallService';

import type { McpCatalogAggregator } from '@main/services/extensions/catalog/McpCatalogAggregator';
import type { McpCatalogItem } from '@shared/types/extensions';

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

// ── Mock aggregator ──────────────────────────────────────────────────────────

function makeStdioServer(): McpCatalogItem {
  return {
    id: 'upstash/context7-mcp',
    name: 'Context7 MCP',
    description: 'Context-aware MCP server',
    source: 'official',
    installSpec: {
      type: 'stdio',
      npmPackage: '@upstash/context7-mcp',
      npmVersion: '1.0.0',
    },
    envVars: [{ name: 'UPSTASH_API_KEY', isSecret: true }],
    tools: [],
    requiresAuth: false,
  };
}

function makeHttpServer(): McpCatalogItem {
  return {
    id: 'example/http-server',
    name: 'Example HTTP',
    description: 'HTTP MCP server',
    source: 'official',
    installSpec: {
      type: 'http',
      url: 'https://mcp.example.com/sse',
      transportType: 'sse',
    },
    envVars: [],
    tools: [],
    requiresAuth: true,
  };
}

function createMockAggregator(
  getByIdResult: McpCatalogItem | null = makeStdioServer(),
): McpCatalogAggregator {
  return {
    search: vi.fn(),
    browse: vi.fn(),
    getById: vi.fn().mockResolvedValue(getByIdResult),
  } as unknown as McpCatalogAggregator;
}

describe('McpInstallService', () => {
  let service: McpInstallService;
  let aggregator: McpCatalogAggregator;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/usr/local/bin/claude');
    aggregator = createMockAggregator();
    service = new McpInstallService(aggregator);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── install: stdio ──────────────────────────────────────────────────────────

  describe('install (stdio)', () => {
    it('builds correct CLI args for stdio server', async () => {
      mockExecCli.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await service.install({
        registryId: 'upstash/context7-mcp',
        serverName: 'context7',
        scope: 'user',
        envValues: { UPSTASH_API_KEY: 'test-key-123' },
        headers: [],
      });

      expect(result.state).toBe('success');
      expect(mockExecCli).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'add', '-s', 'user', '-e', 'UPSTASH_API_KEY=test-key-123', 'context7', '--', 'npx', '-y', '@upstash/context7-mcp@1.0.0'],
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('adds scope flag for project scope', async () => {
      mockExecCli.mockResolvedValue({ stdout: '', stderr: '' });

      await service.install({
        registryId: 'upstash/context7-mcp',
        serverName: 'context7',
        scope: 'project',
        projectPath: '/tmp/test',
        envValues: {},
        headers: [],
      });

      const args = mockExecCli.mock.calls[0]?.[1];
      expect(args).toContain('-s');
      expect(args).toContain('project');
    });

    it('does NOT add scope flag for local scope (default)', async () => {
      mockExecCli.mockResolvedValue({ stdout: '', stderr: '' });

      await service.install({
        registryId: 'upstash/context7-mcp',
        serverName: 'context7',
        scope: 'local',
        envValues: {},
        headers: [],
      });

      const args = mockExecCli.mock.calls[0]?.[1];
      expect(args).not.toContain('-s');
    });
  });

  // ── install: http ───────────────────────────────────────────────────────────

  describe('install (http)', () => {
    it('builds correct CLI args for HTTP server', async () => {
      aggregator = createMockAggregator(makeHttpServer());
      service = new McpInstallService(aggregator);
      mockExecCli.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await service.install({
        registryId: 'example/http-server',
        serverName: 'example-http',
        scope: 'user',
        envValues: {},
        headers: [{ key: 'Authorization', value: 'Bearer token123' }],
      });

      expect(result.state).toBe('success');
      expect(mockExecCli).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'add', '-s', 'user', '-t', 'sse', '-H', 'Authorization: Bearer token123', 'example-http', 'https://mcp.example.com/sse'],
        expect.objectContaining({ timeout: 30_000 }),
      );
    });
  });

  // ── install: validation ─────────────────────────────────────────────────────

  describe('install (validation)', () => {
    it('rejects invalid server name', async () => {
      const result = await service.install({
        registryId: 'test',
        serverName: '../etc/passwd',
        scope: 'user',
        envValues: {},
        headers: [],
      });

      expect(result.state).toBe('error');
      expect(result.error).toContain('Invalid server name');
      expect(mockExecCli).not.toHaveBeenCalled();
    });

    it('returns error if server not found in registry', async () => {
      aggregator = createMockAggregator(null);
      service = new McpInstallService(aggregator);

      const result = await service.install({
        registryId: 'nonexistent',
        serverName: 'test',
        scope: 'user',
        envValues: {},
        headers: [],
      });

      expect(result.state).toBe('error');
      expect(result.error).toContain('not found in registry');
    });

    it('returns error if server has no installSpec', async () => {
      const serverNoSpec: McpCatalogItem = {
        ...makeStdioServer(),
        installSpec: null,
      };
      aggregator = createMockAggregator(serverNoSpec);
      service = new McpInstallService(aggregator);

      const result = await service.install({
        registryId: 'test',
        serverName: 'test',
        scope: 'user',
        envValues: {},
        headers: [],
      });

      expect(result.state).toBe('error');
      expect(result.error).toContain('Manual setup required');
    });

    it('rejects project scope install without project path', async () => {
      const result = await service.install({
        registryId: 'upstash/context7-mcp',
        serverName: 'context7',
        scope: 'project',
        envValues: {},
        headers: [],
      });

      expect(result.state).toBe('error');
      expect(result.error).toContain('projectPath is required');
      expect(mockExecCli).not.toHaveBeenCalled();
    });
  });

  // ── install: error masking ──────────────────────────────────────────────────

  describe('install (secret masking)', () => {
    it('masks env values in error messages', async () => {
      mockExecCli.mockRejectedValue(
        new Error('Command failed: UPSTASH_API_KEY=super-secret-key-12345'),
      );

      const result = await service.install({
        registryId: 'test',
        serverName: 'context7',
        scope: 'user',
        envValues: { UPSTASH_API_KEY: 'super-secret-key-12345' },
        headers: [],
      });

      expect(result.state).toBe('error');
      expect(result.error).not.toContain('super-secret-key-12345');
      expect(result.error).toContain('[REDACTED]');
    });

    it('masks header values in error messages', async () => {
      aggregator = createMockAggregator(makeHttpServer());
      service = new McpInstallService(aggregator);
      mockExecCli.mockRejectedValue(
        new Error('Auth failed with Bearer my-token-value'),
      );

      const result = await service.install({
        registryId: 'test',
        serverName: 'example',
        scope: 'user',
        envValues: {},
        headers: [{ key: 'Authorization', value: 'Bearer my-token-value' }],
      });

      expect(result.state).toBe('error');
      expect(result.error).not.toContain('Bearer my-token-value');
    });
  });

  describe('installCustom (validation)', () => {
    it('rejects project scope custom install without project path', async () => {
      const result = await service.installCustom({
        serverName: 'custom-context7',
        scope: 'project',
        installSpec: {
          type: 'stdio',
          npmPackage: '@upstash/context7-mcp',
        },
        envValues: {},
        headers: [],
      });

      expect(result.state).toBe('error');
      expect(result.error).toContain('projectPath is required');
      expect(mockExecCli).not.toHaveBeenCalled();
    });
  });

  // ── uninstall ───────────────────────────────────────────────────────────────

  describe('uninstall', () => {
    it('builds correct CLI args', async () => {
      mockExecCli.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await service.uninstall('context7');

      expect(result.state).toBe('success');
      expect(mockExecCli).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['mcp', 'remove', 'context7'],
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('adds scope flag for user scope', async () => {
      mockExecCli.mockResolvedValue({ stdout: '', stderr: '' });

      await service.uninstall('context7', 'user');

      const args = mockExecCli.mock.calls[0]?.[1];
      expect(args).toContain('-s');
      expect(args).toContain('user');
    });

    it('rejects invalid server name', async () => {
      const result = await service.uninstall('$(rm -rf /)');

      expect(result.state).toBe('error');
      expect(result.error).toContain('Invalid server name');
      expect(mockExecCli).not.toHaveBeenCalled();
    });

    it('rejects project scope uninstall without project path', async () => {
      const result = await service.uninstall('context7', 'project');

      expect(result.state).toBe('error');
      expect(result.error).toContain('projectPath is required');
      expect(mockExecCli).not.toHaveBeenCalled();
    });

    it('returns error on CLI failure', async () => {
      mockExecCli.mockRejectedValue(new Error('Not found'));

      const result = await service.uninstall('context7');

      expect(result.state).toBe('error');
      expect(result.error).toContain('Not found');
    });
  });
});
