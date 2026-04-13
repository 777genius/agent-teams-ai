import { useEffect, useMemo, useState } from 'react';

import { ExecutionSessionsSection } from './ExecutionSessionsSection';
import { isBoardTaskActivityUiEnabled, isBoardTaskExactLogsUiEnabled } from './featureGates';
import { TaskActivitySection } from './TaskActivitySection';
import { TaskLogStreamSection } from './TaskLogStreamSection';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';

import type { TeamTaskWithKanban } from '@shared/types';

type TaskLogsTab = 'activity' | 'stream' | 'sessions';

interface TaskLogsPanelProps {
  teamName: string;
  task: TeamTaskWithKanban;
  taskSince?: string;
  isExecutionRefreshing?: boolean;
  isExecutionPreviewOnline?: boolean;
  onRefreshingChange?: (isRefreshing: boolean) => void;
  showSubagentPreview?: boolean;
  showLeadPreview?: boolean;
  onPreviewOnlineChange?: (isOnline: boolean) => void;
}

export const TaskLogsPanel = ({
  teamName,
  task,
  taskSince,
  isExecutionRefreshing = false,
  isExecutionPreviewOnline = false,
  onRefreshingChange,
  showSubagentPreview = false,
  showLeadPreview = false,
  onPreviewOnlineChange,
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

  useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab, task.id]);

  useEffect(() => {
    if (!availableTabs.includes(activeTab)) {
      setActiveTab(defaultTab);
    }
  }, [activeTab, availableTabs, defaultTab]);

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

      {availableTabs.includes('stream') ? (
        <TabsContent value="stream" className="mt-0">
          <TaskLogStreamSection teamName={teamName} taskId={task.id} />
        </TabsContent>
      ) : null}

      {availableTabs.includes('activity') ? (
        <TabsContent value="activity" className="mt-0">
          <TaskActivitySection teamName={teamName} taskId={task.id} />
        </TabsContent>
      ) : null}

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
          onRefreshingChange={onRefreshingChange}
          showSubagentPreview={showSubagentPreview}
          showLeadPreview={showLeadPreview}
          onPreviewOnlineChange={onPreviewOnlineChange}
        />
      </TabsContent>
    </Tabs>
  );
};
