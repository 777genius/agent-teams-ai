import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { Search, Terminal, X } from 'lucide-react';

import { ClaudeLogsFilterPopover, DEFAULT_CLAUDE_LOGS_FILTER } from './ClaudeLogsFilterPopover';
import { CliLogsRichView } from './CliLogsRichView';
import { CollapsibleTeamSection } from './CollapsibleTeamSection';

import type { ClaudeLogsFilterState } from './ClaudeLogsFilterPopover';
import type { TeamClaudeLogsResponse } from '@shared/types';

const PAGE_SIZE = 100;
const POLL_MS = 2000;
const ONLINE_WINDOW_MS = 10_000;
const LOAD_MORE_THRESHOLD_PX = 48;

type StreamType = 'stdout' | 'stderr';

interface ClaudeLogsSectionProps {
  teamName: string;
}

function isRecent(updatedAt: string | undefined): boolean {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= ONLINE_WINDOW_MS;
}

function normalizeToStreamJsonText(linesNewestFirst: string[]): string {
  // We want to feed CliLogsRichView the exact format it expects:
  // - marker lines: "[stdout]" / "[stderr]"
  // - raw JSON lines without any "[stdout] " prefix
  const chronological = [...linesNewestFirst].reverse();

  const out: string[] = [];
  let lastStream: StreamType | null = null;

  const pushMarker = (stream: StreamType): void => {
    if (lastStream === stream) return;
    lastStream = stream;
    out.push(stream === 'stdout' ? '[stdout]' : '[stderr]');
  };

  for (const rawLine of chronological) {
    const line = rawLine ?? '';
    if (line === '[stdout]' || line === '[stderr]') {
      lastStream = line === '[stdout]' ? 'stdout' : 'stderr';
      out.push(line);
      continue;
    }

    if (line.startsWith('[stdout] ')) {
      pushMarker('stdout');
      out.push(line.slice('[stdout] '.length));
      continue;
    }
    if (line.startsWith('[stderr] ')) {
      pushMarker('stderr');
      out.push(line.slice('[stderr] '.length));
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

function getOverlapSize(
  existingLinesNewestFirst: string[],
  olderLinesNewestFirst: string[]
): number {
  const maxOverlap = Math.min(existingLinesNewestFirst.length, olderLinesNewestFirst.length);

  for (let size = maxOverlap; size > 0; size -= 1) {
    let matches = true;
    for (let i = 0; i < size; i += 1) {
      if (
        existingLinesNewestFirst[existingLinesNewestFirst.length - size + i] !==
        olderLinesNewestFirst[i]
      ) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }

  return 0;
}

function appendOlderLines(
  existingLinesNewestFirst: string[],
  olderLinesNewestFirst: string[]
): string[] {
  if (existingLinesNewestFirst.length === 0) return olderLinesNewestFirst;
  if (olderLinesNewestFirst.length === 0) return existingLinesNewestFirst;

  const overlapSize = getOverlapSize(existingLinesNewestFirst, olderLinesNewestFirst);
  return existingLinesNewestFirst.concat(olderLinesNewestFirst.slice(overlapSize));
}

type AssistantContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
  | { type: string; [key: string]: unknown };

function filterStreamJsonText(
  linesNewestFirst: string[],
  queryRaw: string,
  filter: ClaudeLogsFilterState
): string {
  const q = queryRaw.trim().toLowerCase();
  const chronological = normalizeToStreamJsonText(linesNewestFirst).split('\n');

  let currentStream: StreamType | null = null;
  let lastEmittedStream: StreamType | null = null;
  const out: string[] = [];

  const emitMarker = (): void => {
    if (!currentStream) return;
    if (lastEmittedStream === currentStream) return;
    out.push(currentStream === 'stdout' ? '[stdout]' : '[stderr]');
    lastEmittedStream = currentStream;
  };

  const extractBlocks = (parsed: Record<string, unknown>): AssistantContentBlock[] | null => {
    if (parsed.type !== 'assistant') return null;
    if (Array.isArray(parsed.content)) {
      return parsed.content as AssistantContentBlock[];
    }
    const msg = parsed.message;
    if (msg && typeof msg === 'object') {
      const inner = msg as Record<string, unknown>;
      if (Array.isArray(inner.content)) return inner.content as AssistantContentBlock[];
    }
    return null;
  };

  const writeBlocks = (
    parsed: Record<string, unknown>,
    blocks: AssistantContentBlock[]
  ): Record<string, unknown> => {
    if (Array.isArray(parsed.content)) {
      return { ...parsed, content: blocks };
    }
    const msg = parsed.message;
    if (msg && typeof msg === 'object') {
      return { ...parsed, message: { ...(msg as Record<string, unknown>), content: blocks } };
    }
    return parsed;
  };

  for (const rawLine of chronological) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    if (line === '[stdout]' || line === '[stderr]') {
      currentStream = line === '[stdout]' ? 'stdout' : 'stderr';
      continue;
    }

    if (currentStream && !filter.streams.has(currentStream)) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON lines are ignored to keep view consistent with CliLogsRichView.
      continue;
    }

    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;

    const blocks = extractBlocks(obj);
    if (!blocks) {
      // Keep only assistant messages for now (CliLogsRichView renders these richly).
      continue;
    }

    const filteredBlocks = blocks.filter((b) => {
      if (!b || typeof b !== 'object') return false;
      if (b.type === 'text') return filter.kinds.has('output');
      if (b.type === 'thinking') return filter.kinds.has('thinking');
      if (b.type === 'tool_use') return filter.kinds.has('tool');
      // Unknown block types: keep (they're rare, and dropping can hide content)
      return true;
    });
    if (filteredBlocks.length === 0) continue;

    const searchTextParts: string[] = [];
    for (const b of filteredBlocks) {
      if (b.type === 'text' && typeof b.text === 'string') searchTextParts.push(b.text);
      if (b.type === 'thinking' && typeof b.thinking === 'string') searchTextParts.push(b.thinking);
      if (b.type === 'tool_use') {
        if (typeof b.name === 'string') searchTextParts.push(b.name);
        if (b.input && typeof b.input === 'object') {
          try {
            searchTextParts.push(JSON.stringify(b.input));
          } catch {
            // ignore
          }
        }
      }
    }
    const haystack = searchTextParts.join('\n').toLowerCase();
    if (q && !haystack.includes(q)) {
      continue;
    }

    emitMarker();
    const nextObj = writeBlocks(obj, filteredBlocks);
    out.push(JSON.stringify(nextObj));
  }

  return out.join('\n');
}

export const ClaudeLogsSection = ({ teamName }: ClaudeLogsSectionProps): React.JSX.Element => {
  const isAlive = useStore((s) => s.selectedTeamData?.isAlive ?? false);
  const [loadedCount, setLoadedCount] = useState(PAGE_SIZE);
  const [data, setData] = useState<TeamClaudeLogsResponse>({ lines: [], total: 0, hasMore: false });
  const [pending, setPending] = useState<TeamClaudeLogsResponse | null>(null);
  const [pendingNewCount, setPendingNewCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const applyingPendingRef = useRef(false);
  const atTopRef = useRef(true);
  const latestRef = useRef<TeamClaudeLogsResponse | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const committedRef = useRef<TeamClaudeLogsResponse>({ lines: [], total: 0, hasMore: false });
  const pendingCountRef = useRef(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<ClaudeLogsFilterState>(() => ({
    streams: new Set(DEFAULT_CLAUDE_LOGS_FILTER.streams),
    kinds: new Set(DEFAULT_CLAUDE_LOGS_FILTER.kinds),
  }));
  const [filterOpen, setFilterOpen] = useState(false);
  const isNearBottom = useCallback(
    (scrollTop: number, scrollHeight: number, clientHeight: number) => {
      return scrollHeight - scrollTop - clientHeight <= LOAD_MORE_THRESHOLD_PX;
    },
    []
  );

  useEffect(() => {
    setLoadedCount(PAGE_SIZE);
    setData({ lines: [], total: 0, hasMore: false });
    setPending(null);
    setPendingNewCount(0);
    latestRef.current = null;
    atTopRef.current = true;
    setError(null);
    setSearchQuery('');
    setFilter({
      streams: new Set(DEFAULT_CLAUDE_LOGS_FILTER.streams),
      kinds: new Set(DEFAULT_CLAUDE_LOGS_FILTER.kinds),
    });
  }, [teamName]);

  useEffect(() => {
    committedRef.current = data;
  }, [data]);

  useEffect(() => {
    pendingCountRef.current = pendingNewCount;
  }, [pendingNewCount]);

  useEffect(() => {
    let cancelled = false;

    const computeNewCount = (
      committed: TeamClaudeLogsResponse,
      latest: TeamClaudeLogsResponse
    ): number => {
      if (committed.lines.length === 0) return latest.lines.length;
      const marker = committed.lines[0];
      const idx = latest.lines.indexOf(marker);
      if (idx >= 0) return idx;
      const diff =
        (latest.total ?? latest.lines.length) - (committed.total ?? committed.lines.length);
      return Math.max(0, diff);
    };

    const fetchLogs = async (): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        setLoading(true);
        const next = await api.teams.getClaudeLogs(teamName, { offset: 0, limit: loadedCount });
        if (cancelled) return;
        latestRef.current = next;
        if (atTopRef.current) {
          setData(next);
          setPending(null);
          setPendingNewCount(0);
        } else {
          setPending(next);
          const base = computeNewCount(committedRef.current, next);
          setPendingNewCount((prev) => Math.max(prev, base));
        }
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlightRef.current = false;
        if (!cancelled) setLoading(false);
      }
    };

    void fetchLogs();
    const id = window.setInterval(() => void fetchLogs(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [teamName, loadedCount]);

  const loadOlderLogs = useCallback(async (): Promise<void> => {
    if (loadingMoreRef.current || inFlightRef.current) return;

    const current = committedRef.current;
    if (!current.hasMore) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);

    try {
      const older = await api.teams.getClaudeLogs(teamName, {
        offset: current.lines.length + pendingCountRef.current,
        limit: PAGE_SIZE,
      });

      setData((prev) => ({
        ...prev,
        lines: appendOlderLines(prev.lines, older.lines),
        total: older.total,
        hasMore: older.hasMore,
        updatedAt: older.updatedAt ?? prev.updatedAt,
      }));
      setLoadedCount((count) => count + PAGE_SIZE);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [teamName]);

  useEffect(() => {
    const el = logContainerRef.current;
    if (!el || loading || loadingMore || !data.hasMore || data.lines.length === 0) return;

    if (
      el.scrollHeight <= el.clientHeight ||
      isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
    ) {
      void loadOlderLogs();
    }
  }, [data.hasMore, data.lines.length, isNearBottom, loadOlderLogs, loading, loadingMore]);

  const online = useMemo(() => isRecent(data.updatedAt), [data.updatedAt]);
  const badge = data.total > 0 ? data.total : undefined;
  const showMoreVisible = data.hasMore || loadingMore;

  const headerExtra = online ? (
    <span className="pointer-events-none relative inline-flex size-2 shrink-0" title="Updating">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
      <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
    </span>
  ) : null;

  const filteredText = useMemo(() => {
    if (data.lines.length === 0) return '';
    const isDefault =
      filter.streams.size === DEFAULT_CLAUDE_LOGS_FILTER.streams.size &&
      filter.kinds.size === DEFAULT_CLAUDE_LOGS_FILTER.kinds.size &&
      [...DEFAULT_CLAUDE_LOGS_FILTER.streams].every((s) => filter.streams.has(s)) &&
      [...DEFAULT_CLAUDE_LOGS_FILTER.kinds].every((k) => filter.kinds.has(k));

    if (!searchQuery.trim() && isDefault) {
      return normalizeToStreamJsonText(data.lines);
    }
    return filterStreamJsonText(data.lines, searchQuery, filter);
  }, [data.lines, searchQuery, filter]);

  const applyPending = useCallback(async (): Promise<void> => {
    if (applyingPendingRef.current) return;

    applyingPendingRef.current = true;
    try {
      let latest = latestRef.current ?? pending;
      const expectedVisibleCount = latest ? Math.min(loadedCount, latest.total) : loadedCount;

      if (!latest || latest.lines.length < expectedVisibleCount) {
        latest = await api.teams.getClaudeLogs(teamName, { offset: 0, limit: loadedCount });
        latestRef.current = latest;
      }

      setData(latest);
      setPending(null);
      setPendingNewCount(0);
      setError(null);

      // Jump to newest
      if (logContainerRef.current) {
        logContainerRef.current.scrollTop = 0;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      applyingPendingRef.current = false;
    }
  }, [loadedCount, pending, teamName]);

  return (
    <CollapsibleTeamSection
      sectionId="claude-logs"
      title="Claude logs"
      icon={<Terminal size={14} />}
      badge={badge}
      headerExtra={headerExtra}
      defaultOpen
      // Prevent scroll anchoring from "pulling" the parent container when logs update.
      contentClassName="pt-0 [overflow-anchor:none]"
    >
      <div className="flex items-center justify-between gap-2 pb-2">
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {data.total > 0 ? (
            <>
              Showing <span className="font-mono">{Math.min(data.total, data.lines.length)}</span>{' '}
              of <span className="font-mono">{data.total}</span>
            </>
          ) : isAlive ? (
            'No logs yet.'
          ) : (
            'Team is not running.'
          )}
        </span>
        <div className="flex items-center gap-2">
          {data.total > 0 ? (
            <>
              <div className="flex w-48 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1">
                <Search size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                <input
                  type="text"
                  placeholder="Search logs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <ClaudeLogsFilterPopover
                filter={filter}
                open={filterOpen}
                onOpenChange={setFilterOpen}
                onApply={setFilter}
              />
            </>
          ) : null}
          {pendingNewCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-blue-500/30 bg-blue-600 px-2 text-xs text-white hover:bg-blue-500"
              onClick={applyPending}
              title="Show newest logs"
            >
              +{pendingNewCount} new
            </Button>
          )}
        </div>
      </div>

      <div className={cn('rounded', loading && 'opacity-80')}>
        {error ? <p className="p-2 text-xs text-red-300">{error}</p> : null}
        {!error && filteredText.trim().length > 0 ? (
          <CliLogsRichView
            // Parser expects chronological order; UI shows newest-first.
            cliLogsTail={filteredText}
            order="newest-first"
            searchQueryOverride={searchQuery.trim() ? searchQuery : undefined}
            className="max-h-[213px] p-2"
            containerRefCallback={(el) => {
              logContainerRef.current = el;
            }}
            onScroll={({ scrollTop, scrollHeight, clientHeight }) => {
              const atTop = scrollTop <= 8;
              atTopRef.current = atTop;
              if (atTop && pendingCountRef.current > 0) {
                void applyPending();
                return;
              }

              if (isNearBottom(scrollTop, scrollHeight, clientHeight)) {
                void loadOlderLogs();
              }
            }}
            footer={
              showMoreVisible ? (
                <div className="flex justify-center py-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => void loadOlderLogs()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : 'Show more'}
                  </Button>
                </div>
              ) : null
            }
          />
        ) : null}
        {!error && data.lines.length === 0 && isAlive ? (
          <p className="p-2 text-xs text-[var(--color-text-muted)]">
            {loading ? 'Loading…' : 'No logs captured.'}
          </p>
        ) : null}
        {!error && data.lines.length > 0 && filteredText.trim().length === 0 ? (
          <p className="p-2 text-xs text-[var(--color-text-muted)]">No matching logs.</p>
        ) : null}
      </div>
    </CollapsibleTeamSection>
  );
};
