import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpCatalogAggregator } from '@main/services/extensions/catalog/McpCatalogAggregator';
import { OfficialMcpRegistryService } from '@main/services/extensions/catalog/OfficialMcpRegistryService';
import { GlamaMcpEnrichmentService } from '@main/services/extensions/catalog/GlamaMcpEnrichmentService';
import type { McpCatalogItem } from '@shared/types/extensions';

describe('McpCatalogAggregator', () => {
  let aggregator: McpCatalogAggregator;
  let official: OfficialMcpRegistryService;
  let glama: GlamaMcpEnrichmentService;

  const makeItem = (overrides: Partial<McpCatalogItem>): McpCatalogItem => ({
    id: 'test-id',
    name: 'test',
    description: 'test desc',
    source: 'official',
    installSpec: null,
    envVars: [],
    tools: [],
    requiresAuth: false,
    ...overrides,
  });

  beforeEach(() => {
    official = new OfficialMcpRegistryService();
    glama = new GlamaMcpEnrichmentService();
    aggregator = new McpCatalogAggregator(official, glama);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('search', () => {
    it('merges results from both sources', async () => {
      const officialItem = makeItem({
        id: 'io.example/server',
        name: 'Example',
        source: 'official',
        repositoryUrl: 'https://github.com/example/server',
      });
      const glamaItem = makeItem({
        id: 'glama:abc123',
        name: 'glama-only',
        source: 'glama',
        repositoryUrl: 'https://github.com/glama/only',
      });

      vi.spyOn(official, 'search').mockResolvedValue([officialItem]);
      vi.spyOn(glama, 'search').mockResolvedValue([glamaItem]);

      const result = await aggregator.search('test');

      expect(result.servers).toHaveLength(2);
      expect(result.warnings).toEqual([]);
    });

    it('reports warning when official registry fails', async () => {
      vi.spyOn(official, 'search').mockRejectedValue(new Error('timeout'));
      vi.spyOn(glama, 'search').mockResolvedValue([makeItem({ id: 'glama:1', source: 'glama' })]);

      const result = await aggregator.search('test');

      expect(result.servers).toHaveLength(1);
      expect(result.warnings).toContain('Official MCP Registry unavailable');
    });

    it('reports warning when glama fails', async () => {
      vi.spyOn(official, 'search').mockResolvedValue([makeItem({ id: 'off1', source: 'official' })]);
      vi.spyOn(glama, 'search').mockRejectedValue(new Error('timeout'));

      const result = await aggregator.search('test');

      expect(result.servers).toHaveLength(1);
      expect(result.warnings).toContain('Glama enrichment unavailable');
    });

    it('deduplicates by repository URL (official takes priority)', async () => {
      const repo = 'https://github.com/shared/repo';
      const officialItem = makeItem({
        id: 'io.shared/repo',
        name: 'Official',
        source: 'official',
        repositoryUrl: repo,
      });
      const glamaItem = makeItem({
        id: 'glama:shared',
        name: 'Glama',
        source: 'glama',
        repositoryUrl: repo,
        license: 'MIT',
      });

      vi.spyOn(official, 'search').mockResolvedValue([officialItem]);
      vi.spyOn(glama, 'search').mockResolvedValue([glamaItem]);

      const result = await aggregator.search('test');

      // Should have 1 (official), not 2
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].source).toBe('official');
      // Enriched with Glama license
      expect(result.servers[0].license).toBe('MIT');
    });

    it('handles case-insensitive repo URL dedup', async () => {
      const officialItem = makeItem({
        id: 'io.example/repo',
        source: 'official',
        repositoryUrl: 'https://GitHub.com/Example/Repo.git',
      });
      const glamaItem = makeItem({
        id: 'glama:x',
        source: 'glama',
        repositoryUrl: 'https://github.com/example/repo',
      });

      vi.spyOn(official, 'search').mockResolvedValue([officialItem]);
      vi.spyOn(glama, 'search').mockResolvedValue([glamaItem]);

      const result = await aggregator.search('test');
      expect(result.servers).toHaveLength(1);
    });
  });

  describe('getById', () => {
    it('delegates to official for non-glama IDs', async () => {
      const item = makeItem({ id: 'io.example/server' });
      vi.spyOn(official, 'getById').mockResolvedValue(item);

      const result = await aggregator.getById('io.example/server');
      expect(result).toBe(item);
      expect(official.getById).toHaveBeenCalledWith('io.example/server');
    });

    it('returns null for glama IDs (cannot auto-install)', async () => {
      const result = await aggregator.getById('glama:abc123');
      expect(result).toBeNull();
    });
  });
});
