/**
 * Reads installed MCP server state from the filesystem.
 *
 * Sources:
 * - User scope: ~/.claude.json → mcpServers
 * - Local scope: ~/.claude.json → projects[projectPath].mcpServers
 * - Project scope: .mcp.json in project root
 *
 * Both files are managed by the Claude CLI. This service is read-only.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getHomeDir } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type { InstalledMcpEntry } from '@shared/types/extensions';

const logger = createLogger('Extensions:McpState');

const CACHE_TTL_MS = 10_000; // 10 seconds

interface TimedCache<T> {
  data: T;
  fetchedAt: number;
}

export class McpInstallationStateService {
  private cache = new Map<string, TimedCache<InstalledMcpEntry[]>>();

  /**
   * Get all installed MCP servers across user, local, and project scopes.
   */
  async getInstalled(projectPath?: string): Promise<InstalledMcpEntry[]> {
    const cacheKey = projectPath ?? '__user__';
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }

    const entries: InstalledMcpEntry[] = [];
    const claudeConfig = await this.readClaudeConfig();

    // User scope: ~/.claude.json
    entries.push(...this.readUserMcpServers(claudeConfig));

    if (projectPath) {
      entries.push(...this.readLocalMcpServers(claudeConfig, projectPath));
      entries.push(...(await this.readProjectMcpServers(projectPath)));
    }

    this.cache.set(cacheKey, { data: entries, fetchedAt: Date.now() });
    return entries;
  }

  /**
   * Invalidate cache. Call after install/uninstall operations.
   */
  invalidateCache(): void {
    this.cache.clear();
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async readClaudeConfig(): Promise<Record<string, unknown> | null> {
    const configPath = path.join(getHomeDir(), '.claude.json');
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.error(`Failed to read MCP servers from ${configPath}:`, err);
      return null;
    }
  }

  private readUserMcpServers(config: Record<string, unknown> | null): InstalledMcpEntry[] {
    return this.readMcpServersFromConfig(config?.mcpServers, 'user');
  }

  private readLocalMcpServers(
    config: Record<string, unknown> | null,
    projectPath: string
  ): InstalledMcpEntry[] {
    const projects =
      config && typeof config.projects === 'object' && config.projects
        ? (config.projects as Record<string, unknown>)
        : null;
    const projectConfig =
      projects && typeof projects[projectPath] === 'object' && projects[projectPath]
        ? (projects[projectPath] as Record<string, unknown>)
        : null;
    return this.readMcpServersFromConfig(projectConfig?.mcpServers, 'local');
  }

  private async readProjectMcpServers(projectPath: string): Promise<InstalledMcpEntry[]> {
    const configPath = path.join(projectPath, '.mcp.json');
    return this.readMcpServersFromFile(configPath, 'project');
  }

  private readMcpServersFromConfig(
    value: unknown,
    scope: 'user' | 'project' | 'local'
  ): InstalledMcpEntry[] {
    const mcpServers =
      value && typeof value === 'object'
        ? (value as Record<string, { command?: string; url?: string }>)
        : null;
    if (!mcpServers) {
      return [];
    }

    return Object.entries(mcpServers).map(([name, config]): InstalledMcpEntry => {
      let transport: string | undefined;
      if (config.command) transport = 'stdio';
      else if (config.url) transport = 'http';

      return { name, scope, transport };
    });
  }

  private async readMcpServersFromFile(
    filePath: string,
    scope: 'user' | 'project'
  ): Promise<InstalledMcpEntry[]> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      return this.readMcpServersFromConfig(json.mcpServers, scope);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error(`Failed to read MCP servers from ${filePath}:`, err);
      return [];
    }
  }
}
