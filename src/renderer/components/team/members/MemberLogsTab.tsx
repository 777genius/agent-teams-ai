import { useCallback, useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { MemberExecutionLog } from '@renderer/components/team/members/MemberExecutionLog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { formatDuration } from '@renderer/utils/formatters';
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
}

export const MemberLogsTab = ({
  teamName,
  memberName,
  taskId,
  taskOwner,
  taskStatus,
  taskWorkIntervals,
}: MemberLogsTabProps): React.JSX.Element => {
  const [logs, setLogs] = useState<MemberLogSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailChunks, setDetailChunks] = useState<EnhancedChunk[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let isInitial = true;
    const shouldAutoRefresh = taskId != null && taskStatus === 'in_progress';

    const load = async (): Promise<void> => {
      try {
        if (taskId == null && !memberName) {
          if (!cancelled) setLogs([]);
          return;
        }
        if (isInitial) {
          setLoading(true);
        }
        setError(null);

        const result =
          taskId != null
            ? await api.teams.getLogsForTask(teamName, taskId, {
                owner: taskOwner,
                status: taskStatus,
                intervals: taskWorkIntervals,
              })
            : await api.teams.getMemberLogs(teamName, memberName!);
        if (!cancelled) {
          setLogs(result);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Unknown error');
        }
      } finally {
        if (!cancelled && isInitial) {
          setLoading(false);
        }
        isInitial = false;
      }
    };

    void load();

    const interval = shouldAutoRefresh ? setInterval(() => void load(), 5000) : null;

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [teamName, memberName, taskId, taskOwner, taskStatus, taskWorkIntervals]);

  const handleExpand = useCallback(
    async (log: MemberLogSummary) => {
      const rowId =
        log.kind === 'subagent'
          ? `subagent:${log.sessionId}:${log.subagentId}`
          : `lead:${log.sessionId}`;

      if (expandedId === rowId) {
        setExpandedId(null);
        setDetailChunks(null);
        return;
      }
      setExpandedId(rowId);
      setDetailChunks(null);
      setDetailLoading(true);
      try {
        if (log.kind === 'subagent') {
          const d = await api.getSubagentDetail(log.projectId, log.sessionId, log.subagentId);
          setDetailChunks(d?.chunks ?? null);
        } else {
          const d = await api.getSessionDetail(log.projectId, log.sessionId);
          setDetailChunks((d?.chunks ?? null) as unknown as EnhancedChunk[] | null);
        }
      } catch {
        setDetailChunks(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [expandedId]
  );

  if (loading) {
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
    <div className="max-h-[400px] w-full min-w-0 space-y-1.5 overflow-y-auto overflow-x-hidden pr-1">
      {logs.map((log) => (
        <LogCard
          key={
            log.kind === 'subagent' ? `${log.sessionId}-${log.subagentId}` : `lead-${log.sessionId}`
          }
          log={log}
          expanded={
            expandedId ===
            (log.kind === 'subagent'
              ? `subagent:${log.sessionId}:${log.subagentId}`
              : `lead:${log.sessionId}`)
          }
          detailChunks={
            expandedId ===
            (log.kind === 'subagent'
              ? `subagent:${log.sessionId}:${log.subagentId}`
              : `lead:${log.sessionId}`)
              ? detailChunks
              : null
          }
          detailLoading={
            expandedId ===
              (log.kind === 'subagent'
                ? `subagent:${log.sessionId}:${log.subagentId}`
                : `lead:${log.sessionId}`) && detailLoading
          }
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
    <div className="min-w-0 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="flex w-full min-w-0 items-center gap-2 overflow-hidden px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-raised)]"
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
            <div className="max-h-[360px] w-full min-w-0 overflow-y-auto overflow-x-hidden pr-1">
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
