import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { MemberExecutionLog } from '@renderer/components/team/members/MemberExecutionLog';
import {
  type SubagentPreviewMessage,
  SubagentRecentMessagesPreview,
} from '@renderer/components/team/members/SubagentRecentMessagesPreview';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { asEnhancedChunkArray } from '@renderer/types/data';
import { enhanceAIGroup } from '@renderer/utils/aiGroupEnhancer';
import { formatDuration } from '@renderer/utils/formatters';
import { transformChunksToConversation } from '@renderer/utils/groupTransformer';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  MessageSquare,
} from 'lucide-react';

import type { EnhancedChunk } from '@renderer/types/data';
import type { MemberLogSummary } from '@shared/types';

interface MemberLogsTabProps {
  teamName: string;
  memberName?: string;
  taskId?: string;
  /** When viewing task logs: include owner's sessions when task is in_progress */
  taskOwner?: string;
  taskStatus?: string;
  /** Persisted work intervals for filtering owner sessions (avoid unrelated tasks) */
  taskWorkIntervals?: { startedAt: string; completedAt?: string }[];
  /** Lower bound for log search (skip files modified before this). Derived from task creation. */
  taskSince?: string;
  /** Notifies parent when a background refresh starts/ends. */
  onRefreshingChange?: (isRefreshing: boolean) => void;
  /** Show last few subagent messages as a quick "where are we?" preview (task view only). */
  showSubagentPreview?: boolean;
  /**
   * Optional: for lead-owned tasks, show a quick preview from the lead session.
   * (This is lead activity, not "member-only" activity.)
   */
  showLeadPreview?: boolean;
  /** Notifies parent when preview looks "online" (recent output). */
  onPreviewOnlineChange?: (isOnline: boolean) => void;
}

const PREVIEW_PAGE_SIZE = 4;

export const MemberLogsTab = ({
  teamName,
  memberName,
  taskId,
  taskOwner,
  taskStatus,
  taskWorkIntervals,
  taskSince,
  onRefreshingChange,
  showSubagentPreview = false,
  showLeadPreview = false,
  onPreviewOnlineChange,
}: MemberLogsTabProps): React.JSX.Element => {
  const MIN_REFRESH_VISIBLE_MS = 250;
  const intervalsKey = useMemo(
    () => (taskWorkIntervals ? JSON.stringify(taskWorkIntervals) : ''),
    [taskWorkIntervals]
  );
  const isMountedRef = useRef(true);
  const hasLoadedRef = useRef(false);

  const [logs, setLogs] = useState<MemberLogSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const refreshCountRef = useRef(0);
  const refreshBeganAtRef = useRef<number | null>(null);
  const refreshHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailChunks, setDetailChunks] = useState<EnhancedChunk[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [previewChunks, setPreviewChunks] = useState<EnhancedChunk[] | null>(null);
  const [previewVisibleCount, setPreviewVisibleCount] = useState(PREVIEW_PAGE_SIZE);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (refreshHideTimeoutRef.current) {
        clearTimeout(refreshHideTimeoutRef.current);
        refreshHideTimeoutRef.current = null;
      }
    };
  }, []);

  const beginRefreshing = useCallback((): void => {
    if (refreshCountRef.current === 0) {
      refreshBeganAtRef.current = Date.now();
      if (refreshHideTimeoutRef.current) {
        clearTimeout(refreshHideTimeoutRef.current);
        refreshHideTimeoutRef.current = null;
      }
    }
    refreshCountRef.current += 1;
    if (isMountedRef.current) setRefreshing(true);
  }, []);

  const endRefreshing = useCallback((): void => {
    refreshCountRef.current = Math.max(0, refreshCountRef.current - 1);
    if (refreshCountRef.current > 0) {
      if (isMountedRef.current) setRefreshing(true);
      return;
    }

    const beganAt = refreshBeganAtRef.current;
    refreshBeganAtRef.current = null;
    const elapsed = beganAt ? Date.now() - beganAt : Number.POSITIVE_INFINITY;

    if (!isMountedRef.current) return;
    if (elapsed >= MIN_REFRESH_VISIBLE_MS) {
      setRefreshing(false);
      return;
    }

    const remaining = Math.max(0, MIN_REFRESH_VISIBLE_MS - elapsed);
    refreshHideTimeoutRef.current = setTimeout(() => {
      refreshHideTimeoutRef.current = null;
      if (!isMountedRef.current) return;
      if (refreshCountRef.current === 0) setRefreshing(false);
    }, remaining);
  }, []);

  const getRowId = useCallback((log: MemberLogSummary): string => {
    return log.kind === 'subagent'
      ? `subagent:${log.sessionId}:${log.subagentId}`
      : `lead:${log.sessionId}`;
  }, []);

  const sortedLogs = useMemo(() => {
    const nowMs = Date.now();
    const getLastActivityMs = (log: MemberLogSummary): number => {
      const startMs = new Date(log.startTime).getTime();
      if (!Number.isFinite(startMs)) return Number.NaN;
      const durationMs = Number.isFinite(log.durationMs) ? Math.max(0, log.durationMs) : 0;
      const endMs = startMs + durationMs;
      // Keep actively-updating logs at the top even if duration lags slightly.
      return log.isOngoing ? Math.max(endMs, nowMs) : endMs;
    };

    const withIndex = logs.map((log, index) => ({ log, index }));
    withIndex.sort((a, b) => {
      const aTime = getLastActivityMs(a.log);
      const bTime = getLastActivityMs(b.log);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
      if (Number.isFinite(aTime) && !Number.isFinite(bTime)) return -1;
      if (!Number.isFinite(aTime) && Number.isFinite(bTime)) return 1;
      return a.index - b.index;
    });
    return withIndex.map((x) => x.log);
  }, [logs]);

  const shouldShowPreview = useMemo(() => {
    return taskId != null && (showSubagentPreview || showLeadPreview);
  }, [showLeadPreview, showSubagentPreview, taskId]);

  const previewLog = useMemo((): MemberLogSummary | null => {
    if (!shouldShowPreview) return null;

    if (showSubagentPreview) {
      const candidates = sortedLogs.filter((l) => l.kind === 'subagent');
      if (candidates.length === 0) return null;

      if (taskOwner) {
        const target = taskOwner.trim().toLowerCase();
        const match = candidates.find((l) => (l.memberName ?? '').trim().toLowerCase() === target);
        // When viewing task logs, this preview is intended to show the assigned owner's progress.
        // If we can't confidently match a subagent log to the owner, don't show anything
        // rather than risk showing a different member's activity.
        return match ?? null;
      }

      return candidates[0] ?? null;
    }

    if (showLeadPreview) {
      return sortedLogs.find((l) => l.kind === 'lead_session') ?? null;
    }

    return null;
  }, [shouldShowPreview, showLeadPreview, showSubagentPreview, sortedLogs, taskOwner]);

  const allPreviewMessages = useMemo((): SubagentPreviewMessage[] => {
    if (!previewChunks || previewChunks.length === 0) return [];
    return extractSubagentPreviewMessages(previewChunks);
  }, [previewChunks]);

  const previewMessages = useMemo((): SubagentPreviewMessage[] => {
    return allPreviewMessages.slice(0, previewVisibleCount);
  }, [allPreviewMessages, previewVisibleCount]);

  const previewHasMore = allPreviewMessages.length > previewVisibleCount;

  const previewOnline = useMemo((): boolean => {
    const newest = previewMessages[0];
    if (!newest) return false;
    return Date.now() - newest.timestamp.getTime() <= 10_000;
  }, [previewMessages]);

  const expandedLogSummary = useMemo(() => {
    if (!expandedId) return null;
    return logs.find((log) => getRowId(log) === expandedId) ?? null;
  }, [expandedId, getRowId, logs]);

  useEffect(() => {
    onRefreshingChange?.(refreshing);
    return () => onRefreshingChange?.(false);
  }, [refreshing, onRefreshingChange]);

  useEffect(() => {
    onPreviewOnlineChange?.(previewOnline);
  }, [onPreviewOnlineChange, previewOnline]);

  useEffect(() => {
    setPreviewVisibleCount(PREVIEW_PAGE_SIZE);
  }, [previewLog?.kind, previewLog?.sessionId]);

  useEffect(() => {
    if (allPreviewMessages.length === 0) {
      setPreviewVisibleCount(PREVIEW_PAGE_SIZE);
      return;
    }
    setPreviewVisibleCount((prev) =>
      Math.max(PREVIEW_PAGE_SIZE, Math.min(prev, allPreviewMessages.length))
    );
  }, [allPreviewMessages.length]);

  useEffect(() => {
    return () => onPreviewOnlineChange?.(false);
  }, [onPreviewOnlineChange]);

  useEffect(() => {
    if (!expandedId) return;
    if (expandedLogSummary) return;
    setExpandedId(null);
    setDetailChunks(null);
    setDetailLoading(false);
  }, [expandedId, expandedLogSummary]);

  useEffect(() => {
    let cancelled = false;
    const shouldAutoRefresh = taskId != null && taskStatus === 'in_progress';

    const load = async (): Promise<void> => {
      let didBeginRefreshing = false;
      try {
        if (taskId == null && !memberName) {
          if (!cancelled) setLogs([]);
          return;
        }
        if (!hasLoadedRef.current) {
          setLoading(true);
        } else {
          beginRefreshing();
          didBeginRefreshing = true;
        }
        setError(null);

        const result =
          taskId != null
            ? await api.teams.getLogsForTask(teamName, taskId, {
                owner: taskOwner,
                status: taskStatus,
                intervals: taskWorkIntervals,
                since: taskSince,
              })
            : await api.teams.getMemberLogs(teamName, memberName!);
        const nextLogs = Array.isArray(result) ? [...result] : [];

        if (!cancelled) {
          setLogs(nextLogs);
          hasLoadedRef.current = true;
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Unknown error');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (didBeginRefreshing) endRefreshing();
        }
      }
    };

    void load();

    const interval = shouldAutoRefresh ? setInterval(() => void load(), 5000) : null;

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intervalsKey + taskSince drive refresh; deps intentionally minimal to avoid refetch loops
  }, [teamName, memberName, taskId, taskOwner, taskStatus, intervalsKey, taskSince]);

  const fetchDetailForLog = useCallback(
    async (
      log: MemberLogSummary,
      options?: { bypassCache?: boolean }
    ): Promise<EnhancedChunk[] | null> => {
      if (log.kind === 'subagent') {
        const d = await api.getSubagentDetail(
          log.projectId,
          log.sessionId,
          log.subagentId,
          options
        );
        return d?.chunks ?? null;
      }
      const d = await api.getSessionDetail(log.projectId, log.sessionId, options);
      return d ? asEnhancedChunkArray(d.chunks) : null;
    },
    []
  );

  useEffect(() => {
    if (!shouldShowPreview) {
      setPreviewChunks(null);
      return;
    }
    if (!previewLog) {
      setPreviewChunks(null);
      return;
    }

    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const next = await fetchDetailForLog(previewLog);
        if (cancelled) return;
        setPreviewChunks(next ? [...next] : null);
      } catch {
        if (cancelled) return;
        setPreviewChunks(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [fetchDetailForLog, previewLog, shouldShowPreview]);

  useEffect(() => {
    if (!shouldShowPreview) return;
    if (!previewLog) return;

    const shouldAutoRefreshPreview = taskStatus === 'in_progress' || previewLog.isOngoing;
    if (!shouldAutoRefreshPreview) return;

    let cancelled = false;
    const interval = setInterval(async () => {
      beginRefreshing();
      try {
        const next = await fetchDetailForLog(previewLog, { bypassCache: true });
        if (cancelled) return;
        setPreviewChunks(next ? [...next] : null);
      } catch {
        // keep last successful preview
      } finally {
        endRefreshing();
      }
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    beginRefreshing,
    endRefreshing,
    fetchDetailForLog,
    previewLog,
    shouldShowPreview,
    taskStatus,
  ]);

  useEffect(() => {
    const shouldAutoRefreshSummary = taskId != null && taskStatus === 'in_progress';
    if (!expandedLogSummary) return;
    if (!shouldAutoRefreshSummary && !expandedLogSummary.isOngoing) return;

    let cancelled = false;

    const refreshDetail = async (): Promise<void> => {
      beginRefreshing();
      try {
        const next = await fetchDetailForLog(expandedLogSummary, { bypassCache: true });
        if (cancelled) return;
        // Ensure new reference so memoized transforms update.
        setDetailChunks(next ? [...next] : null);
      } catch {
        // Keep last successful data; avoid flicker during transient errors.
      } finally {
        endRefreshing();
      }
    };

    void refreshDetail();
    const interval = setInterval(() => void refreshDetail(), 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [beginRefreshing, endRefreshing, expandedLogSummary, fetchDetailForLog, taskId, taskStatus]);

  const handleExpand = useCallback(
    async (log: MemberLogSummary) => {
      const rowId = getRowId(log);

      if (expandedId === rowId) {
        setExpandedId(null);
        setDetailChunks(null);
        return;
      }
      setExpandedId(rowId);
      setDetailChunks(null);
      setDetailLoading(true);
      try {
        const shouldBypassCache = log.isOngoing || taskStatus === 'in_progress';
        const chunks = await fetchDetailForLog(
          log,
          shouldBypassCache ? { bypassCache: true } : undefined
        );
        setDetailChunks(chunks ? [...chunks] : null);
      } catch {
        setDetailChunks(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [expandedId, fetchDetailForLog, getRowId, taskStatus]
  );

  if (loading && logs.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-xs text-[var(--color-text-muted)]">
        <Loader2 size={14} className="animate-spin" />
        Searching logs...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-xs text-red-400">
        <AlertCircle size={14} />
        {error}
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-[var(--color-text-muted)]">
        <FileText size={20} className="mx-auto mb-2 opacity-40" />
        No logs found
        <p className="mt-1 text-[10px] opacity-60">
          {taskId != null
            ? taskStatus === 'in_progress'
              ? 'Task is in progress — waiting for session activity (auto-refreshing)...'
              : 'No session activity for this task yet'
            : 'This member has no recorded session activity yet'}
        </p>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 space-y-1.5">
      {shouldShowPreview && previewLog && previewMessages.length > 0 ? (
        <SubagentRecentMessagesPreview
          messages={previewMessages}
          memberName={previewLog.memberName ?? undefined}
          hasMore={previewHasMore}
          onLoadMore={() => setPreviewVisibleCount((prev) => prev + PREVIEW_PAGE_SIZE)}
        />
      ) : null}
      {sortedLogs.map((log) => (
        <LogCard
          key={getRowId(log)}
          log={log}
          expanded={expandedId === getRowId(log)}
          detailChunks={expandedId === getRowId(log) ? detailChunks : null}
          detailLoading={expandedId === getRowId(log) && detailLoading}
          onToggle={() => void handleExpand(log)}
        />
      ))}
    </div>
  );
};

interface LogCardProps {
  log: MemberLogSummary;
  expanded: boolean;
  detailChunks: EnhancedChunk[] | null;
  detailLoading: boolean;
  onToggle: () => void;
}

const LogCard = ({
  log,
  expanded,
  detailChunks,
  detailLoading,
  onToggle,
}: LogCardProps): React.JSX.Element => {
  const timeAgo = formatRelativeTime(log.startTime);

  return (
    <div className="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] [overflow:clip]">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="sticky -top-6 z-10 flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-t-md border-b border-transparent bg-[var(--color-surface)] px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-raised)]"
            onClick={onToggle}
          >
            {expanded ? (
              <ChevronDown size={12} className="shrink-0 text-[var(--color-text-muted)]" />
            ) : (
              <ChevronRight size={12} className="shrink-0 text-[var(--color-text-muted)]" />
            )}
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="truncate text-[var(--color-text)]" title={log.description}>
                {log.description}
              </div>
              <div className="mt-0.5 flex items-center gap-3 text-[10px] text-[var(--color-text-muted)]">
                <span className="flex items-center gap-1">
                  <Clock size={10} />
                  {timeAgo}
                </span>
                {log.durationMs > 0 && <span>{formatDuration(log.durationMs)}</span>}
                <span className="flex items-center gap-1">
                  <MessageSquare size={10} />
                  {log.messageCount}
                </span>
                {log.isOngoing && (
                  <span className="rounded-full bg-green-500/20 px-1.5 text-green-400">active</span>
                )}
              </div>
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{expanded ? 'Hide details' : 'Show details'}</TooltipContent>
      </Tooltip>

      {expanded && (
        <div className="border-t border-[var(--color-border)] px-3 py-2">
          {detailLoading && (
            <div className="flex items-center gap-2 py-4 text-xs text-[var(--color-text-muted)]">
              <Loader2 size={12} className="animate-spin" />
              Loading details...
            </div>
          )}
          {!detailLoading && !detailChunks && (
            <div className="py-4 text-xs text-[var(--color-text-muted)]">
              Failed to load details
            </div>
          )}
          {!detailLoading && detailChunks && (
            <div className="w-full min-w-0">
              <MemberExecutionLog
                chunks={detailChunks}
                memberName={log.kind === 'lead_session' ? (log.memberName ?? undefined) : undefined}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function extractSubagentPreviewMessages(chunks: EnhancedChunk[]): SubagentPreviewMessage[] {
  const conversation = transformChunksToConversation(chunks, [], false);

  const out: SubagentPreviewMessage[] = [];

  // Collect newest-first.
  for (let i = conversation.items.length - 1; i >= 0; i--) {
    const item = conversation.items[i];
    if (item.type === 'ai') {
      const enhanced = enhanceAIGroup(item.group);
      const items = enhanced.displayItems ?? [];
      for (let j = items.length - 1; j >= 0; j--) {
        const di = items[j];
        if (di.type === 'output' && di.content.trim()) {
          out.push({
            id: `${item.group.id}:output:${di.timestamp.toISOString()}:${j}`,
            timestamp: di.timestamp,
            kind: 'output',
            label: 'Output',
            content: di.content,
          });
        } else if (di.type === 'teammate_message') {
          out.push({
            id: `${item.group.id}:teammate:${di.teammateMessage.id}`,
            timestamp: di.teammateMessage.timestamp,
            kind: 'teammate_message',
            label: `Message — ${di.teammateMessage.teammateId}`,
            content: di.teammateMessage.content || di.teammateMessage.summary,
          });
        }
      }
    } else if (item.type === 'user') {
      const text = item.group.content.rawText ?? item.group.content.text ?? '';
      if (text.trim()) {
        out.push({
          id: `${item.group.id}:user:${item.group.timestamp.toISOString()}`,
          timestamp: item.group.timestamp,
          kind: 'user',
          label: 'User',
          content: text,
        });
      }
    }
  }

  return out;
}
