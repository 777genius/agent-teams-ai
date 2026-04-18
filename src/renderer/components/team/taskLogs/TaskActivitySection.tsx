import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { asEnhancedChunkArray } from '@renderer/types/data';
import { enhanceAIGroup } from '@renderer/utils/aiGroupEnhancer';
import { transformChunksToConversation } from '@renderer/utils/groupTransformer';
import {
  describeBoardTaskActivityLabel,
  formatBoardTaskActivityTaskLabel,
} from '@shared/utils/boardTaskActivityLabels';
import {
  describeBoardTaskActivityActorLabel,
  describeBoardTaskActivityContextLines,
} from '@shared/utils/boardTaskActivityPresentation';
import { AlertCircle, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

import { TaskActivityLinkedToolCard } from './TaskActivityLinkedToolCard';

import type { AIGroupDisplayItem, LinkedToolItem } from '@renderer/types/groups';
import type {
  BoardTaskActivityDetail,
  BoardTaskActivityEntry,
  BoardTaskActivityTaskRef,
} from '@shared/types';

interface TaskActivitySectionProps {
  teamName: string;
  taskId: string;
  enabled?: boolean;
}

function isHighSignalTaskActivityEntry(entry: BoardTaskActivityEntry): boolean {
  return entry.linkKind !== 'execution';
}

function compareTaskActivityEntriesDesc(
  left: BoardTaskActivityEntry,
  right: BoardTaskActivityEntry
): number {
  const leftTs = Date.parse(left.timestamp);
  const rightTs = Date.parse(right.timestamp);
  if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
    return rightTs - leftTs;
  }

  if (left.source.filePath !== right.source.filePath) {
    return right.source.filePath.localeCompare(left.source.filePath);
  }

  if (left.source.sourceOrder !== right.source.sourceOrder) {
    return right.source.sourceOrder - left.source.sourceOrder;
  }

  return right.id.localeCompare(left.id);
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

function describeCollapsedContext(entry: BoardTaskActivityEntry): string | null {
  const contextLines = describeBoardTaskActivityContextLines(entry);
  return contextLines.length > 0 ? contextLines.join(' - ') : null;
}

type ActivityDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; detail: BoardTaskActivityDetail };

type ActivityMetadataProps = Readonly<{
  detail: BoardTaskActivityDetail;
}>;

type ActivityDetailPanelProps = Readonly<{
  detailState: ActivityDetailState;
}>;

function normalizeDetail(detail: BoardTaskActivityDetail): BoardTaskActivityDetail {
  if (!detail.logDetail) {
    return detail;
  }

  return {
    ...detail,
    logDetail: {
      ...detail.logDetail,
      chunks: asEnhancedChunkArray(detail.logDetail.chunks) ?? detail.logDetail.chunks,
    },
  };
}

function getFirstRenderableLinkedTool(detail: BoardTaskActivityDetail): LinkedToolItem | null {
  if (!detail.logDetail || detail.logDetail.chunks.length === 0) {
    return null;
  }

  const conversation = transformChunksToConversation(detail.logDetail.chunks, [], false);
  for (const item of conversation.items) {
    if (item.type !== 'ai') {
      continue;
    }

    const linkedTool = enhanceAIGroup(item.group).displayItems.find(
      (displayItem): displayItem is Extract<AIGroupDisplayItem, { type: 'tool' }> =>
        displayItem.type === 'tool'
    );
    if (linkedTool) {
      return linkedTool.tool;
    }
  }

  return null;
}

const ActivityMetadata = ({ detail }: ActivityMetadataProps): React.JSX.Element | null => {
  const hasMetadata = detail.metadataRows.length > 0;
  const hasContext = detail.contextLines.length > 0;

  if (!hasMetadata && !hasContext) {
    return null;
  }

  return (
    <div className="space-y-3">
      {hasContext ? (
        <div className="space-y-1">
          {detail.contextLines.map((line) => (
            <p key={line} className="text-xs text-[var(--color-text-muted)]">
              {line}
            </p>
          ))}
        </div>
      ) : null}

      {hasMetadata ? (
        <div className="grid gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr] sm:items-start">
          {detail.metadataRows.map((row) => (
            <Fragment key={`${row.label}:${row.value}`}>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                {row.label}
              </div>
              <div className="text-sm text-[var(--color-text)]">{row.value}</div>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const ActivityDetailPanel = ({ detailState }: ActivityDetailPanelProps): React.JSX.Element => {
  if (detailState.status === 'loading') {
    return (
      <div className="border-[var(--color-border)]/20 bg-[var(--color-bg-elevated)]/18 flex items-center gap-2 rounded-md border p-3 text-xs text-[var(--color-text-muted)]">
        <Loader2 size={12} className="animate-spin" />
        Loading activity details...
      </div>
    );
  }

  if (detailState.status === 'error') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
        <AlertCircle size={12} />
        {detailState.error}
      </div>
    );
  }

  if (detailState.status === 'missing') {
    return (
      <div className="border-[var(--color-border)]/20 bg-[var(--color-bg-elevated)]/18 rounded-md border p-3 text-xs text-[var(--color-text-muted)]">
        Detailed transcript context is no longer available for this activity.
      </div>
    );
  }

  if (detailState.status !== 'ok') {
    return <></>;
  }

  const { detail } = detailState;
  const linkedTool = getFirstRenderableLinkedTool(detail);

  return (
    <div className="border-[var(--color-border)]/18 space-y-3 border-t pt-3">
      <ActivityMetadata detail={detail} />

      {linkedTool ? <TaskActivityLinkedToolCard linkedTool={linkedTool} /> : null}
    </div>
  );
};

const Row = ({
  detailState,
  entry,
  expanded,
  onToggle,
}: {
  detailState: ActivityDetailState;
  entry: BoardTaskActivityEntry;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element => {
  const context = describeCollapsedContext(entry);
  const tone =
    entry.task.resolution === 'resolved'
      ? 'text-[var(--color-text)]'
      : 'text-[var(--color-text-muted)]';

  return (
    <div
      className={`bg-[var(--color-bg-elevated)]/20 rounded-md border shadow-sm shadow-black/10 transition-colors ${
        expanded ? 'border-[var(--color-border-emphasis)]' : 'border-[var(--color-border-subtle)]'
      }`}
    >
      <button
        type="button"
        className="hover:bg-[var(--color-bg-elevated)]/28 flex w-full items-start gap-3 px-3 py-2 text-left transition-colors"
        onClick={onToggle}
      >
        <div className="pt-0.5 text-[var(--color-text-muted)]">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        <div className="min-w-12 pt-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
          {formatEntryTime(entry.timestamp)}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-sm ${tone}`}>
            <span className="font-medium">{describeBoardTaskActivityActorLabel(entry.actor)}</span>
            <span className="text-[var(--color-text-muted)]"> - </span>
            <span>{describeBoardTaskActivityLabel(entry)}</span>
          </div>
          {context ? (
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{context}</p>
          ) : null}
        </div>
      </button>

      {expanded ? (
        <div className="px-3 pb-3">
          <ActivityDetailPanel detailState={detailState} />
        </div>
      ) : null}
    </div>
  );
};

export const TaskActivitySection = ({
  teamName,
  taskId,
  enabled = true,
}: TaskActivitySectionProps): React.JSX.Element => {
  const [detailStates, setDetailStates] = useState<Record<string, ActivityDetailState>>({});
  const [entries, setEntries] = useState<BoardTaskActivityEntry[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const fetchDetail = useCallback(
    async (entry: BoardTaskActivityEntry): Promise<void> => {
      setDetailStates((prev) => ({
        ...prev,
        [entry.id]: { status: 'loading' },
      }));

      try {
        const result = await api.teams.getTaskActivityDetail(teamName, taskId, entry.id);
        setDetailStates((prev) => ({
          ...prev,
          [entry.id]:
            result.status === 'ok'
              ? { status: 'ok', detail: normalizeDetail(result.detail) }
              : { status: 'missing' },
        }));
      } catch (detailError) {
        setDetailStates((prev) => ({
          ...prev,
          [entry.id]: {
            status: 'error',
            error:
              detailError instanceof Error ? detailError.message : 'Failed to load activity detail',
          },
        }));
      }
    },
    [taskId, teamName]
  );

  const handleToggle = useCallback(
    async (entry: BoardTaskActivityEntry): Promise<void> => {
      if (expandedId === entry.id) {
        setExpandedId(null);
        return;
      }

      setExpandedId(entry.id);
      const existing = detailStates[entry.id];
      if (
        existing &&
        existing.status !== 'idle' &&
        existing.status !== 'error' &&
        existing.status !== 'loading'
      ) {
        return;
      }
      if (existing?.status === 'loading') {
        return;
      }
      await fetchDetail(entry);
    },
    [detailStates, expandedId, fetchDetail]
  );

  useEffect(() => {
    setEntries([]);
    setExpandedId(null);
    setDetailStates({});
    setError(null);
    setLoading(enabled);
    hasLoadedRef.current = false;
  }, [taskId, teamName]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      return () => {
        cancelled = true;
      };
    }

    const load = async (showSpinner: boolean): Promise<void> => {
      try {
        if (!cancelled && showSpinner) {
          setLoading(true);
        }
        if (!cancelled) {
          setError(null);
        }
        const result = await api.teams.getTaskActivity(teamName, taskId);
        if (!cancelled) {
          setEntries(result);
          hasLoadedRef.current = true;
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

    void load(!hasLoadedRef.current);
    const intervalId = window.setInterval(() => {
      void load(false);
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, teamName, taskId]);

  const visibleEntries = useMemo(
    () =>
      entries
        .filter((entry) => isHighSignalTaskActivityEntry(entry))
        .sort(compareTaskActivityEntriesDesc),
    [entries]
  );
  const hasOnlyLowSignalExecution = entries.length > 0 && visibleEntries.length === 0;

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

    if (visibleEntries.length === 0) {
      return (
        <p className="text-xs text-[var(--color-text-muted)]">
          {hasOnlyLowSignalExecution
            ? 'No key task activity was found yet. Low-level execution details are available below in Task Log Stream.'
            : 'No explicit task activity was found in the available transcripts yet. Older or heuristic session logs may still be available below in Execution Sessions.'}
        </p>
      );
    }

    return (
      <div className="space-y-2">
        {visibleEntries.map((entry) => (
          <Row
            key={entry.id}
            detailState={detailStates[entry.id] ?? { status: 'idle' }}
            entry={entry}
            expanded={expandedId === entry.id}
            onToggle={() => void handleToggle(entry)}
          />
        ))}
      </div>
    );
  }, [
    detailStates,
    error,
    expandedId,
    handleToggle,
    hasOnlyLowSignalExecution,
    loading,
    visibleEntries,
  ]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
          Task Activity
        </h4>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Key explicit runtime activity linked to this task from transcript metadata.
      </p>
      {content}
    </div>
  );
};
