import { useEffect, useMemo, useRef, useState } from 'react';

import { createTaskLogObservabilityRendererTransport } from '@features/task-log-observability/renderer';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { isTaskLogActivityChangeEvent } from '@renderer/utils/teamChangeEvents';
import { isDisplayableCurrentTask } from '@renderer/utils/teamTaskDisplayState';

import { ExecutionSessionsSection } from './ExecutionSessionsSection';
import { isBoardTaskActivityUiEnabled, isBoardTaskExactLogsUiEnabled } from './featureGates';
import { TaskActivitySection } from './TaskActivitySection';
import { TaskLogStreamSection } from './TaskLogStreamSection';

import type { TeamTaskWithKanban } from '@shared/types';

type TaskLogsTab = 'activity' | 'stream' | 'sessions';

interface TaskLogsPanelProps {
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

const TASK_LOG_ACTIVITY_PULSE_MS = 1800;
const TASK_LOG_COUNT_RELOAD_DEBOUNCE_MS = 350;
const taskLogObservabilityTransport = createTaskLogObservabilityRendererTransport();

export const TaskLogsPanel = ({
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
    if (isBoardTaskExactLogsUiEnabled()) {
      tabs.push('stream');
    }
    if (isBoardTaskActivityUiEnabled()) {
      tabs.push('activity');
    }
    tabs.push('sessions');
    return tabs;
  }, []);

  const defaultTab = availableTabs[0] ?? 'sessions';
  const [activeTab, setActiveTab] = useState<TaskLogsTab>(defaultTab);
  const [isTaskLogActivityActive, setIsTaskLogActivityActive] = useState(false);
  const [taskLogSegmentCount, setTaskLogSegmentCount] = useState<number | null>(null);
  const [hasOpenedContent, setHasOpenedContent] = useState(isOpen);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countRequestSeqRef = useRef(0);
  const hasTaskLogStream = availableTabs.includes('stream');
  const taskIsActivelyWorked = isDisplayableCurrentTask(task);
  const taskLogActivityTrackingEnabled = taskIsActivelyWorked && hasTaskLogStream;
  const taskLogSummaryEnabled = hasOpenedContent && hasTaskLogStream;

  useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab, task.id]);

  useEffect(() => {
    if (!availableTabs.includes(activeTab)) {
      setActiveTab(defaultTab);
    }
  }, [activeTab, availableTabs, defaultTab]);

  useEffect(() => {
    if (isOpen) {
      setHasOpenedContent(true);
    }
  }, [isOpen]);

  useEffect(() => {
    onTaskLogActivityChange?.(isTaskLogActivityActive);
  }, [isTaskLogActivityActive, onTaskLogActivityChange]);

  useEffect(() => {
    onTaskLogCountChange?.(
      taskLogSegmentCount != null && taskLogSegmentCount > 0 ? taskLogSegmentCount : undefined
    );
  }, [onTaskLogCountChange, taskLogSegmentCount]);

  useEffect(() => {
    if (pulseTimerRef.current) {
      clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }
    if (countReloadTimerRef.current) {
      clearTimeout(countReloadTimerRef.current);
      countReloadTimerRef.current = null;
    }
    countRequestSeqRef.current += 1;
    setIsTaskLogActivityActive(false);
    setTaskLogSegmentCount(null);
  }, [task.id]);

  useEffect(() => {
    const getTaskLogStreamSummary = taskLogObservabilityTransport.getTaskLogStreamSummary;
    if (!taskLogSummaryEnabled || !getTaskLogStreamSummary) {
      setTaskLogSegmentCount(null);
      return;
    }

    const requestSeq = countRequestSeqRef.current + 1;
    countRequestSeqRef.current = requestSeq;

    void Promise.resolve(getTaskLogStreamSummary(teamName, task.id))
      .then((summary) => {
        if (countRequestSeqRef.current !== requestSeq) {
          return;
        }
        setTaskLogSegmentCount(summary.segmentCount);
      })
      .catch(() => {
        if (countRequestSeqRef.current !== requestSeq) {
          return;
        }
        setTaskLogSegmentCount((prev) => prev);
      });
  }, [task.id, taskLogSummaryEnabled, teamName]);

  useEffect(() => {
    const setTaskLogStreamTracking = taskLogObservabilityTransport.setTaskLogStreamTracking;
    if (!taskLogActivityTrackingEnabled || !setTaskLogStreamTracking) {
      return;
    }

    void Promise.resolve(setTaskLogStreamTracking(teamName, true)).catch(() => undefined);
    return () => {
      void Promise.resolve(setTaskLogStreamTracking(teamName, false)).catch(() => undefined);
    };
  }, [taskLogActivityTrackingEnabled, teamName]);

  useEffect(() => {
    if (!taskLogActivityTrackingEnabled) {
      if (pulseTimerRef.current) {
        clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = null;
      }
      if (countReloadTimerRef.current) {
        clearTimeout(countReloadTimerRef.current);
        countReloadTimerRef.current = null;
      }
      setIsTaskLogActivityActive(false);
      return;
    }

    const scheduleCountReload = (): void => {
      const getTaskLogStreamSummary = taskLogObservabilityTransport.getTaskLogStreamSummary;
      if (!taskLogSummaryEnabled || !getTaskLogStreamSummary) {
        return;
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      if (countReloadTimerRef.current) {
        clearTimeout(countReloadTimerRef.current);
      }
      countReloadTimerRef.current = setTimeout(() => {
        countReloadTimerRef.current = null;
        const requestSeq = countRequestSeqRef.current + 1;
        countRequestSeqRef.current = requestSeq;
        void Promise.resolve(getTaskLogStreamSummary(teamName, task.id))
          .then((summary) => {
            if (countRequestSeqRef.current !== requestSeq) {
              return;
            }
            setTaskLogSegmentCount(summary.segmentCount);
          })
          .catch(() => undefined);
      }, TASK_LOG_COUNT_RELOAD_DEBOUNCE_MS);
    };

    const unsubscribe = taskLogObservabilityTransport.subscribeToTeamChanges((event) => {
      if (
        event.teamName !== teamName ||
        !isTaskLogActivityChangeEvent(event) ||
        event.taskId !== task.id
      ) {
        return;
      }

      setIsTaskLogActivityActive(true);
      if (pulseTimerRef.current) {
        clearTimeout(pulseTimerRef.current);
      }
      pulseTimerRef.current = setTimeout(() => {
        pulseTimerRef.current = null;
        setIsTaskLogActivityActive(false);
      }, TASK_LOG_ACTIVITY_PULSE_MS);
      scheduleCountReload();
    });

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        scheduleCountReload();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      if (pulseTimerRef.current) {
        clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = null;
      }
      if (countReloadTimerRef.current) {
        clearTimeout(countReloadTimerRef.current);
        countReloadTimerRef.current = null;
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [task.id, taskLogActivityTrackingEnabled, taskLogSummaryEnabled, teamName]);

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as TaskLogsTab)}
      className="space-y-3"
    >
      <TabsList className="bg-[var(--color-surface-raised)]/80 h-auto w-full justify-start gap-1 rounded-lg p-1">
        {availableTabs.includes('stream') ? (
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

      {availableTabs.includes('stream') && hasOpenedContent ? (
        <TabsContent value="stream" className="mt-0">
          <TaskLogStreamSection
            teamName={teamName}
            taskId={task.id}
            taskStatus={task.status}
            liveEnabled={isOpen && taskIsActivelyWorked}
          />
        </TabsContent>
      ) : null}

      {availableTabs.includes('activity') && hasOpenedContent ? (
        <TabsContent value="activity" className="mt-0">
          <TaskActivitySection teamName={teamName} taskId={task.id} enabled={isOpen} />
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
            enabled={isOpen}
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
