/**
 * Pure-function normalizers for Extension Store data.
 */

import {
  getCliProviderExtensionCapability,
  isCliExtensionCapabilityMutable,
} from './providerExtensionCapabilities';

import type {
  CliInstallationStatus,
  InstallScope,
  InstalledMcpEntry,
  InstalledPluginEntry,
  PluginCapability,
  PluginCatalogItem,
} from '@shared/types';

/**
 * Normalize a repository URL for dedup comparison.
 * Lowercases, strips `.git` suffix, strips trailing `/`.
 */
export function normalizeRepoUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(
      /* eslint-disable-next-line sonarjs/slow-regex -- trailing slashes only, URL length bounded */
      /\/+$/,
      ''
    );
}

/**
 * Derive UI-visible capability labels from plugin capability flags.
 */
export function inferCapabilities(item: PluginCatalogItem): PluginCapability[] {
  const caps: PluginCapability[] = [];
  if (item.hasLspServers) caps.push('lsp');
  if (item.hasMcpServers) caps.push('mcp');
  if (item.hasAgents) caps.push('agent');
  if (item.hasCommands) caps.push('command');
  if (item.hasHooks) caps.push('hook');
  if (caps.length === 0) caps.push('skill');
  return caps;
}

const CAPABILITY_LABELS: Record<PluginCapability, string> = {
  lsp: 'LSP',
  mcp: 'MCP',
  agent: 'Agent',
  command: 'Command',
  hook: 'Hook',
  skill: 'Skill',
};

/**
 * Get a human-readable label for the primary capability.
 */
export function getPrimaryCapabilityLabel(capabilities: PluginCapability[]): string {
  if (capabilities.length === 0) return 'Skill';
  return CAPABILITY_LABELS[capabilities[0]];
}

/**
 * Get human-readable label for a capability.
 */
export function getCapabilityLabel(capability: PluginCapability): string {
  return CAPABILITY_LABELS[capability];
}

/**
 * Format large install counts for display.
 * 277472 → "277K", 1200000 → "1.2M", 42 → "42"
 */
export function formatInstallCount(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return millions >= 10
      ? `${Math.round(millions)}M`
      : `${millions.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return thousands >= 10
      ? `${Math.round(thousands)}K`
      : `${thousands.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(count);
}

/**
 * Normalize a category string for consistent comparison/display.
 * Lowercases, trims, falls back to "other".
 */
export function normalizeCategory(raw: string | undefined): string {
  if (!raw) return 'other';
  const normalized = raw.trim().toLowerCase();
  return normalized || 'other';
}

/**
 * Build a pluginId (= qualifiedName) from marketplace plugin name + marketplace name.
 */
export function buildPluginId(pluginName: string, marketplaceName: string): string {
  return `${pluginName}@${marketplaceName}`;
}

/**
 * Namespaced operation-state key for plugin install/uninstall UI state.
 */
export function getPluginOperationKey(pluginId: string, scope: InstallScope): string {
  return `plugin:${pluginId}:${scope}`;
}

/**
 * Namespaced operation-state key for MCP install/uninstall UI state.
 */
export function getMcpOperationKey(
  registryId: string,
  scope: InstallScope,
  projectPath?: string | null
): string {
  if (scope === 'project' || scope === 'local') {
    return `mcp:${registryId}:${scope}:${getMcpProjectStateKey(projectPath)}`;
  }
  return `mcp:${registryId}:${scope}`;
}

/**
 * Namespaced lookup key for MCP diagnostics. Scope is included when available
 * so the same server name can coexist across global/project/local installs.
 */
export function getMcpDiagnosticKey(name: string, scope?: string | null): string {
  return scope ? `mcp-diagnostic:${scope}:${name}` : `mcp-diagnostic:${name}`;
}

/**
 * Stable project-aware cache key for MCP installed/diagnostics state.
 */
export function getMcpProjectStateKey(projectPath?: string | null): string {
  return projectPath ?? '__global__';
}

/**
 * Check whether a plugin has an installation for the selected scope.
 */
export function hasInstallationInScope(
  installations: Pick<InstalledPluginEntry, 'scope'>[],
  scope: InstallScope
): boolean {
  return installations.some((installation) => installation.scope === scope);
}

/**
 * Build a concise install-status label for plugin badges.
 */
export function getInstallationSummaryLabel(
  installations: Pick<InstalledPluginEntry, 'scope'>[]
): string | null {
  const scopes = Array.from(new Set(installations.map((installation) => installation.scope)));
  if (scopes.length === 0) {
    return null;
  }

  if (scopes.length > 1) {
    return `Installed in ${scopes.length} scopes`;
  }

  switch (scopes[0]) {
    case 'user':
      return 'Installed globally';
    case 'project':
      return 'Installed in project';
    case 'local':
      return 'Installed locally';
    default:
      return 'Installed';
  }
}

const MCP_SCOPE_PRIORITY: Record<InstalledMcpEntry['scope'], number> = {
  local: 0,
  project: 1,
  global: 2,
  user: 2,
};

/**
 * Pick the MCP installation entry that Claude will actually use.
 * Scope precedence matches Claude Code: local > project > user.
 */
export function getPreferredMcpInstallationEntry(
  installations: InstalledMcpEntry[]
): InstalledMcpEntry | null {
  if (installations.length === 0) {
    return null;
  }

  return [...installations].sort(
    (left, right) => MCP_SCOPE_PRIORITY[left.scope] - MCP_SCOPE_PRIORITY[right.scope]
  )[0]!;
}

/**
 * Build a concise install-status label for MCP badges.
 */
export function getMcpInstallationSummaryLabel(
  installations: Pick<InstalledMcpEntry, 'scope'>[]
): string | null {
  const scopes = Array.from(new Set(installations.map((installation) => installation.scope)));
  if (scopes.length === 0) {
    return null;
  }

  if (scopes.length > 1) {
    return `Installed in ${scopes.length} scopes`;
  }

  switch (scopes[0]) {
    case 'global':
    case 'user':
      return 'Installed globally';
    case 'project':
      return 'Installed in project';
    case 'local':
      return 'Installed locally';
    default:
      return 'Installed';
  }
}

/**
 * Install actions require Claude auth, but uninstall only requires a working CLI.
 */
export function getExtensionActionDisableReason(options: {
  isInstalled: boolean;
  cliStatus: Pick<
    CliInstallationStatus,
    'installed' | 'authLoggedIn' | 'binaryPath' | 'launchError' | 'flavor' | 'providers'
  > | null;
  cliStatusLoading: boolean;
  section?: 'plugins' | 'mcp';
}): string | null {
  const { isInstalled, cliStatus, cliStatusLoading, section = 'plugins' } = options;
  if (cliStatusLoading) {
    return 'Checking runtime status...';
  }

  if (cliStatus === null) {
    return 'Checking runtime availability...';
  }

  if (cliStatus.installed === false) {
    if (cliStatus.binaryPath && cliStatus.launchError) {
      return 'The configured runtime was found but failed to start. Open the Dashboard to repair or reinstall it.';
    }
    return 'The configured runtime is required. Install or repair it from the Dashboard.';
  }

  const providers = cliStatus.providers ?? [];
  const isMultimodel = cliStatus.flavor === 'agent_teams_orchestrator' && providers.length > 0;

  if (section === 'mcp') {
    if (!isMultimodel) {
      return null;
    }

    const mutableProviders = providers.filter((provider) =>
      isCliExtensionCapabilityMutable(getCliProviderExtensionCapability(provider, 'mcp'))
    );
    if (mutableProviders.length > 0) {
      return null;
    }

    const reason = providers
      .map((provider) => getCliProviderExtensionCapability(provider, 'mcp').reason)
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);

    return reason ?? 'MCP management is not supported by the current runtime.';
  }

  if (!isMultimodel) {
    if (!isInstalled && !cliStatus.authLoggedIn) {
      return 'Claude CLI is installed but not signed in. Open the Dashboard to sign in.';
    }
    return null;
  }

  const pluginProviders = providers.filter((provider) =>
    isCliExtensionCapabilityMutable(getCliProviderExtensionCapability(provider, 'plugins'))
  );

  if (pluginProviders.length === 0) {
    const reason = providers
      .map((provider) => getCliProviderExtensionCapability(provider, 'plugins').reason)
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return reason ?? 'Plugin installs are not supported by the current runtime.';
  }

  if (isInstalled) {
    return null;
  }

  const authenticatedProvider = pluginProviders.find((provider) => provider.authenticated);
  if (!authenticatedProvider) {
    return `${pluginProviders[0]?.displayName ?? 'Anthropic'} is not connected. Open the Dashboard to sign in.`;
  }

  return null;
}

/**
 * Sanitize an MCP server display name into a CLI-safe server name.
 * Must match the regex /^[\w.-]{1,100}$/ required by McpInstallService.
 */
export function sanitizeMcpServerName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w.-]/g, '');
}

/**
 * Extract owner/repo from a GitHub URL. Returns null for non-GitHub URLs.
 * Handles: https://github.com/owner/repo, https://github.com/owner/repo.git, trailing slashes.
 */
export function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return null;
    const parts = parsed.pathname
      .replace(/^\//, '')
      .replace(/\.git$/, '')
      .replace(
        /* eslint-disable-next-line sonarjs/slow-regex -- trailing slashes only, pathname bounded */
        /\/+$/,
        ''
      )
      .split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}
