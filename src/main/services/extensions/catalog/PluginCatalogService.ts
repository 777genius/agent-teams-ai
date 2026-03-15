/**
 * Fetches and caches the Claude Code plugin marketplace catalog.
 *
 * - Fetches marketplace.json from raw.githubusercontent.com
 * - ETag + If-None-Match for bandwidth efficiency
 * - In-memory cache with TTL (15 min)
 * - Stale cache fallback on network error
 * - Deduplicates concurrent requests
 */

import https from 'node:https';
import http from 'node:http';

import { createLogger } from '@shared/utils/logger';
import type { PluginCatalogItem } from '@shared/types/extensions';
import { buildPluginId } from '@shared/utils/extensionNormalizers';

const logger = createLogger('Extensions:PluginCatalog');

// ── Constants ──────────────────────────────────────────────────────────────

const MARKETPLACE_URL =
  'https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json';

const CACHE_TTL_MS = 15 * 60 * 1_000; // 15 minutes
const HTTP_TIMEOUT_MS = 15_000; // 15 seconds
const MAX_REDIRECTS = 5;
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB safety limit
const MAX_README_CACHE_SIZE = 50; // Max README entries to cache

// ── HTTP helpers (adapted from CliInstallerService) ────────────────────────

interface FetchOptions {
  headers?: Record<string, string>;
}

interface FetchResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpsGetFollowRedirects(
  url: string,
  options: FetchOptions = {},
  redirectsLeft = MAX_REDIRECTS,
  timeoutMs = HTTP_TIMEOUT_MS
): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'http:' ? http : https;
    let settled = false;

    const settleResolve = (value: FetchResponse): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const reqOptions = {
      headers: options.headers ?? {},
    };

    const req = transport.get(url, reqOptions, (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          res.destroy();
          settleReject(new Error('Too many redirects'));
          return;
        }
        const redirectUrl = new URL(res.headers.location, url).toString();
        res.destroy();
        httpsGetFollowRedirects(redirectUrl, options, redirectsLeft - 1, timeoutMs).then(
          settleResolve,
          settleReject
        );
        return;
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      res.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          res.destroy(new Error(`Response body exceeds ${MAX_BODY_SIZE} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        settleResolve({
          statusCode: status,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks).toString('utf-8'),
        })
      );
      res.on('error', settleReject);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Connection timed out after ${timeoutMs}ms fetching ${url}`));
    });
    req.on('error', (err) => settleReject(err instanceof Error ? err : new Error(String(err))));
  });
}

// ── Marketplace JSON shape ─────────────────────────────────────────────────

interface MarketplaceJson {
  name: string;
  plugins: RawMarketplacePlugin[];
}

interface RawMarketplacePlugin {
  name: string;
  description?: string;
  version?: string;
  category?: string;
  author?: { name: string; email?: string };
  source: string | { source: string; url: string; sha?: string };
  strict?: boolean;
  lspServers?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  commands?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
}

// ── Cache ──────────────────────────────────────────────────────────────────

interface CatalogCache {
  items: PluginCatalogItem[];
  etag: string | null;
  fetchedAt: number;
}

// ── Service ────────────────────────────────────────────────────────────────

export class PluginCatalogService {
  private cache: CatalogCache | null = null;
  private fetchInFlight: Promise<PluginCatalogItem[]> | null = null;
  private readmeCache = new Map<string, { content: string | null; fetchedAt: number }>();

  /**
   * Get all plugins from the marketplace catalog.
   * Uses in-memory cache with ETag validation.
   */
  async getPlugins(forceRefresh = false): Promise<PluginCatalogItem[]> {
    // Return cached if fresh and not forcing
    if (!forceRefresh && this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.items;
    }

    // Deduplicate concurrent requests
    if (this.fetchInFlight) {
      return this.fetchInFlight;
    }

    this.fetchInFlight = this.fetchCatalog().finally(() => {
      this.fetchInFlight = null;
    });

    return this.fetchInFlight;
  }

  /**
   * Get README content for a plugin by its pluginId.
   * For external plugins (source is URL), fetches README from the GitHub repo.
   * Returns null for local/bundled plugins or on error.
   */
  async getPluginReadme(pluginId: string): Promise<string | null> {
    const cached = this.readmeCache.get(pluginId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.content;
    }

    // Need catalog to find the plugin's repo URL
    const plugins = await this.getPlugins();
    const plugin = plugins.find((p) => p.pluginId === pluginId);
    if (!plugin?.homepage) {
      this.setReadmeCache(pluginId, null);
      return null;
    }

    const readmeUrl = this.buildReadmeUrl(plugin.homepage);
    if (!readmeUrl) {
      this.setReadmeCache(pluginId, null);
      return null;
    }

    try {
      const response = await httpsGetFollowRedirects(readmeUrl);
      if (response.statusCode === 200) {
        this.setReadmeCache(pluginId, response.body);
        return response.body;
      }
      this.setReadmeCache(pluginId, null);
      return null;
    } catch (err) {
      logger.warn(`Failed to fetch README for ${pluginId}:`, err);
      this.setReadmeCache(pluginId, null);
      return null;
    }
  }

  /**
   * Look up a single plugin by pluginId from the cached catalog.
   * Used for main-side re-resolution during install.
   */
  async resolvePlugin(pluginId: string): Promise<PluginCatalogItem | null> {
    const plugins = await this.getPlugins();
    return plugins.find((p) => p.pluginId === pluginId) ?? null;
  }

  // ── Private ────────────────────────────────────────────────────────────

  /** Set readme cache with LRU eviction */
  private setReadmeCache(pluginId: string, content: string | null): void {
    // Evict oldest entries if at capacity
    if (this.readmeCache.size >= MAX_README_CACHE_SIZE && !this.readmeCache.has(pluginId)) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this.readmeCache) {
        if (entry.fetchedAt < oldestTime) {
          oldestTime = entry.fetchedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) this.readmeCache.delete(oldestKey);
    }
    this.readmeCache.set(pluginId, { content, fetchedAt: Date.now() });
  }

  private async fetchCatalog(): Promise<PluginCatalogItem[]> {
    const headers: Record<string, string> = {};
    if (this.cache?.etag) {
      headers['If-None-Match'] = this.cache.etag;
    }

    try {
      const response = await httpsGetFollowRedirects(MARKETPLACE_URL, { headers });

      // 304 Not Modified — cache is still valid
      if (response.statusCode === 304 && this.cache) {
        this.cache.fetchedAt = Date.now();
        logger.info('Marketplace catalog not modified (304)');
        return this.cache.items;
      }

      if (response.statusCode !== 200) {
        throw new Error(`HTTP ${response.statusCode} fetching marketplace`);
      }

      const json = JSON.parse(response.body) as MarketplaceJson;
      const items = this.parseMarketplace(json);
      const etag = (response.headers['etag'] as string) ?? null;

      this.cache = { items, etag, fetchedAt: Date.now() };
      logger.info(`Fetched ${items.length} plugins from marketplace "${json.name}"`);
      return items;
    } catch (err) {
      // Stale cache fallback
      if (this.cache) {
        logger.warn('Marketplace fetch failed, using stale cache:', err);
        return this.cache.items;
      }
      logger.error('Marketplace fetch failed with no cache:', err);
      throw err;
    }
  }

  private parseMarketplace(json: MarketplaceJson): PluginCatalogItem[] {
    const marketplaceName = json.name;

    return json.plugins.map((raw): PluginCatalogItem => {
      const qualifiedName = buildPluginId(raw.name, marketplaceName);
      const isExternal = typeof raw.source === 'object';
      const homepage = isExternal ? (raw.source as { url: string }).url : undefined;

      return {
        pluginId: qualifiedName,
        marketplaceId: qualifiedName,
        qualifiedName,
        name: raw.name,
        source: 'official',
        description: raw.description ?? '',
        category: raw.category ?? 'other',
        author: raw.author,
        version: raw.version,
        homepage: homepage?.replace(/\.git$/, ''),
        tags: undefined,
        hasLspServers: raw.lspServers != null && Object.keys(raw.lspServers).length > 0,
        hasMcpServers: raw.mcpServers != null && Object.keys(raw.mcpServers).length > 0,
        hasAgents: raw.agents != null && Object.keys(raw.agents).length > 0,
        hasCommands: raw.commands != null && Object.keys(raw.commands).length > 0,
        hasHooks: raw.hooks != null && Object.keys(raw.hooks).length > 0,
        isExternal,
      };
    });
  }

  /**
   * Build raw GitHub README URL from a GitHub repo URL.
   * e.g. https://github.com/org/repo → https://raw.githubusercontent.com/org/repo/main/README.md
   */
  private buildReadmeUrl(repoUrl: string): string | null {
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return null;
    const [, owner, repo] = match;
    return `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`;
  }
}
