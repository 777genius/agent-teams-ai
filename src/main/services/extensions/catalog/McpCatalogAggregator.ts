/**
 * Aggregates MCP catalog data from Official Registry + Glama.
 *
 * - Uses Promise.allSettled so partial API failures don't break the whole catalog
 * - Dedup by repository URL; Official source takes priority
 * - Enriches Official entries with Glama data (license, tools) when matched
 * - Provides getById() for secure install flow
 */

import { normalizeRepoUrl } from '@shared/utils/extensionNormalizers';
import { createLogger } from '@shared/utils/logger';

import { type GlamaMcpEnrichmentService } from './GlamaMcpEnrichmentService';
import { type OfficialMcpRegistryService } from './OfficialMcpRegistryService';

import type { McpCatalogItem, McpSearchResult } from '@shared/types/extensions';

const logger = createLogger('Extensions:McpAggregator');

export class McpCatalogAggregator {
  constructor(
    private readonly official: OfficialMcpRegistryService,
    private readonly glama: GlamaMcpEnrichmentService
  ) {}

  /**
   * Search both sources and return merged results.
   */
  async search(query: string, limit = 20): Promise<McpSearchResult> {
    const warnings: string[] = [];

    const [officialResult, glamaResult] = await Promise.allSettled([
      this.official.search(query, limit),
      this.glama.search(query, limit),
    ]);

    const officialServers = officialResult.status === 'fulfilled' ? officialResult.value : [];
    const glamaServers = glamaResult.status === 'fulfilled' ? glamaResult.value : [];

    if (officialResult.status === 'rejected') {
      warnings.push('Official MCP Registry unavailable');
      logger.warn('Official registry search failed:', officialResult.reason);
    }
    if (glamaResult.status === 'rejected') {
      warnings.push('Glama enrichment unavailable');
      logger.warn('Glama search failed:', glamaResult.reason);
    }

    const merged = this.mergeAndDeduplicate(officialServers, glamaServers);

    return { servers: merged, warnings };
  }

  /**
   * Browse the official registry with optional Glama enrichment.
   */
  async browse(
    cursor?: string,
    limit = 20
  ): Promise<{ servers: McpCatalogItem[]; nextCursor?: string }> {
    // Browse primarily from official registry (has pagination)
    const result = await this.official.browse(cursor, limit);

    // Optionally enrich with Glama data (best effort, no pagination sync)
    try {
      const glamaBrowse = await this.glama.browse(undefined, limit);
      const enriched = this.enrichOfficialWithGlama(result.servers, glamaBrowse.servers);
      return { servers: enriched, nextCursor: result.nextCursor };
    } catch {
      return result;
    }
  }

  /**
   * Get a single server by ID for secure install flow.
   * Delegates to appropriate source based on ID prefix.
   */
  async getById(registryId: string): Promise<McpCatalogItem | null> {
    // Glama IDs are prefixed with "glama:"
    if (registryId.startsWith('glama:')) {
      logger.warn(`Cannot install Glama-only server: ${registryId}`);
      return null; // Glama servers can't be auto-installed
    }

    // Official registry lookup
    return this.official.getById(registryId);
  }

  // ── Private ────────────────────────────────────────────────────────────

  /**
   * Merge Official + Glama, dedup by repository URL.
   * Official entries take priority.
   */
  private mergeAndDeduplicate(
    official: McpCatalogItem[],
    glama: McpCatalogItem[]
  ): McpCatalogItem[] {
    // Build repo URL index from official entries
    const officialRepoUrls = new Set<string>();
    for (const item of official) {
      if (item.repositoryUrl) {
        officialRepoUrls.add(normalizeRepoUrl(item.repositoryUrl));
      }
    }

    // Enrich official entries with Glama data
    const enriched = this.enrichOfficialWithGlama(official, glama);

    // Add Glama-only entries (no matching official entry)
    const glamaOnly = glama.filter((g) => {
      if (!g.repositoryUrl) return true; // no repo URL = can't match, show separately
      return !officialRepoUrls.has(normalizeRepoUrl(g.repositoryUrl));
    });

    return [...enriched, ...glamaOnly];
  }

  /**
   * Enrich official entries with Glama metadata (license, tools, glamaUrl).
   */
  private enrichOfficialWithGlama(
    official: McpCatalogItem[],
    glama: McpCatalogItem[]
  ): McpCatalogItem[] {
    // Index Glama by normalized repo URL
    const glamaByRepo = new Map<string, McpCatalogItem>();
    for (const g of glama) {
      if (g.repositoryUrl) {
        glamaByRepo.set(normalizeRepoUrl(g.repositoryUrl), g);
      }
    }

    return official.map((item) => {
      if (!item.repositoryUrl) return item;

      const glamaMatch = glamaByRepo.get(normalizeRepoUrl(item.repositoryUrl));
      if (!glamaMatch) return item;

      return {
        ...item,
        license: item.license ?? glamaMatch.license,
        tools: item.tools.length > 0 ? item.tools : glamaMatch.tools,
        glamaUrl: glamaMatch.glamaUrl,
        author: item.author ?? glamaMatch.author,
        hostingType: item.hostingType ?? glamaMatch.hostingType,
      };
    });
  }
}
