import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';

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
}

const TASK_LOG_ACTIVITY_PULSE_MS = 1800;

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
  const [hasOpenedContent, setHasOpenedContent] = useState(isOpen);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskLogTrackingEnabled = task.status === 'in_progress' && availableTabs.includes('stream');

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
    if (pulseTimerRef.current) {
      clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }
    setIsTaskLogActivityActive(false);
  }, [task.id]);

  useEffect(() => {
    if (!taskLogTrackingEnabled || !api.teams.setTaskLogStreamTracking) {
      return;
    }

    void Promise.resolve(api.teams.setTaskLogStreamTracking(teamName, true)).catch(() => undefined);
    return () => {
      void Promise.resolve(api.teams.setTaskLogStreamTracking(teamName, false)).catch(
        () => undefined
      );
    };
  }, [taskLogTrackingEnabled, teamName]);

  useEffect(() => {
    if (!taskLogTrackingEnabled) {
      if (pulseTimerRef.current) {
        clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = null;
      }
      setIsTaskLogActivityActive(false);
      return;
    }

    const unsubscribe = api.teams.onTeamChange?.((_event, event) => {
      if (
        event.teamName !== teamName ||
        event.type !== 'task-log-change' ||
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
    });

    return () => {
      if (pulseTimerRef.current) {
        clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = null;
      }
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [task.id, taskLogTrackingEnabled, teamName]);

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
            liveEnabled={isOpen && task.status === 'in_progress'}
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
