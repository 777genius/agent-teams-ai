/**
 * Per-tab UI state hook for the Extension Store view.
 * Each Extensions tab instance gets its own independent state.
 * Global catalog caches are in extensionsSlice (Zustand).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type {
  McpCatalogItem,
  McpSearchResult,
  PluginCapability,
  PluginFilters,
  PluginSortField,
} from '@shared/types/extensions';

export type ExtensionsSubTab = 'plugins' | 'mcp-servers' | 'skills' | 'api-keys';
export type SkillsSortState = 'name-asc' | 'recent-desc';

interface PluginSortState {
  field: PluginSortField;
  order: 'asc' | 'desc';
}

const DEFAULT_FILTERS: PluginFilters = {
  search: '',
  categories: [],
  capabilities: [],
  installedOnly: false,
};

export function useExtensionsTabState() {
  // ── Sub-tab navigation ──
  const [activeSubTab, setActiveSubTab] = useState<ExtensionsSubTab>('plugins');

  // ── Plugin filters & sort ──
  const [pluginFilters, setPluginFilters] = useState<PluginFilters>(DEFAULT_FILTERS);
  const [pluginSort, setPluginSort] = useState<PluginSortState>({
    field: 'popularity',
    order: 'desc',
  });
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);

  // ── MCP search (per-tab, calls API directly) ──
  const [mcpSearchQuery, setMcpSearchQuery] = useState('');
  const [mcpSearchResults, setMcpSearchResults] = useState<McpCatalogItem[]>([]);
  const [mcpSearchLoading, setMcpSearchLoading] = useState(false);
  const [mcpSearchWarnings, setMcpSearchWarnings] = useState<string[]>([]);
  const [selectedMcpServerId, setSelectedMcpServerId] = useState<string | null>(null);

  // ── Skills browse ──
  const [skillsSearchQuery, setSkillsSearchQuery] = useState('');
  const [skillsInstalledOnly] = useState(false);
  const [skillsSort, setSkillsSort] = useState<SkillsSortState>('name-asc');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);

  // ── Debounced MCP search ──
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, []);

  const mcpSearch = useCallback((query: string) => {
    setMcpSearchQuery(query);

    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }

    if (!query.trim()) {
      setMcpSearchResults([]);
      setMcpSearchWarnings([]);
      setMcpSearchLoading(false);
      return;
    }

    setMcpSearchLoading(true);

    searchTimerRef.current = setTimeout(() => {
      if (!api.mcpRegistry) {
        setMcpSearchLoading(false);
        return;
      }

      void api.mcpRegistry.search(query).then(
        (result: McpSearchResult) => {
          setMcpSearchResults(result.servers);
          setMcpSearchWarnings(result.warnings);
          setMcpSearchLoading(false);
        },
        () => {
          setMcpSearchLoading(false);
          setMcpSearchWarnings(['Search failed']);
        }
      );
    }, 300);
  }, []);

  // ── Plugin filter helpers ──
  const updatePluginSearch = useCallback((search: string) => {
    setPluginFilters((prev) => ({ ...prev, search }));
  }, []);

  const toggleCategory = useCallback((category: string) => {
    setPluginFilters((prev) => ({
      ...prev,
      categories: prev.categories.includes(category)
        ? prev.categories.filter((c) => c !== category)
        : [...prev.categories, category],
    }));
  }, []);

  const toggleCapability = useCallback((capability: PluginCapability) => {
    setPluginFilters((prev) => ({
      ...prev,
      capabilities: prev.capabilities.includes(capability)
        ? prev.capabilities.filter((c) => c !== capability)
        : [...prev.capabilities, capability],
    }));
  }, []);

  const toggleInstalledOnly = useCallback(() => {
    setPluginFilters((prev) => ({ ...prev, installedOnly: !prev.installedOnly }));
  }, []);

  const clearFilters = useCallback(() => {
    setPluginFilters(DEFAULT_FILTERS);
  }, []);

  const hasActiveFilters = useMemo(
    () =>
      pluginFilters.search !== '' ||
      pluginFilters.categories.length > 0 ||
      pluginFilters.capabilities.length > 0 ||
      pluginFilters.installedOnly,
    [pluginFilters]
  );

  return {
    // Sub-tab
    activeSubTab,
    setActiveSubTab,

    // Plugins
    pluginFilters,
    pluginSort,
    setPluginSort,
    selectedPluginId,
    setSelectedPluginId,
    updatePluginSearch,
    toggleCategory,
    toggleCapability,
    toggleInstalledOnly,
    clearFilters,
    hasActiveFilters,

    // MCP
    mcpSearchQuery,
    mcpSearch,
    mcpSearchResults,
    mcpSearchLoading,
    mcpSearchWarnings,
    selectedMcpServerId,
    setSelectedMcpServerId,

    // Skills
    skillsSearchQuery,
    setSkillsSearchQuery,
    skillsInstalledOnly,
    skillsSort,
    setSkillsSort,
    selectedSkillId,
    setSelectedSkillId,
  };
}
