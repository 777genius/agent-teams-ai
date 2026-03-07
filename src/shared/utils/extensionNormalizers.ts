/**
 * Pure-function normalizers for Extension Store data.
 */

import type { PluginCapability, PluginCatalogItem } from '@shared/types/extensions';

/**
 * Normalize a repository URL for dedup comparison.
 * Lowercases, strips `.git` suffix, strips trailing `/`.
 */
export function normalizeRepoUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
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
