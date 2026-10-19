import { createContext, useContext, useMemo } from 'react';

export interface TaskDetailFileLinkIntent {
  contextId: string;
  teamName: string;
  taskId: string;
  projectPath: string;
  filePath: string;
  line: number | null;
}

interface TaskDetailFileLinkContextValue {
  contextId: string;
  teamName: string;
  taskId: string;
  projectPath: string;
  openFile: (filePath: string, line: number | null) => void;
}

const TaskDetailFileLinkContext = createContext<TaskDetailFileLinkContextValue | null>(null);

export const TaskDetailFileLinkProvider = ({
  contextId,
  teamName,
  taskId,
  projectPath,
  onOpenFile,
  children,
}: {
  contextId: string;
  teamName: string;
  taskId: string;
  projectPath: string;
  onOpenFile: (intent: TaskDetailFileLinkIntent) => void;
  children: React.ReactNode;
}): React.JSX.Element => {
  const value = useMemo(
    () => ({
      contextId,
      teamName,
      taskId,
      projectPath,
      openFile: (filePath: string, line: number | null) =>
        onOpenFile({ contextId, teamName, taskId, projectPath, filePath, line }),
    }),
    [contextId, onOpenFile, projectPath, taskId, teamName]
  );
  return (
    <TaskDetailFileLinkContext.Provider value={value}>
      {children}
    </TaskDetailFileLinkContext.Provider>
  );
};

export function useTaskDetailFileLink(): TaskDetailFileLinkContextValue | null {
  return useContext(TaskDetailFileLinkContext);
}
