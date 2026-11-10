import { useEffect, useMemo, useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { useStore } from '@renderer/store';
import { selectTaskDetailResourceEntry } from '@renderer/store/slices/taskDetailResourcesSlice';
import { isDisplayableCurrentTask } from '@renderer/utils/teamTaskDisplayState';

import { ExecutionSessionsSection } from './ExecutionSessionsSection';
import { isBoardTaskActivityUiEnabled, isBoardTaskExactLogsUiEnabled } from './featureGates';
import { TaskActivitySection } from './TaskActivitySection';
import { TaskLogStreamSection } from './TaskLogStreamSection';

import type { BoardTaskLogStreamSummary } from '@shared/types';
import type { TeamTaskWithKanban } from '@shared/types';

type TaskLogsTab = 'activity' | 'stream' | 'sessions';

interface TaskLogsPanelProps {
  contextId: string;
  surfaceId: string;
  visible: boolean;
  teamName: string;
  task: TeamTaskWithKanban;
  isOpen?: boolean;
  taskSince?: string;
  isExecutionRefreshing?: boolean;
  isExecutionPreviewOnline?: boolean;
  onRefreshingChange?: (isRefreshing: boolean) => void;
  showSubagentPreview?: boolean;
  showLeadPreview?: boolean;
  onPreviewOnlineChange?: (isOnline: boolean) => void;
  onTaskLogActivityChange?: (isActive: boolean) => void;
  onTaskLogCountChange?: (count: number | undefined) => void;
}

export const TaskLogsPanel = ({
  contextId,
  surfaceId,
  visible,
  teamName,
  task,
  isOpen = true,
  taskSince,
  isExecutionRefreshing = false,
  isExecutionPreviewOnline = false,
  onRefreshingChange,
  showSubagentPreview = false,
  showLeadPreview = false,
  onPreviewOnlineChange,
  onTaskLogActivityChange,
  onTaskLogCountChange,
}: TaskLogsPanelProps): React.JSX.Element => {
  const availableTabs = useMemo<TaskLogsTab[]>(() => {
    const tabs: TaskLogsTab[] = [];
    if (isBoardTaskExactLogsUiEnabled()) tabs.push('stream');
    if (isBoardTaskActivityUiEnabled()) tabs.push('activity');
    tabs.push('sessions');
    return tabs;
  }, []);
  const defaultTab = availableTabs[0] ?? 'sessions';
  const [activeTab, setActiveTab] = useState<TaskLogsTab>(defaultTab);
  const [hasOpenedContent, setHasOpenedContent] = useState(isOpen);
  const setTaskDetailVisibleResourceDemand = useStore(
    (state) => state.setTaskDetailVisibleResourceDemand
  );
  const identity = useMemo(
    () => ({ contextId, teamName, taskId: task.id }),
    [contextId, task.id, teamName]
  );
  const summaryEntry = useStore((state) =>
    selectTaskDetailResourceEntry(state, identity, 'log-summary')
  );
  const streamEntry = useStore((state) =>
    selectTaskDetailResourceEntry(state, identity, 'log-stream')
  );
  const activityEntry = useStore((state) =>
    selectTaskDetailResourceEntry(state, identity, 'activity')
  );
  const taskIsActivelyWorked = isDisplayableCurrentTask(task);
  const hasTaskLogStream = availableTabs.includes('stream');
  const taskLogSummaryEnabled = hasOpenedContent && hasTaskLogStream;
  const panelVisible = visible && isOpen;
  const summary = summaryEntry?.data as BoardTaskLogStreamSummary | null | undefined;
  const taskLogStreamCount = summary?.segmentCount;
  const taskLogActivityActive =
    panelVisible &&
    taskIsActivelyWorked &&
    Boolean(
      summaryEntry?.loading ||
      summaryEntry?.refreshPending ||
      streamEntry?.loading ||
      streamEntry?.refreshPending ||
      activityEntry?.loading ||
      activityEntry?.refreshPending
    );

  useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab, task.id]);

  useEffect(() => {
    if (!availableTabs.includes(activeTab)) setActiveTab(defaultTab);
  }, [activeTab, availableTabs, defaultTab]);

  useEffect(() => {
    if (isOpen) setHasOpenedContent(true);
  }, [isOpen]);

  useEffect(() => {
    onTaskLogActivityChange?.(taskLogActivityActive);
  }, [onTaskLogActivityChange, taskLogActivityActive]);

  useEffect(() => {
    onTaskLogCountChange?.(
      taskLogStreamCount != null && taskLogStreamCount > 0 ? taskLogStreamCount : undefined
    );
  }, [onTaskLogCountChange, taskLogStreamCount]);

  useEffect(() => {
    const demandSurfaceId = `${surfaceId}:task-logs:${task.id}`;
    const demand = (kind: 'log-summary' | 'log-stream' | 'activity', enabled: boolean): void => {
      setTaskDetailVisibleResourceDemand(demandSurfaceId, identity, kind, enabled);
    };
    demand('log-summary', panelVisible && taskLogSummaryEnabled);
    demand('log-stream', panelVisible && activeTab === 'stream');
    demand('activity', panelVisible && activeTab === 'activity');
    return () => {
      demand('log-summary', false);
      demand('log-stream', false);
      demand('activity', false);
    };
  }, [
    activeTab,
    identity,
    panelVisible,
    setTaskDetailVisibleResourceDemand,
    surfaceId,
    task.id,
    taskLogSummaryEnabled,
  ]);

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as TaskLogsTab)}
      className="space-y-3"
    >
      <TabsList className="bg-[var(--color-surface-raised)]/80 h-auto w-full justify-start gap-1 rounded-lg p-1">
        {hasTaskLogStream ? (
          <TabsTrigger value="stream" className="gap-1.5">
            Task Log Stream
          </TabsTrigger>
        ) : null}
        {availableTabs.includes('activity') ? (
          <TabsTrigger value="activity" className="gap-1.5">
            Task Activity
          </TabsTrigger>
        ) : null}
        <TabsTrigger value="sessions" className="gap-1.5">
          Execution Sessions
        </TabsTrigger>
      </TabsList>

      {hasTaskLogStream && hasOpenedContent ? (
        <TabsContent value="stream" className="mt-0">
          <TaskLogStreamSection identity={identity} />
        </TabsContent>
      ) : null}

      {availableTabs.includes('activity') && hasOpenedContent ? (
        <TabsContent value="activity" className="mt-0">
          <TaskActivitySection
            identity={identity}
            enabled={panelVisible && activeTab === 'activity'}
          />
        </TabsContent>
      ) : null}

      {hasOpenedContent ? (
        <TabsContent value="sessions" className="mt-0">
          <ExecutionSessionsSection
            teamName={teamName}
            taskId={task.id}
            taskOwner={task.owner}
            taskStatus={task.status}
            taskWorkIntervals={task.workIntervals}
            taskSince={taskSince}
            isRefreshing={isExecutionRefreshing}
            isPreviewOnline={isExecutionPreviewOnline}
            enabled={panelVisible && activeTab === 'sessions'}
            onRefreshingChange={onRefreshingChange}
            showSubagentPreview={showSubagentPreview}
            showLeadPreview={showLeadPreview}
            onPreviewOnlineChange={onPreviewOnlineChange}
          />
        </TabsContent>
      ) : null}
    </Tabs>
  );
};
