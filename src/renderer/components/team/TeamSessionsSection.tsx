import { useCallback, useMemo } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { resolveProjectIdByPath } from '@renderer/utils/projectLookup';
import { formatSessionLabel } from '@renderer/utils/sessionTitleParser';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  AlertCircle,
  Crown,
  ExternalLink,
  Filter,
  FilterX,
  Loader2,
  MessageSquare,
  Monitor,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import type { Session } from '@renderer/types/data';

interface TeamSessionsSectionProps {
  sessions: Session[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  leadSessionId?: string;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string | null) => void;
  projectPath?: string;
}

export const TeamSessionsSection = ({
  sessions,
  sessionsLoading,
  sessionsError,
  leadSessionId,
  selectedSessionId,
  onSelectSession,
  projectPath,
}: TeamSessionsSectionProps): React.JSX.Element => {
  const { openTab, selectSession, projects, repositoryGroups } = useStore(
    useShallow((s) => ({
      openTab: s.openTab,
      selectSession: s.selectSession,
      projects: s.projects,
      repositoryGroups: s.repositoryGroups,
    }))
  );

  const projectId = useMemo(
    () => resolveProjectIdByPath(projectPath, projects, repositoryGroups),
    [projects, repositoryGroups, projectPath]
  );

  // Sort: lead session first, then by most recent
  const sortedSessions = useMemo(() => {
    if (!leadSessionId) return sessions;
    return [...sessions].sort((a, b) => {
      if (a.id === leadSessionId) return -1;
      if (b.id === leadSessionId) return 1;
      return b.createdAt - a.createdAt;
    });
  }, [sessions, leadSessionId]);

  const handleSessionClick = useCallback(
    (session: Session) => {
      if (!projectId) return;
      openTab(
        {
          type: 'session',
          sessionId: session.id,
          projectId,
          label: formatSessionLabel(session.firstMessage),
        },
        { forceNewTab: true }
      );
      selectSession(session.id);
    },
    [projectId, openTab, selectSession]
  );

  if (!projectPath) {
    return (
      <div className="py-6 text-center text-xs text-[var(--color-text-muted)]">
        <Monitor size={20} className="mx-auto mb-2 opacity-40" />
        No project path linked
        <p className="mt-1 text-[10px] opacity-60">Sessions will appear after team provisioning</p>
      </div>
    );
  }

  if (!projectId) {
    return (
      <div className="py-6 text-center text-xs text-[var(--color-text-muted)]">
        <AlertCircle size={20} className="mx-auto mb-2 opacity-40" />
        Project not found
        <p className="mt-1 max-w-[260px] truncate text-[10px] opacity-60">{projectPath}</p>
      </div>
    );
  }

  if (sessionsLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-xs text-[var(--color-text-muted)]">
        <Loader2 size={14} className="animate-spin" />
        Loading sessions...
      </div>
    );
  }

  if (sessionsError) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-xs text-red-400">
        <AlertCircle size={14} />
        {sessionsError}
      </div>
    );
  }

  if (sortedSessions.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-[var(--color-text-muted)]">
        <Monitor size={20} className="mx-auto mb-2 opacity-40" />
        No sessions found
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {selectedSessionId !== null && (
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-blue-600 transition-colors hover:bg-blue-500/10 dark:text-blue-400"
          onClick={() => onSelectSession(null)}
        >
          <FilterX size={12} />
          Show for all sessions
        </button>
      )}
      {sortedSessions.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          isLead={session.id === leadSessionId}
          isSelected={session.id === selectedSessionId}
          onClick={() => handleSessionClick(session)}
          onToggleFilter={() =>
            onSelectSession(session.id === selectedSessionId ? null : session.id)
          }
        />
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Session row
// ---------------------------------------------------------------------------

interface SessionRowProps {
  session: Session;
  isLead: boolean;
  isSelected: boolean;
  onClick: () => void;
  onToggleFilter: () => void;
}

const SessionRow = ({
  session,
  isLead,
  isSelected,
  onClick,
  onToggleFilter,
}: SessionRowProps): React.JSX.Element => {
  const timeAgo = formatShortTime(new Date(session.createdAt));
  const label = formatSessionLabel(session.firstMessage);

  return (
    <div
      className={`group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)] ${
        isLead ? 'border border-blue-500/20 bg-blue-500/5' : ''
      } ${isSelected ? 'bg-blue-500/10 ring-1 ring-blue-400/50' : ''}`}
    >
      {isLead && <Crown size={12} className="shrink-0 text-blue-400" />}

      <button type="button" className="min-w-0 flex-1 text-left" onClick={onClick}>
        <div className="flex items-center gap-1.5">
          {session.isOngoing && (
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-green-400" />
          )}
          <span className="truncate text-[var(--color-text)]">{label}</span>
        </div>

        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
          <span className="flex items-center gap-0.5">
            <MessageSquare size={9} />
            {session.messageCount}
          </span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span className="tabular-nums">{timeAgo}</span>
          {isLead && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <span className="text-blue-600 dark:text-blue-400">lead</span>
            </>
          )}
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`rounded p-0.5 text-[var(--color-text-muted)] transition-opacity hover:text-blue-400 ${
                isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFilter();
              }}
            >
              {isSelected ? <FilterX size={12} /> : <Filter size={12} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {isSelected ? 'Remove filter' : 'Filter by this session'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="rounded p-0.5 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:text-[var(--color-text)] group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onClick();
              }}
            >
              <ExternalLink size={12} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Open session</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatShortTime(date: Date): string {
  const distance = formatDistanceToNowStrict(date, { addSuffix: false });
  return distance
    .replace(' seconds', 's')
    .replace(' second', 's')
    .replace(' minutes', 'm')
    .replace(' minute', 'm')
    .replace(' hours', 'h')
    .replace(' hour', 'h')
    .replace(' days', 'd')
    .replace(' day', 'd')
    .replace(' weeks', 'w')
    .replace(' week', 'w')
    .replace(' months', 'mo')
    .replace(' month', 'mo')
    .replace(' years', 'y')
    .replace(' year', 'y');
}
