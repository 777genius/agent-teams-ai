/**
 * PluginsPanel — search, filter, sort and browse the plugin catalog.
 */

import { useMemo } from 'react';

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
import { Puzzle, Search } from 'lucide-react';

import { SearchInput } from '../common/SearchInput';

import { CapabilityChips } from './CapabilityChips';
import { CategoryChips } from './CategoryChips';
import { PluginCard } from './PluginCard';
import { PluginDetailDialog } from './PluginDetailDialog';

import type {
  EnrichedPlugin,
  PluginCapability,
  PluginFilters,
  PluginSortField,
} from '@shared/types/extensions';

interface PluginsPanelProps {
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
        return (b.installCount - a.installCount) * direction;
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
}: PluginsPanelProps): React.JSX.Element => {
  const catalog = useStore((s) => s.pluginCatalog);
  const loading = useStore((s) => s.pluginCatalogLoading);
  const error = useStore((s) => s.pluginCatalogError);

  const filtered = useMemo(
    () => selectFilteredPlugins(catalog, pluginFilters, pluginSort),
    [catalog, pluginFilters, pluginSort]
  );

  const selectedPlugin = useMemo(
    () =>
      selectedPluginId ? (catalog.find((p) => p.pluginId === selectedPluginId) ?? null) : null,
    [catalog, selectedPluginId]
  );

  const sortValue = `${pluginSort.field}:${pluginSort.order}`;

  return (
    <div className="flex flex-col gap-4">
      {/* Search + Sort + Installed only row */}
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <SearchInput
            value={pluginFilters.search}
            onChange={updatePluginSearch}
            placeholder="Search plugins..."
          />
        </div>
        <Select
          value={sortValue}
          onValueChange={(v) => {
            const [field, order] = v.split(':') as [PluginSortField, 'asc' | 'desc'];
            setPluginSort({ field, order });
          }}
        >
          <SelectTrigger className="w-36">
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
        <div className="flex items-center gap-2">
          <Checkbox
            id="installed-only"
            checked={pluginFilters.installedOnly}
            onCheckedChange={toggleInstalledOnly}
          />
          <Label htmlFor="installed-only" className="whitespace-nowrap text-xs text-text-secondary">
            Installed only
          </Label>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-surface-raised/50 rounded-md border border-border p-3">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Categories
            </span>
            {hasActiveFilters && (
              <Button
                variant="link"
                size="sm"
                onClick={clearFilters}
                className="h-auto p-0 text-xs text-[var(--color-accent)]"
              >
                Clear all
              </Button>
            )}
          </div>
          <CategoryChips
            plugins={catalog}
            selected={pluginFilters.categories}
            onToggle={toggleCategory}
          />
          <div className="border-b border-border" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Capabilities
          </span>
          <CapabilityChips
            plugins={catalog}
            selected={pluginFilters.capabilities}
            onToggle={toggleCapability}
          />
        </div>
      </div>

      {/* Result count */}
      {!loading && !error && filtered.length > 0 && (
        <p className="text-xs text-text-muted">
          {filtered.length} plugin{filtered.length !== 1 ? 's' : ''}
        </p>
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((plugin) => (
            <PluginCard key={plugin.pluginId} plugin={plugin} onClick={setSelectedPluginId} />
          ))}
        </div>
      )}

      {/* Detail dialog */}
      <PluginDetailDialog
        plugin={selectedPlugin}
        open={selectedPluginId !== null}
        onClose={() => setSelectedPluginId(null)}
      />
    </div>
  );
};
