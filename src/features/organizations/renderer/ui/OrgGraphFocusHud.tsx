import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { ChevronDown, ChevronRight, Focus, Network, Route, Search, Users, X } from 'lucide-react';

import {
  getOrganizationNodePath,
  searchOrganizationNodes,
} from '../adapters/organizationGraphFocus';
import { getNodeDisplayLabel } from '../adapters/organizationMapViewModel';

import type { OrganizationGraphFocusMode } from '../adapters/organizationGraphFocus';
import type { OrganizationMapViewModel } from '../adapters/organizationMapViewModel';

interface OrgGraphFocusHudProps {
  viewModel: OrganizationMapViewModel;
  selectedNodeId: string | null;
  focusMode: OrganizationGraphFocusMode;
  connectedTeamCount: number;
  collapsedNodeIds: ReadonlySet<string>;
  onFocusModeChange: (mode: OrganizationGraphFocusMode) => void;
  onSelectNode: (nodeId: string | null, reveal?: boolean) => void;
  onToggleNodeCollapse: (nodeId: string) => void;
}

const SEARCH_RESULTS_ID = 'organization-map-search-results';
const SEARCH_PANEL_ID = 'organization-map-search-panel';

export const OrgGraphFocusHud = ({
  viewModel,
  selectedNodeId,
  focusMode,
  connectedTeamCount,
  collapsedNodeIds,
  onFocusModeChange,
  onSelectNode,
  onToggleNodeCollapse,
}: OrgGraphFocusHudProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [query, setQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isResultsOpen, setIsResultsOpen] = useState(false);
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResults = useMemo(
    () => searchOrganizationNodes(viewModel, query),
    [query, viewModel]
  );
  const selectedNode = selectedNodeId ? viewModel.nodeById.get(selectedNodeId) : undefined;
  const selectedPath = useMemo(
    () => getOrganizationNodePath(viewModel, selectedNodeId),
    [selectedNodeId, viewModel]
  );
  const selectedChildCount = selectedNode
    ? (viewModel.childNodeIdsByParentId.get(selectedNode.id)?.length ?? 0)
    : 0;
  const canToggleCollapse = Boolean(
    selectedNode && selectedNode.id !== viewModel.rootNode?.id && selectedChildCount > 0
  );

  useEffect(() => {
    setActiveResultIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isSearchOpen) {
      return undefined;
    }
    const frameId = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [isSearchOpen]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      if (!panelRef.current?.contains(event.target as Node | null)) {
        setIsResultsOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, []);

  const selectSearchResult = (nodeId: string): void => {
    onFocusModeChange('context');
    onSelectNode(nodeId, true);
    setQuery('');
    setIsSearchOpen(false);
    setIsResultsOpen(false);
  };

  const toggleSearch = (): void => {
    setIsSearchOpen((isOpen) => {
      const nextIsOpen = !isOpen;
      setIsResultsOpen(nextIsOpen && query.trim().length > 0);
      return nextIsOpen;
    });
  };

  const toggleFocusMode = (mode: Exclude<OrganizationGraphFocusMode, 'context'>): void => {
    onFocusModeChange(focusMode === mode ? 'context' : mode);
  };

  return (
    <div
      ref={panelRef}
      className="pointer-events-none absolute left-3 top-3 z-20 w-[min(430px,calc(100%-1.5rem))]"
    >
      <Button
        variant="ghost"
        size="icon"
        type="button"
        aria-label={t('organizations.graph.focus.searchLabel')}
        aria-controls={SEARCH_PANEL_ID}
        aria-expanded={isSearchOpen}
        title={t('organizations.graph.focus.searchLabel')}
        className={`pointer-events-auto flex size-[25px] items-center justify-center rounded-md border backdrop-blur-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/60 ${
          isSearchOpen
            ? 'border-[rgba(100,200,255,0.18)] bg-[rgba(100,200,255,0.14)] text-[#aaeeff]'
            : 'border-[rgba(100,200,255,0.08)] bg-[rgba(8,12,24,0.8)] text-[#66ccff90] hover:bg-[rgba(100,200,255,0.1)] hover:text-[#aaeeff]'
        }`}
        onClick={toggleSearch}
      >
        <Search size={10} />
      </Button>

      {isSearchOpen ? (
        <div
          id={SEARCH_PANEL_ID}
          className="pointer-events-auto mt-2 rounded-xl border border-sky-300/15 bg-[color-mix(in_srgb,var(--color-surface-overlay)_94%,transparent)] p-2 shadow-2xl shadow-black/30 backdrop-blur-xl"
        >
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              ref={searchInputRef}
              type="search"
              role="combobox"
              aria-label={t('organizations.graph.focus.searchLabel')}
              aria-controls={SEARCH_RESULTS_ID}
              aria-expanded={isResultsOpen && query.trim().length > 0}
              aria-autocomplete="list"
              aria-activedescendant={
                isResultsOpen && searchResults[activeResultIndex]
                  ? `${SEARCH_RESULTS_ID}-${activeResultIndex}`
                  : undefined
              }
              value={query}
              placeholder={t('organizations.graph.focus.searchPlaceholder')}
              className="h-8 w-full rounded-lg border border-white/10 bg-black/20 pl-8 pr-8 text-xs text-[var(--color-text)] outline-none transition-colors placeholder:text-[var(--color-text-muted)] focus:border-sky-300/40 focus:ring-2 focus:ring-sky-400/10"
              onFocus={() => setIsResultsOpen(true)}
              onChange={(event) => {
                setQuery(event.target.value);
                setIsResultsOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && searchResults.length > 0) {
                  event.preventDefault();
                  setActiveResultIndex((current) => (current + 1) % searchResults.length);
                } else if (event.key === 'ArrowUp' && searchResults.length > 0) {
                  event.preventDefault();
                  setActiveResultIndex(
                    (current) => (current - 1 + searchResults.length) % searchResults.length
                  );
                } else if (event.key === 'Enter' && searchResults[activeResultIndex]) {
                  event.preventDefault();
                  selectSearchResult(searchResults[activeResultIndex].nodeId);
                } else if (event.key === 'Escape') {
                  setQuery('');
                  setIsSearchOpen(false);
                  setIsResultsOpen(false);
                }
              }}
            />
            {query ? (
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label={t('organizations.graph.focus.clearSearch')}
                className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text)]"
                onClick={() => {
                  setQuery('');
                  setIsResultsOpen(false);
                  searchInputRef.current?.focus();
                }}
              >
                <X size={13} />
              </Button>
            ) : null}

            {isResultsOpen && query.trim() ? (
              <div
                id={SEARCH_RESULTS_ID}
                role="listbox"
                className="absolute inset-x-0 top-[calc(100%+0.4rem)] z-30 max-h-72 overflow-y-auto rounded-lg border border-sky-300/15 bg-[var(--color-surface-overlay)] p-1 shadow-2xl shadow-black/50"
              >
                {searchResults.length > 0 ? (
                  searchResults.map((result, index) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      id={`${SEARCH_RESULTS_ID}-${index}`}
                      key={result.nodeId}
                      type="button"
                      role="option"
                      aria-selected={activeResultIndex === index}
                      className={`h-auto w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                        activeResultIndex === index
                          ? 'bg-sky-400/15 text-sky-50'
                          : 'text-[var(--color-text)] hover:bg-white/5'
                      }`}
                      onMouseEnter={() => setActiveResultIndex(index)}
                      onClick={() => selectSearchResult(result.nodeId)}
                    >
                      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-white/5 text-sky-200">
                        {result.kind === 'team' ? <Users size={12} /> : <Network size={12} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{result.label}</span>
                        <span className="mt-0.5 block truncate text-[10px] text-[var(--color-text-muted)]">
                          {result.matchedTaskSubject
                            ? t('organizations.graph.focus.taskMatch', {
                                task: result.matchedTaskSubject,
                              })
                            : result.pathLabels.slice(0, -1).join(' / ')}
                        </span>
                      </span>
                      <span className="mt-1 rounded border border-white/10 px-1 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-text-muted)]">
                        {t(`organizations.graph.focus.kind.${result.kind}`)}
                      </span>
                    </Button>
                  ))
                ) : (
                  <div className="px-3 py-4 text-center text-xs text-[var(--color-text-muted)]">
                    {t('organizations.graph.focus.noResults')}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {selectedNode ? (
        <div className="pointer-events-auto mt-2 rounded-xl border border-sky-300/15 bg-[color-mix(in_srgb,var(--color-surface-overlay)_94%,transparent)] p-2 shadow-2xl shadow-black/30 backdrop-blur-xl">
          <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto pb-1 text-[10px] text-[var(--color-text-muted)]">
            {selectedPath.map((node, index) => (
              <span key={node.id} className="inline-flex shrink-0 items-center gap-0.5">
                {index > 0 ? <ChevronRight size={10} className="opacity-50" /> : null}
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  className={`h-auto max-w-32 truncate rounded px-1.5 py-0.5 hover:bg-white/5 hover:text-[var(--color-text)] ${
                    node.id === selectedNode.id ? 'bg-sky-400/10 text-sky-100' : ''
                  }`}
                  title={getNodeDisplayLabel(node)}
                  onClick={() => {
                    onFocusModeChange('context');
                    onSelectNode(node.id, true);
                  }}
                >
                  {getNodeDisplayLabel(node)}
                </Button>
              </span>
            ))}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium transition-colors ${
                focusMode === 'path'
                  ? 'border-sky-300/40 bg-sky-400/15 text-sky-100'
                  : 'border-white/10 bg-white/[0.03] text-[var(--color-text-muted)] hover:bg-white/[0.07] hover:text-[var(--color-text)]'
              }`}
              onClick={() => toggleFocusMode('path')}
            >
              <Route size={11} />
              {t('organizations.graph.focus.pathToRoot')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium transition-colors ${
                focusMode === 'connections'
                  ? 'border-violet-300/40 bg-violet-400/15 text-violet-100'
                  : 'border-white/10 bg-white/[0.03] text-[var(--color-text-muted)] hover:bg-white/[0.07] hover:text-[var(--color-text)]'
              }`}
              onClick={() => toggleFocusMode('connections')}
            >
              <Focus size={11} />
              {t('organizations.graph.focus.connectedOnly', { count: connectedTeamCount })}
            </Button>
            {canToggleCollapse ? (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2 text-[10px] font-medium text-[var(--color-text-muted)] transition-colors hover:bg-white/[0.07] hover:text-[var(--color-text)]"
                onClick={() => onToggleNodeCollapse(selectedNode.id)}
              >
                {collapsedNodeIds.has(selectedNode.id) ? (
                  <ChevronRight size={11} />
                ) : (
                  <ChevronDown size={11} />
                )}
                {collapsedNodeIds.has(selectedNode.id)
                  ? t('organizations.graph.focus.expandBranch')
                  : t('organizations.graph.focus.collapseBranch')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              type="button"
              aria-label={t('organizations.graph.focus.clearFocus')}
              title={t('organizations.graph.focus.clearFocus')}
              className="ml-auto flex size-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text)]"
              onClick={() => {
                onFocusModeChange('context');
                onSelectNode(null);
              }}
            >
              <X size={13} />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
