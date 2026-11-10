/**
 * Fetches MCP server data from the Glama.ai API.
 *
 * Optional enrichment layer — NOT a hard dependency.
 * Provides: license, tools, Glama URL.
 * Does NOT provide install info (no packages/remotes).
 *
 * Base URL: https://glama.ai/api/mcp/v1/servers
 * Cursor-based pagination (after), no auth required.
 */

import http from 'node:http';
import https from 'node:https';

import { createLogger } from '@shared/utils/logger';

import type { McpCatalogItem, McpHostingType, McpToolDef } from '@shared/types/extensions';

const logger = createLogger('Extensions:GlamaMcp');

// ── Constants ──────────────────────────────────────────────────────────────

const GLAMA_BASE_URL = 'https://glama.ai/api/mcp/v1/servers';
const HTTP_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
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
        res.destroy();
        httpGet(new URL(res.headers.location, url).toString(), redirectsLeft - 1).then(
          settleResolve,
          settleReject
        );
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

// ── Raw Glama API shapes ───────────────────────────────────────────────────

interface GlamaResponse {
  pageInfo: {
    endCursor?: string;
    hasNextPage?: boolean;
  };
  servers: GlamaServer[];
}

interface GlamaServer {
  id: string;
  name: string;
  namespace?: string;
  description?: string;
  slug?: string;
  url?: string;
  repository?: { url: string };
  spdxLicense?: { name: string; url?: string } | null;
  tools?: { name?: string; description?: string }[];
  attributes?: string[];
}

// ── Service ────────────────────────────────────────────────────────────────

export class GlamaMcpEnrichmentService {
  /**
   * Search Glama for MCP servers.
   */
  async search(query: string, limit = 20): Promise<McpCatalogItem[]> {
    const params = new URLSearchParams({ search: query, first: String(limit) });
    const url = `${GLAMA_BASE_URL}?${params}`;

    try {
      const resp = await httpGet(url);
      if (resp.statusCode !== 200) throw new Error(`HTTP ${resp.statusCode}`);
      const json = JSON.parse(resp.body) as GlamaResponse;
      return json.servers.map((s) => this.normalize(s));
    } catch (err) {
      logger.warn('Glama MCP search failed:', err);
      return [];
    }
  }

  /**
   * Browse Glama catalog with cursor pagination.
   */
  async browse(
    cursor?: string,
    limit = 20
  ): Promise<{ servers: McpCatalogItem[]; nextCursor?: string }> {
    const params = new URLSearchParams({ first: String(limit) });
    if (cursor) params.set('after', cursor);
    const url = `${GLAMA_BASE_URL}?${params}`;

    try {
      const resp = await httpGet(url);
      if (resp.statusCode !== 200) throw new Error(`HTTP ${resp.statusCode}`);
      const json = JSON.parse(resp.body) as GlamaResponse;
      return {
        servers: json.servers.map((s) => this.normalize(s)),
        nextCursor: json.pageInfo.hasNextPage ? json.pageInfo.endCursor : undefined,
      };
    } catch (err) {
      logger.warn('Glama MCP browse failed:', err);
      return { servers: [] };
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  private normalize(raw: GlamaServer): McpCatalogItem {
    const tools: McpToolDef[] = (raw.tools ?? [])
      .filter((t): t is { name: string; description: string } => Boolean(t.name))
      .map((t) => ({ name: t.name, description: t.description ?? '' }));

    return {
      id: `glama:${raw.id}`,
      name: raw.name,
      description: raw.description ?? '',
      repositoryUrl: raw.repository?.url,
      version: undefined, // Glama doesn't expose version
      source: 'glama',
      installSpec: null, // Glama has NO install info
      envVars: [],
      license: raw.spdxLicense?.name,
      tools,
      glamaUrl: raw.url,
      requiresAuth: false,
      author: raw.namespace,
      hostingType: this.deriveHostingType(raw.attributes),
    };
  }

  private deriveHostingType(attributes?: string[]): McpHostingType | undefined {
    if (!attributes?.length) return undefined;
    const hasLocal = attributes.includes('hosting:local-only');
    const hasRemote = attributes.includes('hosting:remote-capable');
    if (hasLocal && hasRemote) return 'both';
    if (hasLocal) return 'local';
    if (hasRemote) return 'remote';
    return undefined;
  }
}
