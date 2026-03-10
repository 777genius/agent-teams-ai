/**
 * Reads installed MCP server state from the filesystem.
 *
 * Sources:
 * - User scope: ~/.claude.json → mcpServers
 * - Project scope: .mcp.json in project root
 * - Local scope: determined by Claude CLI (may also be in ~/.claude.json)
 *
 * Both files are managed by the Claude CLI. This service is read-only.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '@shared/utils/logger';
import type { InstalledMcpEntry } from '@shared/types/extensions';
import { getHomeDir } from '@main/utils/pathDecoder';

const logger = createLogger('Extensions:McpState');

const CACHE_TTL_MS = 10_000; // 10 seconds

interface TimedCache<T> {
  data: T;
  fetchedAt: number;
}

export class McpInstallationStateService {
  private cache: TimedCache<InstalledMcpEntry[]> | null = null;

  /**
   * Get all installed MCP servers across user and project scopes.
   */
  async getInstalled(projectPath?: string): Promise<InstalledMcpEntry[]> {
    // Cache is project-path-dependent, so invalidate on path change
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.data;
    }

    const entries: InstalledMcpEntry[] = [];

    // User scope: ~/.claude.json
    const userEntries = await this.readUserMcpServers();
    entries.push(...userEntries);

    // Project scope: .mcp.json
    if (projectPath) {
      const projectEntries = await this.readProjectMcpServers(projectPath);
      entries.push(...projectEntries);
    }

    this.cache = { data: entries, fetchedAt: Date.now() };
    return entries;
  }

  /**
   * Invalidate cache. Call after install/uninstall operations.
   */
  invalidateCache(): void {
    this.cache = null;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async readUserMcpServers(): Promise<InstalledMcpEntry[]> {
    const configPath = path.join(getHomeDir(), '.claude.json');
    return this.readMcpServersFromFile(configPath, 'user');
  }

  private async readProjectMcpServers(projectPath: string): Promise<InstalledMcpEntry[]> {
    const configPath = path.join(projectPath, '.mcp.json');
    return this.readMcpServersFromFile(configPath, 'project');
  }

  private async readMcpServersFromFile(
    filePath: string,
    scope: 'user' | 'project'
  ): Promise<InstalledMcpEntry[]> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      const mcpServers = json.mcpServers as
        | Record<string, { command?: string; url?: string }>
        | undefined;

      if (!mcpServers || typeof mcpServers !== 'object') {
        return [];
      }

      return Object.entries(mcpServers).map(([name, config]): InstalledMcpEntry => {
        let transport: string | undefined;
        if (config.command) transport = 'stdio';
        else if (config.url) transport = 'http';

        return { name, scope, transport };
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error(`Failed to read MCP servers from ${filePath}:`, err);
      return [];
    }
  }
}
