import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OfficialMcpRegistryService } from '@main/services/extensions/catalog/OfficialMcpRegistryService';

import registryListFixture from '../../../fixtures/extensions/official-mcp-registry-list.json';
import registrySearchFixture from '../../../fixtures/extensions/official-mcp-registry-search.json';

// ── Mock HTTP ──────────────────────────────────────────────────────────────

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

function mockHttpsGet(statusCode: number, body: string): void {
  const mockGet = https.get as ReturnType<typeof vi.fn>;
  mockGet.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
    const res = {
      statusCode,
      headers: {},
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

describe('OfficialMcpRegistryService', () => {
  let service: OfficialMcpRegistryService;

  beforeEach(() => {
    service = new OfficialMcpRegistryService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('search', () => {
    it('returns normalized MCP servers from search results', async () => {
      mockHttpsGet(200, JSON.stringify(registrySearchFixture));

      const results = await service.search('github');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('id');
      expect(results[0]).toHaveProperty('name');
      expect(results[0]).toHaveProperty('source', 'official');
    });

    it('returns empty array on network error', async () => {
      const mockGet = https.get as ReturnType<typeof vi.fn>;
      mockGet.mockImplementation((_url: string, _callback: unknown) => {
        return {
          setTimeout: vi.fn(),
          on: vi.fn((event: string, handler: (err: Error) => void) => {
            if (event === 'error') handler(new Error('Network error'));
          }),
          destroy: vi.fn(),
        };
      });

      const results = await service.search('test');
      expect(results).toEqual([]);
    });
  });

  describe('browse', () => {
    it('returns servers with pagination cursor', async () => {
      mockHttpsGet(200, JSON.stringify(registryListFixture));

      const result = await service.browse();

      expect(result.servers.length).toBeGreaterThan(0);
      expect(result.nextCursor).toBeDefined();
    });

    it('filters non-latest versions', async () => {
      mockHttpsGet(200, JSON.stringify(registryListFixture));

      const result = await service.browse();

      // Registry fixture has AdAdvisor with isLatest: false and isLatest: true
      // Only the latest should appear
      const adAdvisor = result.servers.filter((s) =>
        s.id === 'ai.adadvisor/mcp-server',
      );
      expect(adAdvisor.length).toBeLessThanOrEqual(1);
    });
  });

  describe('normalizeEntry', () => {
    it('derives stdio install spec from npm packages', async () => {
      mockHttpsGet(200, JSON.stringify(registryListFixture));

      const result = await service.browse();
      const agentTrust = result.servers.find((s) => s.id === 'ai.agenttrust/mcp-server');

      expect(agentTrust).toBeDefined();
      expect(agentTrust!.installSpec).toEqual({
        type: 'stdio',
        npmPackage: '@agenttrust/mcp-server',
        npmVersion: '1.1.1',
      });
    });

    it('derives HTTP install spec from remotes', async () => {
      mockHttpsGet(200, JSON.stringify(registryListFixture));

      const result = await service.browse();
      const lona = result.servers.find((s) => s.id === 'agency.lona/trading');

      expect(lona).toBeDefined();
      expect(lona!.installSpec).toEqual({
        type: 'http',
        url: 'https://mcp.lona.agency/mcp',
        transportType: 'streamable-http',
      });
    });

    it('detects auth-required servers', async () => {
      mockHttpsGet(200, JSON.stringify(registryListFixture));

      const result = await service.browse();
      const adAdvisor = result.servers.find((s) => s.id === 'ai.adadvisor/mcp-server');

      expect(adAdvisor?.requiresAuth).toBe(true);
      expect(adAdvisor?.authHeaders).toHaveLength(1);
      expect(adAdvisor?.authHeaders?.[0]).toMatchObject({
        key: 'Authorization',
        isRequired: true,
        isSecret: true,
      });
    });

    it('collects environment variables', async () => {
      mockHttpsGet(200, JSON.stringify(registryListFixture));

      const result = await service.browse();
      const agentTrust = result.servers.find((s) => s.id === 'ai.agenttrust/mcp-server');

      expect(agentTrust!.envVars).toEqual([
        {
          name: 'AGENTTRUST_API_KEY',
          isSecret: true,
          description: 'Your AgentTrust API key from https://agenttrust.ai',
          isRequired: true,
        },
      ]);
    });
  });
});
