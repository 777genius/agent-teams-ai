import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ExecutionLogStreamView,
  normalizeExecutionLogStream,
} from '@features/member-log-stream/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { selectResolvedMembersForTeamName } from '@renderer/store/slices/teamSlice';
import { isTaskLogActivityChangeEvent } from '@renderer/utils/teamChangeEvents';

import type { BoardTaskLogStreamResponse } from '@shared/types';

interface TaskLogStreamSectionProps {
  teamName: string;
  taskId: string;
  taskStatus?: string;
  liveEnabled?: boolean;
}

const LIVE_RELOAD_DEBOUNCE_MS = 350;

function describeStreamSource(stream: BoardTaskLogStreamResponse | null): string {
  if (stream?.source === 'opencode_runtime_attribution') {
    return 'Task-scoped OpenCode runtime logs projected from explicit task attribution into the same execution-log components used in Logs.';
  }
  if (stream?.source === 'opencode_runtime_fallback') {
    if (stream.runtimeProjection?.fallbackReason === 'task_tool_markers') {
      const spanCount = stream.runtimeProjection.markerSpanCount;
      const spanDetails =
        typeof spanCount === 'number' && spanCount > 1 ? ` across ${spanCount} spans` : '';
      return `Task-scoped OpenCode runtime logs projected from matched task tool markers${spanDetails} into the same execution-log components used in Logs.`;
    }
    return 'Task-scoped OpenCode runtime logs projected into the same execution-log components used in Logs.';
  }
  if (stream?.source === 'codex_native_trace_fallback') {
    return 'Task-scoped Codex native trace logs projected into the same execution-log components used in Logs.';
  }
  if (stream?.source === 'mixed_transcript_codex_native_trace') {
    return 'Task-scoped transcript logs merged with Codex native trace logs and rendered with the same execution-log components used in Logs.';
  }
  if (stream?.runtimeProjection?.provider === 'opencode') {
    return 'Task-scoped transcript logs merged with OpenCode runtime logs and rendered with the same execution-log components used in Logs.';
  }
  if (stream?.runtimeProjection?.provider === 'codex_native') {
    return 'Task-scoped transcript logs merged with Codex native trace logs and rendered with the same execution-log components used in Logs.';
  }
  return 'Task-scoped transcript logs rendered with the same execution-log components used in Logs.';
}

export const TaskLogStreamSection = ({
  teamName,
  taskId,
  taskStatus,
  liveEnabled = true,
}: TaskLogStreamSectionProps): React.JSX.Element => {
  const [stream, setStream] = useState<BoardTaskLogStreamResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const teamMembers = useStore((s) => selectResolvedMembersForTeamName(s, teamName));
  const requestSeqRef = useRef(0);
  const streamRef = useRef<BoardTaskLogStreamResponse | null>(null);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  const loadStream = useCallback(
    async (options?: { background?: boolean }): Promise<void> => {
      const background = options?.background ?? false;
      const hadExistingStream = streamRef.current != null;
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;

      if (!background) setLoading(true);
      setError((prev) => (background ? prev : null));

      try {
        const response = normalizeExecutionLogStream(
          await api.teams.getTaskLogStream(teamName, taskId)
        );
        if (requestSeqRef.current !== requestSeq) return;

        setStream(response);
        setError(null);
      } catch (loadError) {
        if (requestSeqRef.current !== requestSeq) return;
        if (!background || streamRef.current == null) {
          setError(
            loadError instanceof Error ? loadError.message : 'Failed to load task log stream'
          );
          setStream(null);
        }
      } finally {
        if (requestSeqRef.current === requestSeq && (!background || !hadExistingStream)) {
          setLoading(false);
        }
      }
    },
    [taskId, teamName]
  );

  useEffect(() => {
    setStream(null);
    streamRef.current = null;
    setError(null);
    requestSeqRef.current += 1;
    if (reloadTimerRef.current) {
      clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = null;
    }
    void loadStream();
  }, [loadStream]);

  const previousTaskMetaRef = useRef({ taskId, taskStatus });

  useEffect(() => {
    const previousTaskMeta = previousTaskMetaRef.current;
    previousTaskMetaRef.current = { taskId, taskStatus };

    if (previousTaskMeta.taskId !== taskId) return;
    if (
      previousTaskMeta.taskStatus === 'in_progress' &&
      taskStatus &&
      taskStatus !== 'in_progress'
    ) {
      void loadStream({ background: true });
    }
  }, [loadStream, taskId, taskStatus]);

  useEffect(() => {
    if (!liveEnabled) {
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
      return;
    }

    const scheduleReload = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = setTimeout(() => {
        reloadTimerRef.current = null;
        void loadStream({ background: true });
      }, LIVE_RELOAD_DEBOUNCE_MS);
    };

    const unsubscribe = api.teams.onTeamChange?.((_event, event) => {
      if (event.teamName !== teamName) return;
      const shouldReload =
        event.type === 'log-source-change' ||
        (isTaskLogActivityChangeEvent(event) && event.taskId === taskId);
      if (shouldReload) scheduleReload();
    });

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') scheduleReload();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [liveEnabled, loadStream, taskId, teamName]);

  const streamDescription = useMemo(() => describeStreamSource(stream), [stream]);

  return (
    <ExecutionLogStreamView
      title="Task Log Stream"
      description={streamDescription}
      stream={stream}
      loading={loading}
      error={error}
      teamName={teamName}
      teamMembers={teamMembers}
      loadingText="Loading task log stream..."
      emptyTitle="No task log stream yet"
      emptyDescription="Task-linked logs will appear here when transcript metadata or runtime projection is available."
      selectionResetKey={`${teamName}:${taskId}`}
    />
  );
};
