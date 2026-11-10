import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginCatalogService } from '@main/services/extensions/catalog/PluginCatalogService';

// Read fixtures
import marketplaceFixture from '../../../fixtures/extensions/plugin-marketplace.json';

// ── Mock HTTP ──────────────────────────────────────────────────────────────

// We mock the http/https modules at the bottom level by mocking the service's
// internal fetch method. Instead, we'll test via the public API by mocking
// the global https/http modules.

vi.mock('node:https', () => ({
  default: { get: vi.fn() },
  get: vi.fn(),
}));

vi.mock('node:http', () => ({
  default: { get: vi.fn() },
  get: vi.fn(),
}));

import https from 'node:https';
import type { IncomingMessage } from 'node:http';

/**
 * Helper to mock https.get to return a fake response.
 */
function mockHttpsGet(
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  const mockGet = https.get as ReturnType<typeof vi.fn>;
  mockGet.mockImplementation((_url: string, _opts: unknown, callback: (res: IncomingMessage) => void) => {
    const res = {
      statusCode,
      headers,
      on: vi.fn((event: string, handler: (data?: Buffer) => void) => {
        if (event === 'data') handler(Buffer.from(body));
        if (event === 'end') handler();
        return res;
      }),
      destroy: vi.fn(),
    };
    callback(res as unknown as IncomingMessage);
    return {
      setTimeout: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn(),
    };
  });
}

describe('PluginCatalogService', () => {
  let service: PluginCatalogService;

  beforeEach(() => {
    service = new PluginCatalogService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getPlugins', () => {
    it('fetches and parses marketplace.json into PluginCatalogItem[]', async () => {
      mockHttpsGet(200, JSON.stringify(marketplaceFixture), { etag: '"abc123"' });

      const plugins = await service.getPlugins();

      expect(plugins.length).toBe(marketplaceFixture.plugins.length);
      expect(plugins[0].pluginId).toBe('typescript-lsp@claude-plugins-official');
      expect(plugins[0].qualifiedName).toBe('typescript-lsp@claude-plugins-official');
      expect(plugins[0].name).toBe('typescript-lsp');
      expect(plugins[0].description).toBe(
        'TypeScript/JavaScript language server for enhanced code intelligence',
      );
      expect(plugins[0].category).toBe('development');
      expect(plugins[0].hasLspServers).toBe(true);
      expect(plugins[0].hasMcpServers).toBe(false);
      expect(plugins[0].isExternal).toBe(false);
    });

    it('detects external plugins (source is object with URL)', async () => {
      mockHttpsGet(200, JSON.stringify(marketplaceFixture), {});

      const plugins = await service.getPlugins();
      const atlassian = plugins.find((p) => p.name === 'atlassian');

      expect(atlassian).toBeDefined();
      expect(atlassian!.isExternal).toBe(true);
      expect(atlassian!.homepage).toBe(
        'https://github.com/atlassian/atlassian-mcp-server',
      );
    });

    it('returns cached data within TTL', async () => {
      mockHttpsGet(200, JSON.stringify(marketplaceFixture), {});

      const first = await service.getPlugins();
      const second = await service.getPlugins();

      // Only one HTTP call
      expect(https.get).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
    });

    it('uses ETag for conditional requests after TTL expires', async () => {
      // First fetch
      mockHttpsGet(200, JSON.stringify(marketplaceFixture), { etag: '"v1"' });
      await service.getPlugins();

      // Expire TTL
      // Access private cache to force expiry
      const cacheField = (service as unknown as Record<string, { fetchedAt: number } | null>)['cache'];
      if (cacheField) cacheField.fetchedAt = 0;

      // Second fetch — 304 Not Modified
      mockHttpsGet(304, '', {});
      const plugins = await service.getPlugins();

      expect(plugins.length).toBe(marketplaceFixture.plugins.length);
    });

    it('falls back to stale cache on network error', async () => {
      // First: successful fetch
      mockHttpsGet(200, JSON.stringify(marketplaceFixture), {});
      await service.getPlugins();

      // Expire TTL
      const cacheField2 = (service as unknown as Record<string, { fetchedAt: number } | null>)['cache'];
      if (cacheField2) cacheField2.fetchedAt = 0;

      // Second: network error
      const mockGet = https.get as ReturnType<typeof vi.fn>;
      mockGet.mockImplementation((_url: string, _opts: unknown, _callback: unknown) => {
        return {
          setTimeout: vi.fn(),
          on: vi.fn((event: string, handler: (err: Error) => void) => {
            if (event === 'error') handler(new Error('Network error'));
          }),
          destroy: vi.fn(),
        };
      });

      const plugins = await service.getPlugins();
      expect(plugins.length).toBe(marketplaceFixture.plugins.length);
    });

    it('throws when no cache and network fails', async () => {
      const mockGet = https.get as ReturnType<typeof vi.fn>;
      mockGet.mockImplementation((_url: string, _opts: unknown, _callback: unknown) => {
        return {
          setTimeout: vi.fn(),
          on: vi.fn((event: string, handler: (err: Error) => void) => {
            if (event === 'error') handler(new Error('Network error'));
          }),
          destroy: vi.fn(),
        };
      });

      await expect(service.getPlugins()).rejects.toThrow('Network error');
    });

    it('deduplicates concurrent requests', async () => {
      mockHttpsGet(200, JSON.stringify(marketplaceFixture), {});

      const [a, b] = await Promise.all([service.getPlugins(), service.getPlugins()]);

      expect(https.get).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
    });
  });

  describe('resolvePlugin', () => {
    it('returns plugin by pluginId', async () => {
      mockHttpsGet(200, JSON.stringify(marketplaceFixture), {});

      const plugin = await service.resolvePlugin('typescript-lsp@claude-plugins-official');
      expect(plugin).toBeDefined();
      expect(plugin!.name).toBe('typescript-lsp');
    });

    it('returns null for unknown pluginId', async () => {
      mockHttpsGet(200, JSON.stringify(marketplaceFixture), {});

      const plugin = await service.resolvePlugin('nonexistent@marketplace');
      expect(plugin).toBeNull();
    });
  });
});
