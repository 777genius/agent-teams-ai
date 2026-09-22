/**
 * Resolves installed MCP server state through the active runtime adapter.
 *
 * Direct Claude mode reads CLI-managed config files.
 * Multimodel mode uses the structured `mcp list --json` runtime contract.
 */

import { createExtensionsRuntimeAdapter } from '../runtime/ExtensionsRuntimeAdapter';

import type { ExtensionsRuntimeAdapter } from '../runtime/ExtensionsRuntimeAdapter';
import type { InstalledMcpEntry } from '@shared/types/extensions';

const CACHE_TTL_MS = 10_000; // 10 seconds

interface TimedCache<T> {
  data: T;
  fetchedAt: number;
}

export class McpInstallationStateService {
  private cache = new Map<string, TimedCache<InstalledMcpEntry[]>>();

  constructor(
    private readonly runtimeAdapter: ExtensionsRuntimeAdapter = createExtensionsRuntimeAdapter()
  ) {}

  async getInstalled(projectPath?: string): Promise<InstalledMcpEntry[]> {
    const cacheKey = `${this.runtimeAdapter.flavor}:${projectPath ?? '__user__'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }

    const entries = await this.runtimeAdapter.getInstalledMcp(projectPath);
    this.cache.set(cacheKey, { data: entries, fetchedAt: Date.now() });
    return entries;
  }

  invalidateCache(): void {
    this.cache.clear();
  }
}
