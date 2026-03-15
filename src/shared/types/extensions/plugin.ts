/**
 * Plugin domain types — catalog items, installed state, enriched plugins, filters.
 */

import type { InstallScope } from './common';

// ── Catalog item (read from marketplace.json) ──────────────────────────────

export interface PluginCatalogItem {
  // Identity
  pluginId: string; // canonical key = qualifiedName for V1 (<name>@<marketplace>)
  marketplaceId: string; // = qualifiedName in V1
  qualifiedName: string; // CLI install target, resolved by main
  name: string; // display name only

  // Metadata
  source: 'official';
  description: string;
  category: string; // open-ended string, derived from marketplace.json
  author?: { name: string; email?: string };
  version?: string;
  homepage?: string;
  tags?: string[]; // not present in current marketplace, future-proofing

  // Capability flags (derived from marketplace.json plugin structure)
  hasLspServers: boolean;
  hasMcpServers: boolean;
  hasAgents: boolean;
  hasCommands: boolean;
  hasHooks: boolean;
  isExternal: boolean; // source is object with URL (not local path)
}

// ── Installed state ────────────────────────────────────────────────────────

export interface InstalledPluginEntry {
  pluginId: string; // matches PluginCatalogItem.pluginId
  scope: InstallScope;
  version?: string;
  installedAt?: string;
  installPath?: string;
}

// ── Enriched (catalog + installed + counts, for renderer) ──────────────────

export interface EnrichedPlugin extends PluginCatalogItem {
  installCount: number;
  isInstalled: boolean;
  installations: InstalledPluginEntry[];
}

// ── Capabilities ───────────────────────────────────────────────────────────

export type PluginCapability = 'lsp' | 'mcp' | 'agent' | 'command' | 'hook' | 'skill';

/** Derive display capabilities from flag fields */
export function inferCapabilities(item: PluginCatalogItem): PluginCapability[] {
  const caps: PluginCapability[] = [];
  if (item.hasLspServers) caps.push('lsp');
  if (item.hasMcpServers) caps.push('mcp');
  if (item.hasAgents) caps.push('agent');
  if (item.hasCommands) caps.push('command');
  if (item.hasHooks) caps.push('hook');
  if (caps.length === 0) caps.push('skill'); // fallback
  return caps;
}

// ── Install request (renderer → main) ──────────────────────────────────────

export interface PluginInstallRequest {
  pluginId: string; // canonical key — main resolves qualifiedName from catalog
  scope: InstallScope;
  projectPath?: string; // required for 'project' scope
}

// ── Filters (renderer-only concern) ────────────────────────────────────────

export interface PluginFilters {
  search: string;
  categories: string[];
  capabilities: PluginCapability[];
  installedOnly: boolean;
}

export type PluginSortField = 'popularity' | 'name' | 'category';
