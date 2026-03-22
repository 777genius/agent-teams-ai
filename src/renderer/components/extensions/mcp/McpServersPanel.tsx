/**
 * McpServersPanel — search and browse the MCP server catalog.
 */

import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useStore } from '@renderer/store';
import { formatRelativeTime } from '@renderer/utils/formatters';
import { CLI_NOT_FOUND_MARKER } from '@shared/constants/cli';
import { sanitizeMcpServerName } from '@shared/utils/extensionNormalizers';
import { AlertTriangle, RefreshCw, Search, Server } from 'lucide-react';

import { SearchInput } from '../common/SearchInput';

import { McpServerCard } from './McpServerCard';
import { McpServerDetailDialog } from './McpServerDetailDialog';

import type {
  InstalledMcpEntry,
  McpCatalogItem,
  McpServerDiagnostic,
} from '@shared/types/extensions';

type McpSortValue = 'name-asc' | 'name-desc' | 'tools-desc';

const MCP_SORT_OPTIONS: { value: McpSortValue; label: string }[] = [
  { value: 'name-asc', label: 'Name A→Z' },
  { value: 'name-desc', label: 'Name Z→A' },
  { value: 'tools-desc', label: 'Most tools' },
];

function sortMcpServers(servers: McpCatalogItem[], sort: McpSortValue): McpCatalogItem[] {
  return [...servers].sort((a, b) => {
    switch (sort) {
      case 'name-asc':
        return a.name.localeCompare(b.name);
      case 'name-desc':
        return b.name.localeCompare(a.name);
      case 'tools-desc':
        return b.tools.length - a.tools.length;
      default:
        return 0;
    }
  });
}

interface McpServersPanelProps {
  mcpSearchQuery: string;
  mcpSearch: (query: string) => void;
  mcpSearchResults: McpCatalogItem[];
  mcpSearchLoading: boolean;
  mcpSearchWarnings: string[];
  selectedMcpServerId: string | null;
  setSelectedMcpServerId: (id: string | null) => void;
}

export const McpServersPanel = ({
  mcpSearchQuery,
  mcpSearch,
  mcpSearchResults,
  mcpSearchLoading,
  mcpSearchWarnings,
  selectedMcpServerId,
  setSelectedMcpServerId,
}: McpServersPanelProps): React.JSX.Element => {
  const browseCatalog = useStore((s) => s.mcpBrowseCatalog);
  const browseNextCursor = useStore((s) => s.mcpBrowseNextCursor);
  const browseLoading = useStore((s) => s.mcpBrowseLoading);
  const browseError = useStore((s) => s.mcpBrowseError);
  const mcpBrowse = useStore((s) => s.mcpBrowse);
  const installedServers = useStore((s) => s.mcpInstalledServers);
  const fetchMcpGitHubStars = useStore((s) => s.fetchMcpGitHubStars);
  const mcpDiagnostics = useStore((s) => s.mcpDiagnostics);
  const mcpDiagnosticsLoading = useStore((s) => s.mcpDiagnosticsLoading);
  const mcpDiagnosticsError = useStore((s) => s.mcpDiagnosticsError);
  const mcpDiagnosticsLastCheckedAt = useStore((s) => s.mcpDiagnosticsLastCheckedAt);
  const runMcpDiagnostics = useStore((s) => s.runMcpDiagnostics);

  const [mcpSort, setMcpSort] = useState<McpSortValue>('name-asc');

  // Load initial browse data
  useEffect(() => {
    if (browseCatalog.length === 0 && !browseLoading) {
      void mcpBrowse();
    }
  }, [browseCatalog.length, browseLoading, mcpBrowse]);

  useEffect(() => {
    void runMcpDiagnostics();
  }, [runMcpDiagnostics]);

  // Fetch GitHub stars after catalog loads (fire-and-forget)
  useEffect(() => {
    const urls = browseCatalog.map((s) => s.repositoryUrl).filter((u): u is string => !!u);
    if (urls.length > 0) {
      fetchMcpGitHubStars(urls);
    }
  }, [browseCatalog, fetchMcpGitHubStars]);

  // Decide which list to show: search results or browse
  const isSearching = mcpSearchQuery.trim().length > 0;
  const rawServers = isSearching ? mcpSearchResults : browseCatalog;
  const isLoading = isSearching ? mcpSearchLoading : browseLoading;
  const warnings = isSearching ? mcpSearchWarnings : [];

  // Installed lookup set (lowercase CLI names)
  const installedNames = useMemo(
    () => new Set(installedServers.map((s) => s.name.toLowerCase())),
    [installedServers]
  );

  const installedEntriesByName = useMemo(
    () => new Map(installedServers.map((entry) => [entry.name.toLowerCase(), entry] as const)),
    [installedServers]
  );

  /** Check if a catalog server is installed by comparing sanitized names */
  const isServerInstalled = (server: McpCatalogItem): boolean =>
    installedNames.has(sanitizeMcpServerName(server.name));

  const getInstalledEntry = (server: McpCatalogItem): InstalledMcpEntry | null =>
    installedEntriesByName.get(sanitizeMcpServerName(server.name)) ?? null;

  const getDiagnostic = (server: McpCatalogItem): McpServerDiagnostic | null => {
    const installedEntry = getInstalledEntry(server);
    return installedEntry ? (mcpDiagnostics[installedEntry.name] ?? null) : null;
  };

  const allDiagnostics = useMemo(
    () => Object.values(mcpDiagnostics).sort((a, b) => a.name.localeCompare(b.name)),
    [mcpDiagnostics]
  );

  const getDiagnosticBadgeClass = (status: McpServerDiagnostic['status']): string => {
    switch (status) {
      case 'connected':
        return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400';
      case 'needs-authentication':
        return 'border-amber-500/30 bg-amber-500/10 text-amber-400';
      case 'failed':
        return 'border-red-500/30 bg-red-500/10 text-red-400';
      default:
        return 'border-border bg-surface-raised text-text-muted';
    }
  };

  // Sort displayed servers
  const displayServers = useMemo(() => sortMcpServers(rawServers, mcpSort), [rawServers, mcpSort]);

  // Find selected server (search in both lists to avoid losing selection during search toggle)
  const selectedServer = useMemo(() => {
    if (!selectedMcpServerId) return null;
    return (
      displayServers.find((s) => s.id === selectedMcpServerId) ??
      browseCatalog.find((s) => s.id === selectedMcpServerId) ??
      mcpSearchResults.find((s) => s.id === selectedMcpServerId) ??
      null
    );
  }, [displayServers, browseCatalog, mcpSearchResults, selectedMcpServerId]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-black/10 bg-surface-raised px-4 py-3 dark:border-white/10">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-text">MCP Health Status</p>
            <p className="text-xs text-text-muted">
              {mcpDiagnosticsLoading ? (
                <>
                  Checking installed MCP servers via Claude CLI (<code>claude mcp list</code>) ...
                </>
              ) : mcpDiagnosticsLastCheckedAt ? (
                `Last checked ${formatRelativeTime(new Date(mcpDiagnosticsLastCheckedAt).toISOString())}`
              ) : (
                <>
                  Run diagnostics (<code>claude mcp list</code>) to verify installed MCP
                  connectivity.
                </>
              )}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runMcpDiagnostics()}
            disabled={mcpDiagnosticsLoading}
            className="whitespace-nowrap"
          >
            <RefreshCw
              className={`mr-1.5 size-3.5 ${mcpDiagnosticsLoading ? 'animate-spin' : ''}`}
            />
            {mcpDiagnosticsLoading ? 'Checking...' : 'Check Status'}
          </Button>
        </div>

        {(mcpDiagnosticsLoading || allDiagnostics.length > 0) && (
          <div className="mt-4 border-t border-black/10 pt-4 dark:border-white/10">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-text">Claude MCP List Results</p>
              {allDiagnostics.length > 0 && (
                <span className="text-xs text-text-muted">{allDiagnostics.length} servers</span>
              )}
            </div>
            {allDiagnostics.length > 0 ? (
              <div className="mcp-diagnostics-list max-h-[18.5rem] space-y-2 overflow-y-auto pr-1">
                {allDiagnostics.map((diagnostic) => (
                  <div
                    key={diagnostic.name}
                    className="flex items-start justify-between gap-3 rounded-md border border-black/10 px-3 py-2 dark:border-white/10"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-text">{diagnostic.name}</p>
                      <p
                        className="truncate font-mono text-[11px] text-text-muted"
                        title={diagnostic.target}
                      >
                        {diagnostic.target}
                      </p>
                    </div>
                    <Badge className={getDiagnosticBadgeClass(diagnostic.status)} variant="outline">
                      {diagnostic.statusLabel}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted">Waiting for `claude mcp list` results...</p>
            )}
          </div>
        )}
      </div>

      {/* Search + sort row */}
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <SearchInput
            value={mcpSearchQuery}
            onChange={mcpSearch}
            placeholder="Search MCP servers..."
          />
        </div>
        <Select value={mcpSort} onValueChange={(v) => setMcpSort(v as McpSortValue)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MCP_SORT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="flex flex-col gap-1">
          {warnings.map((w, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400"
            >
              <AlertTriangle className="size-3.5 shrink-0" />
              {w}
            </div>
          ))}
        </div>
      )}

      {/* Skeleton loading */}
      {isLoading && displayServers.length === 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className="skeleton-card flex flex-col gap-2 rounded-lg border border-border p-4"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <div className="flex items-start gap-2.5">
                <div className="size-9 rounded-lg bg-surface-raised" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-32 rounded bg-surface-raised" />
                  <div className="h-3 w-16 rounded-full bg-surface-raised" />
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="h-3 w-full rounded bg-surface-raised" />
                <div className="h-3 w-2/3 rounded bg-surface-raised" />
              </div>
              <div className="flex items-center justify-between">
                <div className="h-5 w-12 rounded-full bg-surface-raised" />
                <div className="h-7 w-16 rounded bg-surface-raised" />
              </div>
            </div>
          ))}
        </div>
      )}

      {browseError && !isSearching && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
          {browseError}
        </div>
      )}

      {mcpDiagnosticsError &&
        (mcpDiagnosticsError.includes(CLI_NOT_FOUND_MARKER) ? (
          <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
            <div>
              <p className="text-sm font-medium text-amber-300">Claude CLI not installed</p>
              <p className="mt-0.5 text-xs text-text-muted">
                MCP health checks require Claude CLI. Go to the Dashboard to install it
                automatically.
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
            {mcpDiagnosticsError}
          </div>
        ))}

      {/* Empty state */}
      {!isLoading && displayServers.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-sm border border-dashed border-border px-8 py-16">
          <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface-raised">
            {isSearching ? (
              <Search className="size-5 text-text-muted" />
            ) : (
              <Server className="size-5 text-text-muted" />
            )}
          </div>
          <p className="text-sm text-text-secondary">
            {isSearching ? 'No servers found' : 'No MCP servers available'}
          </p>
          <p className="text-xs text-text-muted">
            {isSearching ? 'Try a different search term' : 'Check back later for new servers'}
          </p>
        </div>
      )}

      {displayServers.length > 0 && (
        <div className="mcp-servers-grid grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {displayServers.map((server) => (
            <McpServerCard
              key={server.id}
              server={server}
              isInstalled={isServerInstalled(server)}
              diagnostic={getDiagnostic(server)}
              diagnosticsLoading={mcpDiagnosticsLoading}
              onClick={setSelectedMcpServerId}
            />
          ))}
        </div>
      )}

      {/* Load more for browse */}
      {!isSearching && browseNextCursor && (
        <div className="flex justify-center py-4">
          <Button
            variant="outline"
            size="sm"
            disabled={browseLoading}
            onClick={() => void mcpBrowse(browseNextCursor)}
          >
            Load more
          </Button>
        </div>
      )}

      {/* Detail dialog */}
      <McpServerDetailDialog
        server={selectedServer}
        isInstalled={selectedServer ? isServerInstalled(selectedServer) : false}
        diagnostic={selectedServer ? getDiagnostic(selectedServer) : null}
        diagnosticsLoading={mcpDiagnosticsLoading}
        open={selectedMcpServerId !== null}
        onClose={() => setSelectedMcpServerId(null)}
      />
    </div>
  );
};
