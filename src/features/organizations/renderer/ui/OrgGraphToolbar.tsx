import { useEffect, useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Eye,
  EyeOff,
  Map,
  Maximize2,
  RotateCcw,
  Search,
  SlidersHorizontal,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import type { GraphControlRenderProps } from '@claude-teams/agent-graph';

type ViewMode = 'overview' | 'hierarchy' | 'structure' | 'relations';

interface OrgGraphToolbarProps extends GraphControlRenderProps {
  activeViewMode: ViewMode;
  viewModes: readonly { mode: ViewMode; label: string }[];
  isSearchOpen: boolean;
  isMinimapVisible: boolean;
  canReset: boolean;
  onViewModeChange: (mode: ViewMode) => void;
  onSearchToggle: () => void;
  onMinimapToggle: () => void;
  onReset: () => void;
  labels: {
    search: string;
    filters: string;
    fit: string;
    minimap: string;
    reset: string;
    tasks: string;
    connections: string;
    animation: string;
  };
}

export function OrgGraphToolbar({
  activeViewMode,
  viewModes,
  isSearchOpen,
  isMinimapVisible,
  canReset,
  filters,
  onFiltersChange,
  onViewModeChange,
  onSearchToggle,
  onMinimapToggle,
  onReset,
  onZoomIn,
  onZoomOut,
  onZoomToFit,
  labels,
}: Readonly<OrgGraphToolbarProps>): React.JSX.Element {
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);
  const activeFilterCount = Number(!filters.showTasks) + Number(!filters.showEdges);

  useEffect(() => {
    if (!isFiltersOpen) return undefined;
    const close = (event: MouseEvent): void => {
      if (!filtersRef.current?.contains(event.target as Node | null)) setIsFiltersOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [isFiltersOpen]);

  const iconButtonClass =
    'relative flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-white/[0.07] hover:text-[var(--color-text)]';

  return (
    <div className="pointer-events-none absolute inset-x-3 top-3 z-30 flex justify-center">
      <div className="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-1 rounded-xl border border-sky-300/15 bg-[color-mix(in_srgb,var(--color-surface-overlay)_94%,transparent)] p-1 shadow-xl shadow-black/25 backdrop-blur-xl">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={labels.search}
          aria-pressed={isSearchOpen}
          title={labels.search}
          className={`${iconButtonClass} ${isSearchOpen ? 'bg-sky-400/15 text-sky-100' : ''}`}
          onClick={onSearchToggle}
        >
          <Search size={14} />
        </Button>

        <span className="mx-0.5 h-5 w-px bg-white/10" />
        <div className="flex min-w-0 items-center rounded-lg bg-black/15 p-0.5">
          {viewModes.map(({ mode, label }) => (
            <Button
              key={mode}
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={activeViewMode === mode}
              data-organization-map-view-mode={mode}
              className={`h-7 rounded-md px-3 text-[11px] font-medium transition-colors ${
                activeViewMode === mode
                  ? 'bg-sky-400/15 text-sky-50 shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text)]'
              }`}
              onClick={() => onViewModeChange(mode)}
            >
              {label}
            </Button>
          ))}
        </div>

        <span className="mx-0.5 h-5 w-px bg-white/10" />
        <div ref={filtersRef} className="relative">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={labels.filters}
            aria-expanded={isFiltersOpen}
            title={labels.filters}
            className={`${iconButtonClass} ${isFiltersOpen ? 'bg-sky-400/15 text-sky-100' : ''}`}
            onClick={() => setIsFiltersOpen((value) => !value)}
          >
            <SlidersHorizontal size={14} />
            {activeFilterCount > 0 ? (
              <span className="absolute right-0.5 top-0.5 flex size-3.5 items-center justify-center rounded-full bg-sky-400 text-[8px] font-bold text-slate-950">
                {activeFilterCount}
              </span>
            ) : null}
          </Button>
          {isFiltersOpen ? (
            <div className="absolute right-0 top-[calc(100%+0.55rem)] w-48 rounded-xl border border-sky-300/15 bg-[var(--color-surface-overlay)] p-1.5 shadow-2xl shadow-black/40">
              {[
                {
                  label: labels.tasks,
                  active: filters.showTasks,
                  toggle: () => onFiltersChange({ ...filters, showTasks: !filters.showTasks }),
                },
                {
                  label: labels.connections,
                  active: filters.showEdges,
                  toggle: () => onFiltersChange({ ...filters, showEdges: !filters.showEdges }),
                },
                {
                  label: labels.animation,
                  active: !filters.paused,
                  toggle: () => onFiltersChange({ ...filters, paused: !filters.paused }),
                },
              ].map((item) => (
                <Button
                  key={item.label}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-full justify-start gap-2 rounded-lg px-2 text-xs text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text)]"
                  onClick={item.toggle}
                >
                  {item.active ? <Eye size={13} /> : <EyeOff size={13} />}
                  {item.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={labels.fit}
          aria-label={labels.fit}
          className={iconButtonClass}
          onClick={onZoomToFit}
        >
          <Maximize2 size={14} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={labels.minimap}
          aria-label={labels.minimap}
          aria-pressed={isMinimapVisible}
          className={`${iconButtonClass} ${isMinimapVisible ? 'bg-sky-400/12 text-sky-100' : ''}`}
          onClick={onMinimapToggle}
        >
          <Map size={14} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={labels.reset}
          aria-label={labels.reset}
          disabled={!canReset}
          className={iconButtonClass}
          onClick={onReset}
        >
          <RotateCcw size={14} />
        </Button>
        <span className="mx-0.5 hidden h-5 w-px bg-white/10 lg:block" />
        <div className="hidden items-center lg:flex">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom out"
            className={iconButtonClass}
            onClick={onZoomOut}
          >
            <ZoomOut size={13} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom in"
            className={iconButtonClass}
            onClick={onZoomIn}
          >
            <ZoomIn size={13} />
          </Button>
        </div>
      </div>
    </div>
  );
}
