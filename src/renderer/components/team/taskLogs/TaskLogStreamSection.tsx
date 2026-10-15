import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  ExecutionLogStreamView,
  normalizeExecutionLogStream,
} from '@features/member-log-stream/renderer';
import { taskDetailKey } from '@features/team-task-detail/core';
import { useStore } from '@renderer/store';
import { selectTaskDetailResourceEntry } from '@renderer/store/slices/taskDetailResourcesSlice';
import { selectResolvedMembersForTeamName } from '@renderer/store/slices/teamSlice';

import type { TaskDetailIdentity } from '@features/team-task-detail/core';
import type { BoardTaskLogStreamResponse } from '@shared/types';

interface TaskLogStreamSectionProps {
  identity: TaskDetailIdentity;
}

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
  identity,
}: TaskLogStreamSectionProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const teamMembers = useStore((state) =>
    selectResolvedMembersForTeamName(state, identity.teamName)
  );
  const entry = useStore((state) => selectTaskDetailResourceEntry(state, identity, 'log-stream'));
  const stream = useMemo(
    () =>
      entry?.data ? normalizeExecutionLogStream(entry.data as BoardTaskLogStreamResponse) : null,
    [entry?.data]
  );

  return (
    <ExecutionLogStreamView
      title={t('taskLogs.stream.title')}
      description={describeStreamSource(stream)}
      stream={stream}
      loading={Boolean(entry?.loading && !entry.loaded)}
      error={entry?.error ?? null}
      teamName={identity.teamName}
      teamMembers={teamMembers}
      loadingText="Loading task log stream..."
      emptyTitle="No task log stream yet"
      emptyDescription="Task-linked logs will appear here when transcript metadata or runtime projection is available."
      selectionResetKey={taskDetailKey(identity)}
    />
  );
};
