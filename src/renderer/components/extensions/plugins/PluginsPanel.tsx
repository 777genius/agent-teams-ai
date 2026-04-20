/**
 * PluginsPanel — search, filter, sort and browse the plugin catalog.
 */

import { useEffect, useMemo } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useStore } from '@renderer/store';
import { inferCapabilities, normalizeCategory } from '@shared/utils/extensionNormalizers';
import { getCliProviderExtensionCapability } from '@shared/utils/providerExtensionCapabilities';
import { ArrowUpDown, Filter, Puzzle, Search } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { SearchInput } from '../common/SearchInput';

import { CapabilityChips } from './CapabilityChips';
import { CategoryChips } from './CategoryChips';
import { PluginCard } from './PluginCard';
import { PluginDetailDialog } from './PluginDetailDialog';

import type { CliInstallationStatus } from '@shared/types';
import type {
  EnrichedPlugin,
  PluginCapability,
  PluginFilters,
  PluginSortField,
} from '@shared/types/extensions';

interface PluginsPanelProps {
  projectPath: string | null;
  pluginFilters: PluginFilters;
  pluginSort: { field: PluginSortField; order: 'asc' | 'desc' };
  selectedPluginId: string | null;
  updatePluginSearch: (search: string) => void;
  toggleCategory: (category: string) => void;
  toggleCapability: (capability: PluginCapability) => void;
  toggleInstalledOnly: () => void;
  setSelectedPluginId: (id: string | null) => void;
  clearFilters: () => void;
  hasActiveFilters: boolean;
  setPluginSort: (sort: { field: PluginSortField; order: 'asc' | 'desc' }) => void;
  cliStatus?: Pick<
    CliInstallationStatus,
    'installed' | 'authLoggedIn' | 'binaryPath' | 'launchError' | 'flavor' | 'providers'
  > | null;
  cliStatusLoading?: boolean;
}

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'popularity:desc', label: 'Popular' },
  { value: 'name:asc', label: 'Name A-Z' },
  { value: 'name:desc', label: 'Name Z-A' },
  { value: 'category:asc', label: 'Category' },
];

/** Pure function: filter + sort the catalog */
function selectFilteredPlugins(
  catalog: EnrichedPlugin[],
  filters: PluginFilters,
  sort: { field: PluginSortField; order: 'asc' | 'desc' }
): EnrichedPlugin[] {
  let result = catalog;

  // Search
  if (filters.search) {
    const q = filters.search.toLowerCase();
    result = result.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.pluginId.toLowerCase().includes(q)
    );
  }

  // Categories
  if (filters.categories.length > 0) {
    result = result.filter((p) => filters.categories.includes(normalizeCategory(p.category)));
  }

  // Capabilities
  if (filters.capabilities.length > 0) {
    result = result.filter((p) => {
      const caps = inferCapabilities(p);
      return filters.capabilities.some((fc) => caps.includes(fc));
    });
  }

  // Installed only
  if (filters.installedOnly) {
    result = result.filter((p) => p.isInstalled);
  }

  // Sort
  const direction = sort.order === 'asc' ? 1 : -1;
  result = [...result].sort((a, b) => {
    switch (sort.field) {
      case 'popularity':
        return (a.installCount - b.installCount) * direction;
      case 'name':
        return a.name.localeCompare(b.name) * direction;
      case 'category':
        return a.category.localeCompare(b.category) * direction;
      default:
        return 0;
    }
  });

  return result;
}

export const PluginsPanel = ({
  projectPath,
  pluginFilters,
  pluginSort,
  selectedPluginId,
  updatePluginSearch,
  toggleCategory,
  toggleCapability,
  toggleInstalledOnly,
  setSelectedPluginId,
  clearFilters,
  hasActiveFilters,
  setPluginSort,
  cliStatus: cliStatusOverride,
  cliStatusLoading,
}: PluginsPanelProps): React.JSX.Element => {
  const {
    catalog,
    loading,
    error,
    cliStatus: storedCliStatus,
  } = useStore(
    useShallow((s) => ({
      catalog: s.pluginCatalog,
      loading: s.pluginCatalogLoading,
      error: s.pluginCatalogError,
      cliStatus: s.cliStatus,
    }))
  );
  const cliStatus = cliStatusOverride ?? storedCliStatus;

  const filtered = useMemo(
    () => selectFilteredPlugins(catalog, pluginFilters, pluginSort),
    [catalog, pluginFilters, pluginSort]
  );

  const selectedPlugin = useMemo(
    () =>
      selectedPluginId ? (catalog.find((p) => p.pluginId === selectedPluginId) ?? null) : null,
    [catalog, selectedPluginId]
  );

  useEffect(() => {
    if (selectedPluginId && !loading && !selectedPlugin) {
      setSelectedPluginId(null);
    }
  }, [loading, selectedPlugin, selectedPluginId, setSelectedPluginId]);

  useEffect(() => {
    if (error && selectedPluginId) {
      setSelectedPluginId(null);
    }
  }, [error, selectedPluginId, setSelectedPluginId]);

  const sortValue = `${pluginSort.field}:${pluginSort.order}`;
  const activeFilterCount =
    pluginFilters.categories.length +
    pluginFilters.capabilities.length +
    (pluginFilters.installedOnly ? 1 : 0) +
    (pluginFilters.search ? 1 : 0);
  const totalCategoryCount = useMemo(
    () => new Set(catalog.map((plugin) => normalizeCategory(plugin.category))).size,
    [catalog]
  );
  const totalCapabilityCount = useMemo(() => {
    const counts = new Set<PluginCapability>();
    for (const plugin of catalog) {
      for (const capability of inferCapabilities(plugin)) {
        counts.add(capability);
      }
    }
    return counts.size;
  }, [catalog]);
  return (
    <div className="flex flex-col gap-4">
      {cliStatus?.flavor === 'agent_teams_orchestrator' &&
        (() => {
          const codexProvider = cliStatus.providers.find(
            (provider) => provider.providerId === 'codex'
          );
          if (!codexProvider) return null;
          const capability = getCliProviderExtensionCapability(codexProvider, 'plugins');
          if (capability.status === 'supported') {
            return null;
          }

          return (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
              In the multimodel runtime, plugins are currently guaranteed only for Anthropic
              sessions. We are actively building broader plugin support for all agents, including
              both universal plugins and agent-specific plugins.
              {capability.reason ? ` ${capability.reason}` : ''}
            </div>
          );
        })()}
      {/* Search + Sort + Installed only row */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex-1">
          <SearchInput
            value={pluginFilters.search}
            onChange={updatePluginSearch}
            placeholder="Search plugins..."
          />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Select
            value={sortValue}
            onValueChange={(v) => {
              const [field, order] = v.split(':') as [PluginSortField, 'asc' | 'desc'];
              setPluginSort({ field, order });
            }}
          >
            <SelectTrigger className="w-full gap-2 sm:w-40">
              <ArrowUpDown className="size-3.5 shrink-0 text-text-muted" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label
            htmlFor="installed-only"
            className="bg-surface-raised/40 flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-xs text-text-secondary transition-colors hover:border-border-emphasis hover:text-text"
          >
            <Checkbox
              id="installed-only"
              checked={pluginFilters.installedOnly}
              onCheckedChange={toggleInstalledOnly}
            />
            Installed only
          </Label>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-surface-raised/20 rounded-xl p-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="bg-surface-raised/60 flex size-8 items-center justify-center rounded-lg border border-border">
                  <Filter className="size-4 text-text-muted" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-text">Browse by fit</h2>
                    <Badge variant="outline" className="text-[11px] text-text-muted">
                      {activeFilterCount} active
                    </Badge>
                  </div>
                  <p className="text-xs text-text-muted">
                    Narrow the catalog by category, capability, or installed state.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px] text-text-muted">
                <Badge variant="secondary" className="font-normal">
                  {catalog.length} plugins
                </Badge>
                <Badge variant="secondary" className="font-normal">
                  {totalCategoryCount} categories
                </Badge>
                <Badge variant="secondary" className="font-normal">
                  {totalCapabilityCount} capabilities
                </Badge>
              </div>
            </div>
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="justify-start rounded-lg border border-border px-3 text-xs text-text-secondary hover:text-text lg:justify-center"
              >
                Clear all filters
              </Button>
            )}
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-transparent">
            <div className="grid gap-0 xl:grid-cols-2">
              <section className="space-y-3 p-3 xl:border-r xl:border-border">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">
                    Categories
                  </span>
                  <span className="text-[11px] text-text-muted">
                    {pluginFilters.categories.length} selected
                  </span>
                </div>
                <CategoryChips
                  plugins={catalog}
                  selected={pluginFilters.categories}
                  onToggle={toggleCategory}
                />
              </section>

              <section className="space-y-3 border-t border-border p-3 xl:border-t-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">
                    Capabilities
                  </span>
                  <span className="text-[11px] text-text-muted">
                    {pluginFilters.capabilities.length} selected
                  </span>
                </div>
                <CapabilityChips
                  plugins={catalog}
                  selected={pluginFilters.capabilities}
                  onToggle={toggleCapability}
                />
              </section>
            </div>
          </div>
        </div>
      </div>

      {/* Result count */}
      {!loading && !error && filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-text-muted">
            Showing {filtered.length} of {catalog.length} plugin{catalog.length !== 1 ? 's' : ''}
          </p>
          {hasActiveFilters && (
            <p className="text-xs text-text-muted">
              Results update instantly as you refine filters.
            </p>
          )}
        </div>
      )}

      {/* Content */}
      {loading && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className="skeleton-card flex flex-col gap-2 rounded-lg border border-border p-4"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="h-4 w-32 rounded bg-surface-raised" />
                <div className="h-5 w-16 rounded-full bg-surface-raised" />
              </div>
              <div className="space-y-1.5">
                <div className="h-3 w-full rounded bg-surface-raised" />
                <div className="h-3 w-3/4 rounded bg-surface-raised" />
              </div>
              <div className="flex gap-1.5">
                <div className="h-5 w-14 rounded-full bg-surface-raised" />
                <div className="h-5 w-12 rounded-full bg-surface-raised" />
              </div>
              <div className="flex items-center justify-between">
                <div className="h-3 w-24 rounded bg-surface-raised" />
                <div className="h-7 w-16 rounded bg-surface-raised" />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-sm border border-dashed border-border px-8 py-16">
          <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface-raised">
            {hasActiveFilters ? (
              <Search className="size-5 text-text-muted" />
            ) : (
              <Puzzle className="size-5 text-text-muted" />
            )}
          </div>
          <p className="text-sm text-text-secondary">
            {hasActiveFilters ? 'No plugins match your filters' : 'No plugins available'}
          </p>
          <p className="text-xs text-text-muted">
            {hasActiveFilters
              ? 'Try adjusting your search or filter criteria'
              : 'Check back later for new plugins'}
          </p>
          {hasActiveFilters && (
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="plugins-grid grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((plugin, index) => (
            <PluginCard
              key={plugin.pluginId}
              plugin={plugin}
              index={index}
              onClick={setSelectedPluginId}
              cliStatus={cliStatus}
              cliStatusLoading={cliStatusLoading}
            />
          ))}
        </div>
      )}

      {/* Detail dialog */}
      <PluginDetailDialog
        plugin={selectedPlugin}
        open={selectedPluginId !== null}
        onClose={() => setSelectedPluginId(null)}
        projectPath={projectPath}
        cliStatus={cliStatus}
        cliStatusLoading={cliStatusLoading}
      />
    </div>
  );
};
