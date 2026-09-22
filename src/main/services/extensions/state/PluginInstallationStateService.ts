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

import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type { InstalledPluginEntry, PluginInstallScope } from '@shared/types/extensions';

const logger = createLogger('Extensions:PluginState');

// ── Constants ──────────────────────────────────────────────────────────────

const INSTALLED_STATE_TTL_MS = 10_000; // 10 seconds
const INSTALL_COUNTS_TTL_MS = 5 * 60_000; // 5 minutes

// ── Raw file shapes ────────────────────────────────────────────────────────

interface InstalledPluginsJson {
  version: number;
  plugins: Record<
    string, // qualifiedName
    {
      scope: string;
      installPath?: string;
      version?: string;
      installedAt?: string;
      lastUpdated?: string;
      gitCommitSha?: string;
    }[]
  >;
}

interface InstallCountsJson {
  version: number;
  fetchedAt: string;
  counts: {
    plugin: string; // qualifiedName format
    unique_installs: number;
  }[];
}

// ── Cache ──────────────────────────────────────────────────────────────────

interface TimedCache<T> {
  data: T;
  fetchedAt: number;
}

// ── Service ────────────────────────────────────────────────────────────────

export class PluginInstallationStateService {
  private installedCache = new Map<string, TimedCache<InstalledPluginEntry[]>>();
  private countsCache: TimedCache<Map<string, number>> | null = null;

  /**
   * Get installed plugins relevant to the active context.
   * Always includes user scope. Project/local entries are only included when
   * they are enabled for the active project.
   */
  async getInstalledPlugins(projectPath?: string): Promise<InstalledPluginEntry[]> {
    const normalizedProjectPath =
      typeof projectPath === 'string' && path.isAbsolute(projectPath) ? projectPath : undefined;
    const cacheKey = this.getInstalledCacheKey(normalizedProjectPath);
    const cached = this.installedCache.get(cacheKey);

    if (cached && Date.now() - cached.fetchedAt < INSTALLED_STATE_TTL_MS) {
      return cached.data;
    }

    const entries = await this.buildInstalledEntriesForContext(normalizedProjectPath);
    this.installedCache.set(cacheKey, { data: entries, fetchedAt: Date.now() });
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
    this.installedCache.clear();
    this.countsCache = null;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private getPluginsDir(): string {
    return path.join(getClaudeBasePath(), 'plugins');
  }

  private getInstalledCacheKey(projectPath?: string): string {
    return projectPath ?? '__user__';
  }

  private async buildInstalledEntriesForContext(
    projectPath?: string
  ): Promise<InstalledPluginEntry[]> {
    const installedMetadata = await this.readInstalledPluginMetadata();
    const metadataByKey = new Map<string, InstalledPluginEntry[]>();

    for (const entry of installedMetadata) {
      const key = this.getPluginScopeKey(entry.pluginId, entry.scope);
      const matches = metadataByKey.get(key) ?? [];
      matches.push(entry);
      metadataByKey.set(key, matches);
    }

    const userEnabled = await this.readEnabledPlugins(
      path.join(getClaudeBasePath(), 'settings.json')
    );
    const projectEnabled = projectPath
      ? await this.readEnabledPlugins(path.join(projectPath, '.claude', 'settings.json'))
      : new Set<string>();
    const localEnabled = projectPath
      ? await this.readEnabledPlugins(path.join(projectPath, '.claude', 'settings.local.json'))
      : new Set<string>();

    return [
      ...this.buildScopedEntries('user', userEnabled, metadataByKey),
      ...this.buildScopedEntries('project', projectEnabled, metadataByKey),
      ...this.buildScopedEntries('local', localEnabled, metadataByKey),
    ];
  }

  private buildScopedEntries(
    scope: PluginInstallScope,
    enabledPlugins: Set<string>,
    metadataByKey: Map<string, InstalledPluginEntry[]>
  ): InstalledPluginEntry[] {
    return Array.from(enabledPlugins).map((pluginId) => {
      const key = this.getPluginScopeKey(pluginId, scope);
      const bestMatch = this.pickBestInstallationEntry(metadataByKey.get(key) ?? []);

      return bestMatch
        ? {
            ...bestMatch,
            pluginId,
            scope,
          }
        : {
            pluginId,
            scope,
          };
    });
  }

  private getPluginScopeKey(pluginId: string, scope: PluginInstallScope): string {
    return `${pluginId}::${scope}`;
  }

  private pickBestInstallationEntry(entries: InstalledPluginEntry[]): InstalledPluginEntry | null {
    if (entries.length === 0) {
      return null;
    }

    return [...entries].sort((left, right) => {
      const leftInstalledAt = Date.parse(left.installedAt ?? '');
      const rightInstalledAt = Date.parse(right.installedAt ?? '');
      const normalizedLeft = Number.isFinite(leftInstalledAt) ? leftInstalledAt : 0;
      const normalizedRight = Number.isFinite(rightInstalledAt) ? rightInstalledAt : 0;
      return normalizedRight - normalizedLeft;
    })[0];
  }

  private async readInstalledPluginMetadata(): Promise<InstalledPluginEntry[]> {
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

  private async readEnabledPlugins(filePath: string): Promise<Set<string>> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const json = JSON.parse(raw) as {
        enabledPlugins?: Record<string, boolean> | null;
      };

      if (!json.enabledPlugins || typeof json.enabledPlugins !== 'object') {
        return new Set<string>();
      }

      return new Set(
        Object.entries(json.enabledPlugins)
          .filter(([, enabled]) => enabled === true)
          .map(([pluginId]) => pluginId)
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Set<string>();
      }
      logger.error(`Failed to read plugin settings from ${filePath}:`, err);
      return new Set<string>();
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

  private normalizeScope(raw: string): PluginInstallScope {
    const lower = raw.toLowerCase();
    if (lower === 'user' || lower === 'project' || lower === 'local') {
      return lower;
    }
    return 'user'; // safe default
  }
}
