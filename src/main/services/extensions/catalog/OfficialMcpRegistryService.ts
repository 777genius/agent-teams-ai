/**
 * Fetches and normalizes MCP servers from the Official MCP Registry.
 *
 * Base URL: https://registry.modelcontextprotocol.io/v0.1/servers
 * Cursor-based pagination, no auth required.
 * Filters for _meta.isLatest to pick only latest versions.
 */

import http from 'node:http';
import https from 'node:https';

import { createLogger } from '@shared/utils/logger';

import type {
  McpAuthHeaderDef,
  McpCatalogItem,
  McpEnvVarDef,
  McpInstallSpec,
} from '@shared/types/extensions';

const logger = createLogger('Extensions:OfficialMcpRegistry');

// ── Constants ──────────────────────────────────────────────────────────────

const REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const HTTP_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 15 * 60_000; // 15 minutes
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB safety limit

// ── HTTP helper ────────────────────────────────────────────────────────────

function httpGet(
  url: string,
  redirectsLeft = MAX_REDIRECTS
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'http:' ? http : https;
    let settled = false;

    const settleResolve = (v: { statusCode: number; body: string }): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const settleReject = (e: Error): void => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };

    const req = transport.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          res.destroy();
          settleReject(new Error('Too many redirects'));
          return;
        }
        const redirectUrl = new URL(res.headers.location, url).toString();
        res.destroy();
        httpGet(redirectUrl, redirectsLeft - 1).then(settleResolve, settleReject);
        return;
      }
      const chunks: Buffer[] = [];
      let totalSize = 0;
      res.on('data', (c: Buffer) => {
        totalSize += c.length;
        if (totalSize > MAX_BODY_SIZE) {
          res.destroy(new Error(`Response body exceeds ${MAX_BODY_SIZE} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () =>
        settleResolve({ statusCode: status, body: Buffer.concat(chunks).toString('utf-8') })
      );
      res.on('error', settleReject);
    });
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error(`Timeout fetching ${url}`)));
    req.on('error', (e) => settleReject(e instanceof Error ? e : new Error(String(e))));
  });
}

// ── Raw API response shapes ────────────────────────────────────────────────

interface RegistryResponse {
  servers: RegistryServerEntry[];
  metadata: { nextCursor?: string; count?: number };
}

interface RegistryIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
}

interface RegistryServerEntry {
  server: {
    name: string;
    description?: string;
    title?: string;
    version?: string;
    repository?: { url: string; source?: string };
    websiteUrl?: string;
    packages?: RegistryPackage[];
    remotes?: RegistryRemote[];
    icons?: RegistryIcon[];
  };
  _meta?: {
    'io.modelcontextprotocol.registry/official'?: {
      status?: string;
      isLatest?: boolean;
      publishedAt?: string;
      updatedAt?: string;
    };
  };
}

interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  transport?: { type: string };
  environmentVariables?: RegistryEnvVar[];
}

interface RegistryRemote {
  type: string;
  url: string;
  headers?: RegistryHeader[];
}

interface RegistryHeader {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  value?: string;
}

interface RegistryEnvVar {
  name: string;
  description?: string;
  isSecret?: boolean;
  isRequired?: boolean;
}

// ── Cache ──────────────────────────────────────────────────────────────────

interface SearchCache {
  key: string;
  result: McpCatalogItem[];
  fetchedAt: number;
}

// ── Service ────────────────────────────────────────────────────────────────

export class OfficialMcpRegistryService {
  private searchCache: SearchCache | null = null;

  /**
   * Search the official registry by query text.
   */
  async search(query: string, limit = 20): Promise<McpCatalogItem[]> {
    const cacheKey = `search:${query}:${limit}`;
    if (
      this.searchCache?.key === cacheKey &&
      Date.now() - this.searchCache.fetchedAt < CACHE_TTL_MS
    ) {
      return this.searchCache.result;
    }

    const params = new URLSearchParams({ search: query, limit: String(limit) });
    const url = `${REGISTRY_BASE_URL}?${params}`;

    try {
      const resp = await httpGet(url);
      if (resp.statusCode !== 200) throw new Error(`HTTP ${resp.statusCode}`);
      const json = JSON.parse(resp.body) as RegistryResponse;
      const items = this.normalizeServers(json.servers);
      this.searchCache = { key: cacheKey, result: items, fetchedAt: Date.now() };
      return items;
    } catch (err) {
      logger.error('Official MCP Registry search failed:', err);
      return this.searchCache?.result ?? [];
    }
  }

  /**
   * Browse the registry with cursor-based pagination.
   */
  async browse(
    cursor?: string,
    limit = 20
  ): Promise<{ servers: McpCatalogItem[]; nextCursor?: string }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    const url = `${REGISTRY_BASE_URL}?${params}`;

    try {
      const resp = await httpGet(url);
      if (resp.statusCode !== 200) throw new Error(`HTTP ${resp.statusCode}`);
      const json = JSON.parse(resp.body) as RegistryResponse;
      return {
        servers: this.normalizeServers(json.servers),
        nextCursor: json.metadata.nextCursor,
      };
    } catch (err) {
      logger.error('Official MCP Registry browse failed:', err);
      return { servers: [] };
    }
  }

  /**
   * Get a single server by its registry ID (reverse-DNS name).
   * Used for secure install flow (main-side re-resolution).
   */
  async getById(registryId: string): Promise<McpCatalogItem | null> {
    // The official registry search API can find by exact name
    const params = new URLSearchParams({ search: registryId, limit: '5' });
    const url = `${REGISTRY_BASE_URL}?${params}`;

    try {
      const resp = await httpGet(url);
      if (resp.statusCode !== 200) throw new Error(`HTTP ${resp.statusCode}`);
      const json = JSON.parse(resp.body) as RegistryResponse;
      const items = this.normalizeServers(json.servers);
      return items.find((s) => s.id === registryId) ?? null;
    } catch (err) {
      logger.error(`Official MCP Registry getById(${registryId}) failed:`, err);
      return null;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  private normalizeServers(entries: RegistryServerEntry[]): McpCatalogItem[] {
    // Filter to isLatest only (same server name may appear multiple times)
    const latest = entries.filter((e) => {
      const meta = e._meta?.['io.modelcontextprotocol.registry/official'];
      return meta?.isLatest !== false; // include if isLatest is true or undefined
    });

    // Filter to active only (include servers with no status or status "active")
    const active = latest.filter((e) => {
      const meta = e._meta?.['io.modelcontextprotocol.registry/official'];
      const status = meta?.status;
      return !status || status === 'active';
    });

    // Deduplicate by server name (take first = latest version)
    const seen = new Set<string>();
    const unique: RegistryServerEntry[] = [];
    for (const entry of active) {
      if (!seen.has(entry.server.name)) {
        seen.add(entry.server.name);
        unique.push(entry);
      }
    }

    return unique.map((entry) => this.normalizeEntry(entry));
  }

  private normalizeEntry(entry: RegistryServerEntry): McpCatalogItem {
    const { server } = entry;
    const meta = entry._meta?.['io.modelcontextprotocol.registry/official'];
    const installSpec = this.deriveInstallSpec(server);
    const envVars = this.collectEnvVars(server);
    const authHeaders = this.collectAuthHeaders(server);
    const requiresAuth = this.detectAuthRequired(server);

    return {
      id: server.name,
      name: server.title ?? server.name.split('/').pop() ?? server.name,
      description: server.description ?? '',
      repositoryUrl: server.repository?.url,
      version: server.version,
      source: 'official',
      installSpec,
      envVars,
      license: undefined, // Official registry doesn't expose license
      tools: [], // Tools not included in registry list response
      glamaUrl: undefined,
      requiresAuth,
      iconUrl: this.pickIconUrl(server.icons),
      websiteUrl: server.websiteUrl,
      status: meta?.status,
      publishedAt: meta?.publishedAt,
      updatedAt: meta?.updatedAt,
      authHeaders,
    };
  }

  private deriveInstallSpec(server: RegistryServerEntry['server']): McpInstallSpec | null {
    // Prefer npm stdio package
    const npmPkg = server.packages?.find((p) => p.registryType === 'npm');
    if (npmPkg) {
      return {
        type: 'stdio',
        npmPackage: npmPkg.identifier,
        npmVersion: npmPkg.version,
      };
    }

    // HTTP/SSE remote
    const remote = server.remotes?.[0];
    if (remote) {
      return {
        type: 'http',
        url: remote.url,
        transportType: remote.type as 'streamable-http' | 'sse' | 'http',
      };
    }

    return null;
  }

  private collectEnvVars(server: RegistryServerEntry['server']): McpEnvVarDef[] {
    const envVars: McpEnvVarDef[] = [];

    // From packages
    for (const pkg of server.packages ?? []) {
      for (const ev of pkg.environmentVariables ?? []) {
        envVars.push({
          name: ev.name,
          isSecret: ev.isSecret ?? false,
          description: ev.description,
          isRequired: ev.isRequired,
        });
      }
    }

    return envVars;
  }

  private collectAuthHeaders(server: RegistryServerEntry['server']): McpAuthHeaderDef[] {
    const headers: McpAuthHeaderDef[] = [];
    const seenKeys = new Set<string>();

    for (const remote of server.remotes ?? []) {
      for (const header of remote.headers ?? []) {
        const key = header.name.trim();
        if (!key || seenKeys.has(key)) {
          continue;
        }
        seenKeys.add(key);
        headers.push({
          key,
          description: header.description,
          isRequired: header.isRequired,
          isSecret: header.isSecret,
          valueTemplate: header.value,
        });
      }
    }

    return headers;
  }

  private detectAuthRequired(server: RegistryServerEntry['server']): boolean {
    for (const remote of server.remotes ?? []) {
      for (const header of remote.headers ?? []) {
        if (header.isRequired) return true;
      }
    }
    return false;
  }

  /** Pick best icon URL from the registry icons array (prefer dark theme PNG). */
  private pickIconUrl(icons?: RegistryIcon[]): string | undefined {
    if (!icons || icons.length === 0) return undefined;
    // Prefer dark-theme icon, then first available
    const darkIcon = icons.find((i) => i.theme === 'dark');
    return (darkIcon ?? icons[0]).src;
  }
}
