import { api } from '@renderer/api';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  describeBoardTaskActivityLabel,
  formatBoardTaskActivityTaskLabel,
} from '@shared/utils/boardTaskActivityLabels';

import type { BoardTaskActivityEntry, BoardTaskActivityTaskRef } from '@shared/types';

interface TaskActivitySectionProps {
  teamName: string;
  taskId: string;
}

function formatEntryTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '--:--';
  }
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTaskLabel(task: BoardTaskActivityTaskRef | undefined): string | null {
  return formatBoardTaskActivityTaskLabel(task);
}

function relationshipContextLabel(entry: BoardTaskActivityEntry): string | null {
  const peerTaskLabel = formatTaskLabel(entry.action?.peerTask);
  if (!peerTaskLabel) return null;

  switch (entry.action?.relationshipPerspective) {
    case 'incoming':
      return `from ${peerTaskLabel}`;
    case 'outgoing':
      return `to ${peerTaskLabel}`;
    default:
      return `with ${peerTaskLabel}`;
  }
}

function describeContext(entry: BoardTaskActivityEntry): string | null {
  const parts: string[] = [];

  const relationshipContext = relationshipContextLabel(entry);
  if (relationshipContext) {
    parts.push(relationshipContext);
  }

  if (entry.actorContext.relation === 'other_active_task') {
    const activeTaskLabel = formatTaskLabel(entry.actorContext.activeTask);
    if (activeTaskLabel) {
      parts.push(`while working on ${activeTaskLabel}`);
    } else {
      parts.push('while another task was active');
    }
  } else if (entry.actorContext.relation === 'ambiguous') {
    parts.push('while multiple task scopes were active');
  } else if (entry.actorContext.relation === 'idle' && entry.linkKind !== 'execution') {
    parts.push('without an active task scope');
  }

  if (entry.task.resolution === 'deleted') {
    parts.push('task is deleted');
  } else if (entry.task.resolution === 'ambiguous') {
    parts.push('task resolution is ambiguous');
  } else if (entry.task.resolution === 'unresolved') {
    parts.push('task could not be resolved');
  }

  return parts.length > 0 ? parts.join(' - ') : null;
}

function actorLabel(entry: BoardTaskActivityEntry): string {
  if (entry.actor.memberName) {
    return entry.actor.memberName;
  }
  if (entry.actor.role === 'lead' || entry.actor.isSidechain === false) {
    return 'lead session';
  }
  return 'unknown actor';
}

function Row({ entry }: { entry: BoardTaskActivityEntry }): React.JSX.Element {
  const context = describeContext(entry);
  const tone =
    entry.task.resolution === 'resolved'
      ? 'text-[var(--color-text)]'
      : 'text-[var(--color-text-muted)]';

  return (
    <div className="border-[var(--color-border-muted)]/60 bg-[var(--color-bg-elevated)]/40 rounded-md border px-3 py-2">
      <div className="flex items-start gap-3">
        <div className="min-w-12 pt-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
          {formatEntryTime(entry.timestamp)}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-sm ${tone}`}>
            <span className="font-medium">{actorLabel(entry)}</span>
            <span className="text-[var(--color-text-muted)]"> - </span>
            <span>{describeBoardTaskActivityLabel(entry)}</span>
          </div>
          {context ? (
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{context}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function TaskActivitySection({
  teamName,
  taskId,
}: TaskActivitySectionProps): React.JSX.Element {
  const [entries, setEntries] = useState<BoardTaskActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        if (!cancelled && entries.length === 0) {
          setLoading(true);
        }
        if (!cancelled) {
          setError(null);
        }
        const result = await api.teams.getTaskActivity(teamName, taskId);
        if (!cancelled) {
          setEntries(result);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load task activity');
          setEntries([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    const intervalId = window.setInterval(() => {
      void load();
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [entries.length, teamName, taskId]);

  const content = useMemo(() => {
    if (loading) {
      return (
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          <Loader2 size={12} className="animate-spin" />
          Loading task activity...
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          <AlertCircle size={12} />
          {error}
        </div>
      );
    }

    if (entries.length === 0) {
      return (
        <p className="text-xs text-[var(--color-text-muted)]">
          No explicit task activity was found in the available transcripts yet. Older or heuristic
          session logs may still be available below in Execution Sessions.
        </p>
      );
    }

    return (
      <div className="space-y-2">
        {entries.map((entry) => (
          <Row key={entry.id} entry={entry} />
        ))}
      </div>
    );
  }, [entries, error, loading]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
          Task Activity
        </h4>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Explicit runtime activity linked to this task from transcript metadata.
      </p>
      {content}
    </div>
  );
}
