/**
 * useClaudeLogsController
 *
 * Single controller hook that owns all Claude logs data-fetching, polling,
 * pending-buffering, pagination, search, filter, and viewer state.
 *
 * Used by ClaudeLogsSection to share one source of truth between the
 * compact sidebar panel and the fullscreen dialog.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

import { DEFAULT_CLAUDE_LOGS_FILTER } from './ClaudeLogsFilterPopover';
import {
  createDefaultClaudeLogsSidebarUiState,
  getTeamClaudeLogsSidebarUiState,
  setTeamClaudeLogsSidebarUiState,
} from './sidebar/teamSidebarUiState';

import type { ClaudeLogsFilterState } from './ClaudeLogsFilterPopover';
import type { ClaudeLogsViewerState } from './CliLogsRichView';
import type { TeamClaudeLogsResponse } from '@shared/types';

// =============================================================================
// Constants
// =============================================================================

const PAGE_SIZE = 100;
const POLL_MS = 2000;
const ONLINE_WINDOW_MS = 10_000;
const LOAD_MORE_THRESHOLD_PX = 48;

// =============================================================================
// Types
// =============================================================================

type StreamType = 'stdout' | 'stderr';

/** Info about the most recent log item for the header preview. */
export interface LastLogPreview {
  type: 'output' | 'thinking' | 'tool';
  label: string;
  summary: string;
}

export interface ClaudeLogsController {
  // Data state
  data: TeamClaudeLogsResponse;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  pendingNewCount: number;
  isAlive: boolean;

  // Computed
  filteredText: string;
  online: boolean;
  badge: number | undefined;
  showMoreVisible: boolean;
  lastLogPreview: LastLogPreview | null;

  // Search & filter
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  filter: ClaudeLogsFilterState;
  setFilter: (f: ClaudeLogsFilterState) => void;
  filterOpen: boolean;
  setFilterOpen: (open: boolean) => void;

  // Viewer state (expansion + viewport)
  viewerState: ClaudeLogsViewerState;
  onViewerStateChange: (state: ClaudeLogsViewerState) => void;

  // Actions
  applyPending: () => Promise<void>;
  loadOlderLogs: () => Promise<void>;

  // Scroll integration
  containerRefCallback: (el: HTMLDivElement | null) => void;
  handleScroll: (params: { scrollTop: number; scrollHeight: number; clientHeight: number }) => void;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * System JSON subtypes that carry no user-facing value in the logs UI.
 */
const SYSTEM_NOISE_SUBTYPES = new Set(['hook_started', 'hook_response', 'init']);

function isSystemNoiseLine(jsonStr: string): boolean {
  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object') return false;
    const obj = parsed as Record<string, unknown>;
    if (obj.type !== 'system') return false;
    if (typeof obj.subtype === 'string') {
      return SYSTEM_NOISE_SUBTYPES.has(obj.subtype);
    }
    return true;
  } catch {
    return false;
  }
}

function isRecent(updatedAt: string | undefined): boolean {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= ONLINE_WINDOW_MS;
}

function extractLastLogPreview(linesNewestFirst: string[]): LastLogPreview | null {
  for (const rawLine of linesNewestFirst) {
    const line = rawLine?.trim();
    if (!line) continue;
    if (line === '[stdout]' || line === '[stderr]') continue;

    let content = line;
    if (line.startsWith('[stdout] ')) content = line.slice('[stdout] '.length);
    else if (line.startsWith('[stderr] ')) content = line.slice('[stderr] '.length);

    if (content.trimStart().startsWith('{') && isSystemNoiseLine(content)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.type !== 'assistant') continue;

    interface ContentBlock {
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
    }
    let blocks: ContentBlock[] | null = null;
    if (Array.isArray(obj.content)) {
      blocks = obj.content as ContentBlock[];
    } else if (obj.message && typeof obj.message === 'object') {
      const msg = obj.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) blocks = msg.content as ContentBlock[];
    }

    if (!blocks || blocks.length === 0) continue;

    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        return { type: 'output', label: 'Output', summary: b.text.trim().replace(/\n+/g, ' ') };
      }
      if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        return {
          type: 'thinking',
          label: 'Thinking',
          summary: b.thinking.trim().replace(/\n+/g, ' '),
        };
      }
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        return { type: 'tool', label: b.name, summary: '' };
      }
    }
  }
  return null;
}

function normalizeToStreamJsonText(linesNewestFirst: string[]): string {
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

    let content = line;
    if (line.startsWith('[stdout] ')) {
      pushMarker('stdout');
      content = line.slice('[stdout] '.length);
    } else if (line.startsWith('[stderr] ')) {
      pushMarker('stderr');
      content = line.slice('[stderr] '.length);
    }

    if (content.trimStart().startsWith('{') && isSystemNoiseLine(content)) {
      continue;
    }

    if (content !== line) {
      out.push(content);
    } else {
      out.push(line);
    }
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
      continue;
    }

    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;

    const blocks = extractBlocks(obj);
    if (!blocks) continue;

    const filteredBlocks = blocks.filter((b) => {
      if (!b || typeof b !== 'object') return false;
      if (b.type === 'text') return filter.kinds.has('output');
      if (b.type === 'thinking') return filter.kinds.has('thinking');
      if (b.type === 'tool_use') return filter.kinds.has('tool');
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

// =============================================================================
// Default viewer state
// =============================================================================

function createDefaultViewerState(): ClaudeLogsViewerState {
  return createDefaultClaudeLogsSidebarUiState().viewerState;
}

// =============================================================================
// Hook
// =============================================================================

export function useClaudeLogsController(teamName: string): ClaudeLogsController {
  const isAlive = useStore((s) => s.selectedTeamData?.isAlive ?? false);

  // ── Data state ────────────────────────────────────────────────────────
  const [loadedCount, setLoadedCount] = useState(PAGE_SIZE);
  const [data, setData] = useState<TeamClaudeLogsResponse>({ lines: [], total: 0, hasMore: false });
  const [pending, setPending] = useState<TeamClaudeLogsResponse | null>(null);
  const [pendingNewCount, setPendingNewCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Search & filter state ─────────────────────────────────────────────
  const initialSidebarStateRef = useRef(getTeamClaudeLogsSidebarUiState(teamName));
  const [searchQuery, setSearchQuery] = useState(initialSidebarStateRef.current.searchQuery);
  const [filter, setFilter] = useState<ClaudeLogsFilterState>(
    initialSidebarStateRef.current.filter
  );
  const [filterOpen, setFilterOpen] = useState(initialSidebarStateRef.current.filterOpen);

  // ── Viewer state (expansion + viewport) ───────────────────────────────
  const [viewerState, setViewerState] = useState<ClaudeLogsViewerState>(
    initialSidebarStateRef.current.viewerState
  );

  const onViewerStateChange = useCallback((state: ClaudeLogsViewerState) => {
    setViewerState(state);
  }, []);

  // ── Internal refs ─────────────────────────────────────────────────────
  const inFlightRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const applyingPendingRef = useRef(false);
  const atTopRef = useRef(true);
  const latestRef = useRef<TeamClaudeLogsResponse | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const committedRef = useRef<TeamClaudeLogsResponse>({ lines: [], total: 0, hasMore: false });
  const pendingCountRef = useRef(0);

  // ── Reset on team change ──────────────────────────────────────────────
  useEffect(() => {
    initialSidebarStateRef.current = getTeamClaudeLogsSidebarUiState(teamName);
    setLoadedCount(PAGE_SIZE);
    setData({ lines: [], total: 0, hasMore: false });
    setPending(null);
    setPendingNewCount(0);
    latestRef.current = null;
    atTopRef.current = true;
    setError(null);
    setSearchQuery(initialSidebarStateRef.current.searchQuery);
    setFilter(initialSidebarStateRef.current.filter);
    setFilterOpen(initialSidebarStateRef.current.filterOpen);
    setViewerState(initialSidebarStateRef.current.viewerState);
  }, [teamName]);

  useEffect(() => {
    setTeamClaudeLogsSidebarUiState(teamName, {
      searchQuery,
      filter,
      filterOpen,
      viewerState,
    });
  }, [teamName, searchQuery, filter, filterOpen, viewerState]);

  // ── Sync refs ─────────────────────────────────────────────────────────
  useEffect(() => {
    committedRef.current = data;
  }, [data]);

  useEffect(() => {
    pendingCountRef.current = pendingNewCount;
  }, [pendingNewCount]);

  // ── Polling ───────────────────────────────────────────────────────────
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

  // ── Load older logs ───────────────────────────────────────────────────
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

  // ── Auto-load when content fits in container ──────────────────────────
  const isNearBottom = useCallback(
    (scrollTop: number, scrollHeight: number, clientHeight: number) => {
      return scrollHeight - scrollTop - clientHeight <= LOAD_MORE_THRESHOLD_PX;
    },
    []
  );

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

  // ── Apply pending logs ────────────────────────────────────────────────
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

      if (logContainerRef.current) {
        logContainerRef.current.scrollTop = 0;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      applyingPendingRef.current = false;
    }
  }, [loadedCount, pending, teamName]);

  // ── Computed values ───────────────────────────────────────────────────
  const online = useMemo(() => isRecent(data.updatedAt), [data.updatedAt]);
  const badge = data.total > 0 ? data.total : undefined;
  const showMoreVisible = data.hasMore || loadingMore;

  const lastLogPreview = useMemo(
    () => (data.lines.length > 0 ? extractLastLogPreview(data.lines) : null),
    [data.lines]
  );

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

  // ── Container ref callback ────────────────────────────────────────────
  const containerRefCallback = useCallback((el: HTMLDivElement | null) => {
    logContainerRef.current = el;
  }, []);

  // ── Scroll handler ────────────────────────────────────────────────────
  const handleScroll = useCallback(
    ({
      scrollTop,
      scrollHeight,
      clientHeight,
    }: {
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
    }) => {
      const atTop = scrollTop <= 8;
      atTopRef.current = atTop;
      if (atTop && pendingCountRef.current > 0) {
        void applyPending();
        return;
      }

      if (isNearBottom(scrollTop, scrollHeight, clientHeight)) {
        void loadOlderLogs();
      }
    },
    [applyPending, isNearBottom, loadOlderLogs]
  );

  return {
    data,
    loading,
    loadingMore,
    error,
    pendingNewCount,
    isAlive,
    filteredText,
    online,
    badge,
    showMoreVisible,
    lastLogPreview,
    searchQuery,
    setSearchQuery,
    filter,
    setFilter,
    filterOpen,
    setFilterOpen,
    viewerState,
    onViewerStateChange,
    applyPending,
    loadOlderLogs,
    containerRefCallback,
    handleScroll,
  };
}
