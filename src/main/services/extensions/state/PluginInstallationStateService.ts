/**
 * Reads plugin installed state and install counts from the filesystem.
 *
 * Sources:
 * - Installed state: ~/.claude/plugins/installed_plugins.json
 * - Install counts:  ~/.claude/plugins/install-counts-cache.json
 *
 * Both files are managed by the Claude CLI. This service is read-only.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '@shared/utils/logger';
import type { InstalledPluginEntry } from '@shared/types/extensions';
import type { InstallScope } from '@shared/types/extensions';
import { getClaudeBasePath } from '@main/utils/pathDecoder';

const logger = createLogger('Extensions:PluginState');

// ── Constants ──────────────────────────────────────────────────────────────

const INSTALLED_STATE_TTL_MS = 10_000; // 10 seconds
const INSTALL_COUNTS_TTL_MS = 5 * 60_000; // 5 minutes

// ── Raw file shapes ────────────────────────────────────────────────────────

interface InstalledPluginsJson {
  version: number;
  plugins: Record<
    string, // qualifiedName
    Array<{
      scope: string;
      installPath?: string;
      version?: string;
      installedAt?: string;
      lastUpdated?: string;
      gitCommitSha?: string;
    }>
  >;
}

interface InstallCountsJson {
  version: number;
  fetchedAt: string;
  counts: Array<{
    plugin: string; // qualifiedName format
    unique_installs: number;
  }>;
}

// ── Cache ──────────────────────────────────────────────────────────────────

interface TimedCache<T> {
  data: T;
  fetchedAt: number;
}

// ── Service ────────────────────────────────────────────────────────────────

export class PluginInstallationStateService {
  private installedCache: TimedCache<InstalledPluginEntry[]> | null = null;
  private countsCache: TimedCache<Map<string, number>> | null = null;

  /**
   * Get all installed plugins across all scopes.
   * Returns merged list from installed_plugins.json with scope tags.
   */
  async getInstalledPlugins(_projectPath?: string): Promise<InstalledPluginEntry[]> {
    if (
      this.installedCache &&
      Date.now() - this.installedCache.fetchedAt < INSTALLED_STATE_TTL_MS
    ) {
      return this.installedCache.data;
    }

    const entries = await this.readInstalledPlugins();
    this.installedCache = { data: entries, fetchedAt: Date.now() };
    return entries;
  }

  /**
   * Get install counts keyed by pluginId (qualifiedName).
   */
  async getInstallCounts(): Promise<Map<string, number>> {
    if (this.countsCache && Date.now() - this.countsCache.fetchedAt < INSTALL_COUNTS_TTL_MS) {
      return this.countsCache.data;
    }

    const counts = await this.readInstallCounts();
    this.countsCache = { data: counts, fetchedAt: Date.now() };
    return counts;
  }

  /**
   * Invalidate all caches. Call after install/uninstall operations.
   */
  invalidateCache(): void {
    this.installedCache = null;
    this.countsCache = null;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private getPluginsDir(): string {
    return path.join(getClaudeBasePath(), 'plugins');
  }

  private async readInstalledPlugins(): Promise<InstalledPluginEntry[]> {
    const filePath = path.join(this.getPluginsDir(), 'installed_plugins.json');

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const json = JSON.parse(raw) as InstalledPluginsJson;

      if (json.version !== 2 || !json.plugins) {
        logger.warn(`Unexpected installed_plugins.json version: ${json.version}`);
        return [];
      }

      const entries: InstalledPluginEntry[] = [];

      for (const [qualifiedName, installations] of Object.entries(json.plugins)) {
        for (const inst of installations) {
          entries.push({
            pluginId: qualifiedName,
            scope: this.normalizeScope(inst.scope),
            version: inst.version,
            installedAt: inst.installedAt,
            installPath: inst.installPath,
          });
        }
      }

      return entries;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []; // No plugins installed yet
      }
      logger.error('Failed to read installed_plugins.json:', err);
      return [];
    }
  }

  private async readInstallCounts(): Promise<Map<string, number>> {
    const filePath = path.join(this.getPluginsDir(), 'install-counts-cache.json');

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const json = JSON.parse(raw) as InstallCountsJson;

      const map = new Map<string, number>();

      if (json.counts && Array.isArray(json.counts)) {
        for (const entry of json.counts) {
          // Install counts use qualifiedName format (name@marketplace)
          map.set(entry.plugin, entry.unique_installs);
        }
      }

      return map;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map();
      }
      logger.error('Failed to read install-counts-cache.json:', err);
      return new Map();
    }
  }

  private normalizeScope(raw: string): InstallScope {
    const lower = raw.toLowerCase();
    if (lower === 'user' || lower === 'project' || lower === 'local') {
      return lower;
    }
    return 'user'; // safe default
  }
}
