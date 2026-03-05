import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { Search, Terminal, X } from 'lucide-react';

import { CollapsibleTeamSection } from './CollapsibleTeamSection';
import { CliLogsRichView } from './CliLogsRichView';
import {
  ClaudeLogsFilterPopover,
  DEFAULT_CLAUDE_LOGS_FILTER,
} from './ClaudeLogsFilterPopover';

import type { TeamClaudeLogsResponse } from '@shared/types';
import type { ClaudeLogsFilterState } from './ClaudeLogsFilterPopover';

const PAGE_SIZE = 100;
const POLL_MS = 2000;
const ONLINE_WINDOW_MS = 10_000;

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
  let lastStream: 'stdout' | 'stderr' | null = null;

  const pushMarker = (stream: 'stdout' | 'stderr'): void => {
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

  let currentStream: 'stdout' | 'stderr' | null = null;
  let lastEmittedStream: 'stdout' | 'stderr' | null = null;
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

  const writeBlocks = (parsed: Record<string, unknown>, blocks: AssistantContentBlock[]): Record<string, unknown> => {
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
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [data, setData] = useState<TeamClaudeLogsResponse>({ lines: [], total: 0, hasMore: false });
  const [pending, setPending] = useState<TeamClaudeLogsResponse | null>(null);
  const [pendingNewCount, setPendingNewCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
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

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
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

    const computeNewCount = (committed: TeamClaudeLogsResponse, latest: TeamClaudeLogsResponse): number => {
      if (committed.lines.length === 0) return latest.lines.length;
      const marker = committed.lines[0];
      const idx = latest.lines.indexOf(marker);
      if (idx >= 0) return idx;
      const diff = (latest.total ?? latest.lines.length) - (committed.total ?? committed.lines.length);
      return Math.max(0, diff);
    };

    const fetchLogs = async (): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        setLoading(true);
        const next = await api.teams.getClaudeLogs(teamName, { offset: 0, limit: visibleCount });
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
  }, [teamName, visibleCount]);

  const online = useMemo(() => isRecent(data.updatedAt), [data.updatedAt]);
  const badge = data.total > 0 ? data.total : undefined;
  const showMoreVisible = data.hasMore;

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

  const applyPending = (): void => {
    const latest = latestRef.current ?? pending;
    if (!latest) return;
    setData(latest);
    setPending(null);
    setPendingNewCount(0);
    // Jump to newest
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  };

  return (
    <CollapsibleTeamSection
      sectionId="claude-logs"
      title="Claude logs"
      icon={<Terminal size={14} />}
      badge={badge}
      headerExtra={headerExtra}
      defaultOpen
      contentClassName="pt-0"
    >
      <div className="flex items-center justify-between gap-2 pb-2">
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {data.total > 0 ? (
            <>
              Showing <span className="font-mono">{Math.min(data.total, visibleCount)}</span> of{' '}
              <span className="font-mono">{data.total}</span>
            </>
          ) : (
            'No logs yet.'
          )}
        </span>
        <div className="flex items-center gap-2">
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
          {pendingNewCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={applyPending}
              title="Show newest logs"
            >
              +{pendingNewCount} new
            </Button>
          )}
          {showMoreVisible && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            >
              Show more
            </Button>
          )}
        </div>
      </div>

      <div
        className={cn(
          'rounded',
          loading && 'opacity-80'
        )}
      >
        {error ? <p className="p-2 text-xs text-red-300">{error}</p> : null}
        {!error && filteredText.trim().length > 0 ? (
          <CliLogsRichView
            // Parser expects chronological order; UI shows newest-first.
            cliLogsTail={filteredText}
            order="newest-first"
            className="max-h-[320px] p-2"
            containerRefCallback={(el) => {
              logContainerRef.current = el;
            }}
            onScroll={({ scrollTop }) => {
              const atTop = scrollTop <= 8;
              atTopRef.current = atTop;
              if (atTop && pendingCountRef.current > 0) {
                applyPending();
              }
            }}
          />
        ) : null}
        {!error && data.lines.length === 0 ? (
          <p className="p-2 text-xs text-[var(--color-text-muted)]">
            {loading ? 'Loading…' : 'No logs captured.'}
          </p>
        ) : null}
        {!error && data.lines.length > 0 && filteredText.trim().length === 0 ? (
          <p className="p-2 text-xs text-[var(--color-text-muted)]">
            No matching logs.
          </p>
        ) : null}
      </div>
    </CollapsibleTeamSection>
  );
};

