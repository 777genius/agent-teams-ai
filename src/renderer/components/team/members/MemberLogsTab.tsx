import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { MemberExecutionLog } from '@renderer/components/team/members/MemberExecutionLog';
import {
  type SubagentPreviewMessage,
  SubagentRecentMessagesPreview,
} from '@renderer/components/team/members/SubagentRecentMessagesPreview';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useTabIdOptional } from '@renderer/contexts/useTabUIContext';
import { useStore } from '@renderer/store';
import { asEnhancedChunkArray } from '@renderer/types/data';
import { enhanceAIGroup } from '@renderer/utils/aiGroupEnhancer';
import { formatDuration } from '@renderer/utils/formatters';
import { transformChunksToConversation } from '@renderer/utils/groupTransformer';
import { getMemberColorByName } from '@shared/constants/memberColors';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Info,
  Loader2,
  MessageSquare,
} from 'lucide-react';

import type { EnhancedChunk } from '@renderer/types/data';
import type { MemberLogSummary } from '@shared/types';

// ---------------------------------------------------------------------------
// Chunk filtering by task work intervals
// ---------------------------------------------------------------------------

const CHUNK_GRACE_BEFORE_MS = 30_000; // 30s before startedAt
const CHUNK_GRACE_AFTER_MS = 10_000; // 10s after completedAt

function filterChunksByWorkIntervals(
  chunks: EnhancedChunk[] | null,
  intervals: { startedAt: string; completedAt?: string }[] | undefined
): EnhancedChunk[] | null {
  if (!chunks) return null;
  if (!intervals || intervals.length === 0) return chunks;

  const now = Date.now();
  const parsed = intervals
    .map((i) => {
      const s = Date.parse(i.startedAt);
      if (!Number.isFinite(s)) return null;
      const e = typeof i.completedAt === 'string' ? Date.parse(i.completedAt) : null;
      return {
        startMs: s - CHUNK_GRACE_BEFORE_MS,
        endMs: e != null && Number.isFinite(e) ? e + CHUNK_GRACE_AFTER_MS : null,
      };
    })
    .filter((v): v is { startMs: number; endMs: number | null } => v !== null);

  if (parsed.length === 0) return chunks;

  const filtered = chunks.filter((chunk) => {
    const cs = chunk.startTime.getTime();
    const ce = chunk.endTime.getTime();
    if (!Number.isFinite(cs) || !Number.isFinite(ce)) return true;
    return parsed.some((i) => {
      const end = i.endMs ?? now;
      return cs <= end && ce >= i.startMs;
    });
  });
  return filtered;
}

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

const PREVIEW_PAGE_SIZE = 8;

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
  // Visibility check: skip polling when tab is hidden (display:none) to avoid OOM
  const tabId = useTabIdOptional();
  const activeTabId = useStore((s) => s.activeTabId);
  const isTabActive = tabId ? activeTabId === tabId : true; // default true when no tab context (e.g. standalone dialog)

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
    if (log.kind === 'subagent') {
      return `subagent:${log.sessionId}:${log.subagentId}`;
    }
    if (log.kind === 'member_session') {
      return `member:${log.sessionId}`;
    }
    return `lead:${log.sessionId}`;
  }, []);

  const sortedLogs = useMemo(() => {
    const nowMs = Date.now();
    const getLastActivityMs = (log: MemberLogSummary): number => {
      const startMs = new Date(log.startTime).getTime();
      if (!Number.isFinite(startMs)) return Number.NaN;
      const durationMs = Number.isFinite(log.durationMs) ? Math.max(0, log.durationMs) : 0;
      const endMs = startMs + durationMs;
      return log.isOngoing ? Math.max(endMs, nowMs) : endMs;
    };

    // When viewing a task with workIntervals, sort by overlap (most relevant first).
    // Fallback to endMs (most recent activity) when no intervals available.
    const getOverlapMs = (log: MemberLogSummary): number => {
      if (!taskWorkIntervals || taskWorkIntervals.length === 0) return 0;
      const logStartMs = new Date(log.startTime).getTime();
      if (!Number.isFinite(logStartMs)) return 0;
      const logDurationMs = Number.isFinite(log.durationMs) ? Math.max(0, log.durationMs) : 0;
      const logEndMs = log.isOngoing ? nowMs : logStartMs + logDurationMs;

      let totalOverlap = 0;
      for (const interval of taskWorkIntervals) {
        const intStart = Date.parse(interval.startedAt);
        if (!Number.isFinite(intStart)) continue;
        const intEnd =
          typeof interval.completedAt === 'string' ? Date.parse(interval.completedAt) : nowMs;
        if (!Number.isFinite(intEnd)) continue;
        const overlapStart = Math.max(logStartMs, intStart);
        const overlapEnd = Math.min(logEndMs, intEnd);
        if (overlapEnd > overlapStart) totalOverlap += overlapEnd - overlapStart;
      }
      return totalOverlap;
    };

    const withIndex = logs.map((log, index) => ({
      log,
      index,
      overlap: getOverlapMs(log),
      lastActivity: getLastActivityMs(log),
    }));

    withIndex.sort((a, b) => {
      // Primary: overlap with task workIntervals (more overlap = higher)
      if (a.overlap !== b.overlap) return b.overlap - a.overlap;
      // Secondary: last activity (most recent first)
      const aTime = a.lastActivity;
      const bTime = b.lastActivity;
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
      if (Number.isFinite(aTime) && !Number.isFinite(bTime)) return -1;
      if (!Number.isFinite(aTime) && Number.isFinite(bTime)) return 1;
      return a.index - b.index;
    });
    return withIndex.map((x) => x.log);
  }, [logs, taskWorkIntervals]);

  const shouldShowPreview = useMemo(() => {
    return taskId != null && (showSubagentPreview || showLeadPreview);
  }, [showLeadPreview, showSubagentPreview, taskId]);

  const previewLog = useMemo((): MemberLogSummary | null => {
    if (!shouldShowPreview) return null;

    if (showSubagentPreview) {
      const candidates = sortedLogs.filter(
        (l) => l.kind === 'subagent' || l.kind === 'member_session'
      );
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
    // Build lead messages from recentPreviews, filtered by taskWorkIntervals.
    const buildLeadPreviewMessages = (): SubagentPreviewMessage[] => {
      if (!previewLog) return [];

      // Use task-scoped recentPreviews when available
      if (
        previewLog.recentPreviews &&
        previewLog.recentPreviews.length > 0 &&
        taskWorkIntervals &&
        taskWorkIntervals.length > 0
      ) {
        const GRACE_BEFORE = 30_000;
        const GRACE_AFTER = 15_000;
        const now = Date.now();
        const intervals = taskWorkIntervals
          .map((i) => {
            const s = Date.parse(i.startedAt);
            if (!Number.isFinite(s)) return null;
            const e = typeof i.completedAt === 'string' ? Date.parse(i.completedAt) : null;
            return {
              startMs: s - GRACE_BEFORE,
              endMs: e != null && Number.isFinite(e) ? e + GRACE_AFTER : now + GRACE_AFTER,
            };
          })
          .filter((v): v is { startMs: number; endMs: number } => v !== null);

        if (intervals.length > 0) {
          const scoped = previewLog.recentPreviews.filter((p) => {
            const ms = Date.parse(p.timestamp);
            if (!Number.isFinite(ms)) return false;
            return intervals.some((i) => ms >= i.startMs && ms <= i.endMs);
          });
          if (scoped.length > 0) {
            return scoped.reverse().map((p, idx) => ({
              id: `${previewLog.sessionId}:recent:${idx}`,
              timestamp: new Date(p.timestamp),
              kind: 'output' as const,
              label: p.kind === 'thinking' ? 'Thinking' : 'Output',
              content: p.text,
            }));
          }
        }
      }

      // Fallback to last output/thinking
      const msgs: SubagentPreviewMessage[] = [];
      if (previewLog.lastOutputPreview) {
        msgs.push({
          id: `${previewLog.sessionId}:lastOutput`,
          timestamp: new Date(previewLog.startTime),
          kind: 'output',
          label: 'Output',
          content: previewLog.lastOutputPreview,
        });
      }
      if (previewLog.lastThinkingPreview) {
        msgs.push({
          id: `${previewLog.sessionId}:lastThinking`,
          timestamp: new Date(previewLog.startTime),
          kind: 'output',
          label: 'Thinking',
          content: previewLog.lastThinkingPreview,
        });
      }
      return msgs;
    };

    if (!previewChunks || previewChunks.length === 0) {
      if (showLeadPreview) {
        return buildLeadPreviewMessages();
      }
      return [];
    }
    const raw = extractSubagentPreviewMessages(previewChunks);
    // For lead preview, user messages are system-generated prompts (not useful).
    // Show only AI outputs — the actual work results.
    // If no outputs found, fall back to summary previews.
    if (showLeadPreview) {
      // Prefer recentPreviews (task-scoped thinking + output) over chunk extraction
      // because chunks don't capture thinking blocks.
      const fromPreviews = buildLeadPreviewMessages();
      if (fromPreviews.length > 0) return fromPreviews;
      const outputs = raw.filter((m) => m.kind !== 'user');
      if (outputs.length > 0) return outputs;
      return raw; // ultimate fallback: show everything including user messages
    }
    return raw;
  }, [previewChunks, showLeadPreview, previewLog, taskWorkIntervals]);

  const previewMessages = useMemo((): SubagentPreviewMessage[] => {
    return allPreviewMessages.slice(0, previewVisibleCount);
  }, [allPreviewMessages, previewVisibleCount]);

  const previewHasMore = allPreviewMessages.length > previewVisibleCount;

  const previewOnline = useMemo((): boolean => {
    if (!previewLog) return false;
    // Determine the most recent activity timestamp from preview messages
    const newest = previewMessages[0];
    const newestMs = newest ? newest.timestamp.getTime() : 0;
    // Fallback: use session start time when no preview messages exist
    const lastActivityMs = newestMs || new Date(previewLog.startTime).getTime() || 0;
    if (!lastActivityMs) return false;
    const ageMs = Date.now() - lastActivityMs;
    // isOngoing (file still being written) grants a longer freshness window,
    // but does NOT bypass age checks — the file may be updated by system messages
    // even while the agent is idle
    if (previewLog.isOngoing) {
      // Ongoing + in_progress: generous 3-minute window
      if (taskStatus === 'in_progress') return ageMs <= 180_000;
      // Ongoing + other status: moderate window
      return ageMs <= 60_000;
    }
    // Not ongoing: check message freshness with tighter windows
    if (!newest) return false;
    // Task actively in progress — agent may pause between visible outputs
    if (taskStatus === 'in_progress') return ageMs <= 60_000;
    // Completed/other tasks — shorter window
    return ageMs <= 15_000;
  }, [previewLog, previewMessages, taskStatus]);

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
        if (didBeginRefreshing) endRefreshing();
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    if (isTabActive || !hasLoadedRef.current) {
      void load();
    }

    const interval = shouldAutoRefresh && isTabActive ? setInterval(() => void load(), 5000) : null;

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      // Reset refresh state so the indicator doesn't stay latched
      // when the effect tears down mid-refresh (e.g. tab switch).
      refreshCountRef.current = 0;
      if (refreshHideTimeoutRef.current) {
        clearTimeout(refreshHideTimeoutRef.current);
        refreshHideTimeoutRef.current = null;
      }
      setRefreshing(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intervalsKey + taskSince drive refresh; deps intentionally minimal to avoid refetch loops
  }, [teamName, memberName, taskId, taskOwner, taskStatus, intervalsKey, taskSince, isTabActive]);

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
      if (log.kind === 'member_session') {
        const d = await api.getSessionDetail(log.projectId, log.sessionId, options);
        return d ? asEnhancedChunkArray(d.chunks) : null;
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
        const filtered = taskId ? filterChunksByWorkIntervals(next, taskWorkIntervals) : next;
        setPreviewChunks(filtered ? [...filtered] : null);
      } catch {
        if (cancelled) return;
        setPreviewChunks(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [fetchDetailForLog, previewLog, shouldShowPreview, intervalsKey]);

  useEffect(() => {
    if (!shouldShowPreview) return;
    if (!previewLog) return;

    const shouldAutoRefreshPreview = taskStatus === 'in_progress' || previewLog.isOngoing;
    if (!shouldAutoRefreshPreview || !isTabActive) return;

    let cancelled = false;
    const interval = setInterval(async () => {
      beginRefreshing();
      try {
        const next = await fetchDetailForLog(previewLog, { bypassCache: true });
        if (cancelled) return;
        const filtered = taskId ? filterChunksByWorkIntervals(next, taskWorkIntervals) : next;
        setPreviewChunks(filtered ? [...filtered] : null);
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
    intervalsKey,
    isTabActive,
  ]);

  useEffect(() => {
    const shouldAutoRefreshSummary = taskId != null && taskStatus === 'in_progress';
    if (!expandedLogSummary) return;
    if (!shouldAutoRefreshSummary && !expandedLogSummary.isOngoing) return;
    if (!isTabActive) return;

    let cancelled = false;

    const refreshDetail = async (): Promise<void> => {
      beginRefreshing();
      try {
        const next = await fetchDetailForLog(expandedLogSummary, { bypassCache: true });
        if (cancelled) return;
        const filtered = taskId ? filterChunksByWorkIntervals(next, taskWorkIntervals) : next;
        setDetailChunks(filtered ? [...filtered] : null);
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
  }, [
    beginRefreshing,
    endRefreshing,
    expandedLogSummary,
    fetchDetailForLog,
    taskId,
    taskStatus,
    intervalsKey,
    isTabActive,
  ]);

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
        const filtered = taskId ? filterChunksByWorkIntervals(chunks, taskWorkIntervals) : chunks;
        setDetailChunks(filtered ? [...filtered] : null);
      } catch {
        setDetailChunks(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [expandedId, fetchDetailForLog, getRowId, taskStatus, intervalsKey]
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
  const createdAgo = formatRelativeTime(log.startTime);
  const lastActivityTime = useMemo(() => {
    const startMs = new Date(log.startTime).getTime();
    if (!Number.isFinite(startMs) || log.durationMs <= 0) return null;
    return new Date(startMs + log.durationMs).toISOString();
  }, [log.startTime, log.durationMs]);
  const updatedAgo = lastActivityTime ? formatRelativeTime(lastActivityTime) : null;

  const memberColorCss = useMemo(() => {
    if (!log.memberName) return null;
    const colorName = getMemberColorByName(log.memberName);
    return getTeamColorSet(colorName).text;
  }, [log.memberName]);

  return (
    <div className="min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
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
            {memberColorCss && (
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: memberColorCss }}
              />
            )}
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[var(--color-text)]" title={log.description}>
                  {log.description}
                </span>
                {(log.kind === 'lead_session' || log.kind === 'member_session') && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="shrink-0 cursor-help text-[var(--color-text-muted)]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Info size={11} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[240px] text-center">
                      {log.kind === 'lead_session'
                        ? 'Full team lead session logs - useful for global orchestration context, not specific to this agent'
                        : 'Full persistent teammate session logs - useful when work runs in a root member session instead of a subagent file'}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-3 text-[10px] text-[var(--color-text-muted)]">
                {updatedAgo && updatedAgo !== createdAgo ? (
                  <>
                    <span className="flex items-center gap-1">
                      <Clock size={10} />
                      {updatedAgo}
                    </span>
                    <span style={{ opacity: 0.4 }}>started {createdAgo}</span>
                  </>
                ) : (
                  <span className="flex items-center gap-1">
                    <Clock size={10} />
                    {createdAgo}
                  </span>
                )}
                {log.durationMs > 0 && <span>{formatDuration(log.durationMs)}</span>}
                <span className="flex items-center gap-1">
                  <MessageSquare size={10} />
                  {log.messageCount}
                </span>
                {log.isOngoing && (
                  <span className="rounded-full bg-green-500/20 px-1.5 text-green-400">active</span>
                )}
              </div>
              {log.lastOutputPreview && !expanded && (
                <div
                  className="mt-1 truncate text-[10px] text-[var(--color-text-muted)]"
                  style={{ opacity: 0.6 }}
                >
                  {log.lastOutputPreview}
                </div>
              )}
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
                memberName={
                  log.kind === 'lead_session' || log.kind === 'member_session'
                    ? (log.memberName ?? undefined)
                    : undefined
                }
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
