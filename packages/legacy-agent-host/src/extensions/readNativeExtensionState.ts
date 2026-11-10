import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readConfiguredMcpServers } from '../mcp-catalog/catalog.js';
import { readCapturedMcpBytes } from '../mcp-catalog/capturedFile.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import { captureNativeExtensionTarget } from './captureNativeExtensionTarget.js';
import { getMcpRuntimeTargetKey } from './mcpTargets.js';

import type { InstalledMcpEntry, InstalledPluginEntry, PluginInstallScope } from './contracts.js';
import type { ClaudeManagementProfile } from '../management/profile.js';

const MAX_BYTES = 8 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ManagementCommandError('held');
  return value as Record<string, unknown>;
};
const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 8192 && !value.includes('\0') ? value : undefined;

/** Bounded existing-file reads only; an absent optional native directory is an empty inventory. */
function readJson(path: string, assertCurrent: () => void): Record<string, unknown> | undefined {
  assertCurrent();
  // The shared FD reader deliberately requires all parents. Optional plugin folders need not exist yet.
  try {
    lstatSync(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      assertCurrent();
      return undefined;
    }
    throw error;
  }
  const bytes = readCapturedMcpBytes(path, MAX_BYTES);
  assertCurrent();
  if (bytes === undefined) return undefined;
  try {
    return object(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new ManagementCommandError('held');
  }
}

/** Exact prior enabled-settings semantics, now anchored to the originally captured native profile. */
export function readNativePlugins(
  profile: ClaudeManagementProfile,
  projectSelected: boolean,
  assertCurrent: () => void
) {
  const user = captureNativeExtensionTarget(
    profile,
    { panel: 'plugins', scope: 'user' },
    assertCurrent
  );
  const project = projectSelected
    ? captureNativeExtensionTarget(profile, { panel: 'plugins', scope: 'project' }, assertCurrent)
    : undefined;
  const current = () => {
    user.assertCurrent();
    project?.assertCurrent();
  };
  const metadata = readJson(join(user.rootPath, 'plugins', 'installed_plugins.json'), current);
  if (metadata && (metadata.version !== 2 || !metadata.plugins))
    throw new ManagementCommandError('held');
  const byKey = new Map<string, InstalledPluginEntry[]>();
  for (const [pluginId, values] of Object.entries(metadata ? object(metadata.plugins) : {})) {
    if (!Array.isArray(values) || values.length > 10000) throw new ManagementCommandError('held');
    for (const raw of values) {
      const value = object(raw),
        scope = value.scope;
      if (scope !== 'user' && scope !== 'project' && scope !== 'local') continue;
      const entry: InstalledPluginEntry = { pluginId, scope };
      for (const key of ['version', 'installedAt', 'installPath'] as const) {
        const text = optionalText(value[key]);
        if (text !== undefined) entry[key] = text;
      }
      const key = `${pluginId}::${scope}`,
        entries = byKey.get(key) ?? [];
      entries.push(entry);
      byKey.set(key, entries);
    }
  }
  const entries: InstalledPluginEntry[] = [];
  const scopes: [PluginInstallScope, string][] = [['user', join(user.rootPath, 'settings.json')]];
  if (project)
    scopes.push(
      ['project', join(project.rootPath, 'settings.json')],
      ['local', join(project.rootPath, 'settings.local.json')]
    );
  for (const [scope, path] of scopes) {
    const settings = readJson(path, current);
    const enabled = settings?.enabledPlugins;
    if (enabled === undefined || enabled === null) continue;
    for (const [pluginId, value] of Object.entries(object(enabled))) {
      if (value !== true) continue;
      const rows = byKey.get(`${pluginId}::${scope}`) ?? [];
      const timestamp = (row: InstalledPluginEntry) => {
        const value = Date.parse(row.installedAt ?? '');
        return Number.isFinite(value) ? value : 0;
      };
      const best = [...rows].sort((a, b) => timestamp(b) - timestamp(a))[0];
      entries.push({ ...best, pluginId, scope });
    }
  }
  const counts = readJson(join(user.rootPath, 'plugins', 'install-counts-cache.json'), current);
  const installCounts: [string, number][] = [];
  if (counts?.counts !== undefined) {
    if (!Array.isArray(counts.counts) || counts.counts.length > 10000)
      throw new ManagementCommandError('held');
    for (const raw of counts.counts) {
      const row = object(raw);
      if (
        typeof row.plugin === 'string' &&
        Number.isSafeInteger(row.unique_installs) &&
        Number(row.unique_installs) >= 0
      )
        installCounts.push([row.plugin, Number(row.unique_installs)]);
    }
  }
  if (entries.length > 10000) throw new ManagementCommandError('held');
  current();
  return { entries, installCounts };
}

/** Preserve user/local/project rows and secret-free target matching without returning native configs. */
export function readNativeMcp(
  profile: ClaudeManagementProfile,
  projectSelected: boolean,
  assertCurrent: () => void
): InstalledMcpEntry[] {
  const captured = captureNativeExtensionTarget(
    profile,
    { panel: 'mcp', scope: projectSelected ? 'project' : 'user' },
    assertCurrent
  );
  const current = () => captured.assertCurrent();
  const config = readJson(captured.nativeUserConfigPath!, current);
  const rows = readConfiguredMcpServers(config?.mcpServers, 'user');
  if (captured.projectRoot) {
    const projects = config?.projects === undefined ? undefined : object(config.projects);
    const local = projects?.[captured.projectRoot];
    rows.push(
      ...readConfiguredMcpServers(
        local === undefined ? undefined : object(local).mcpServers,
        'local'
      )
    );
    const project = readJson(join(captured.projectRoot, '.mcp.json'), current);
    rows.push(...readConfiguredMcpServers(project?.mcpServers, 'project'));
  }
  if (rows.length > 10000) throw new ManagementCommandError('held');
  const entries = rows.map(({ name, scope, config }): InstalledMcpEntry => {
    const transport =
      typeof config.command === 'string'
        ? 'stdio'
        : typeof config.url === 'string'
          ? 'http'
          : undefined;
    let targetKey: string | null = null;
    if (
      transport === 'stdio' &&
      config.command === 'npx' &&
      Array.isArray(config.args) &&
      config.args.length === 2 &&
      config.args[0] === '-y' &&
      typeof config.args[1] === 'string'
    )
      targetKey = getMcpRuntimeTargetKey(`npx -y ${config.args[1]}`, transport);
    else if (transport === 'http' && typeof config.url === 'string')
      targetKey = getMcpRuntimeTargetKey(config.url, transport);
    return {
      name,
      scope,
      ...(transport ? { transport } : {}),
      ...(targetKey ? { targetKey } : {}),
    };
  });
  current();
  return entries;
}
