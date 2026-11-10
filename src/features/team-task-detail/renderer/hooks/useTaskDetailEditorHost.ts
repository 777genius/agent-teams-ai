import { useCallback, useEffect } from 'react';

import { useStore } from '@renderer/store';
import { isTaskDetailEditorTargetCurrent } from '@renderer/store/team/taskDetailEditorRoute';

import type { TaskDetailFileLinkIntent } from '../context/TaskDetailFileLinkContext';

export function useTaskDetailEditorHost({
  teamName,
  tabId,
  active,
  projectPath,
  metadataUnavailable = false,
  openEditor,
}: {
  teamName: string;
  tabId: string | null;
  active: boolean;
  projectPath: string | null;
  metadataUnavailable?: boolean;
  openEditor: () => void;
}): (intent: TaskDetailFileLinkIntent) => boolean {
  const request = useStore((state) => state.pendingTaskDetailEditorRequest);
  const legacyReveal = useStore((state) => state.editorPendingRevealFile);
  const fileTreeError = useStore((state) => state.editorFileTreeError);
  const editorReady = useStore((state) =>
    projectPath
      ? state.editorProjectPath === projectPath &&
        !state.editorFileTreeLoading &&
        state.editorFileTree !== null
      : false
  );

  useEffect(() => {
    if (
      active &&
      ((legacyReveal && useStore.getState().activeTabId === tabId) ||
        (request && isTaskDetailEditorTargetCurrent(useStore.getState(), request, teamName, tabId)))
    )
      openEditor();
  }, [active, legacyReveal, openEditor, request, tabId, teamName]);

  useEffect(() => {
    const state = useStore.getState();
    if (
      active &&
      request &&
      request.status !== 'blocked' &&
      isTaskDetailEditorTargetCurrent(state, request, teamName, tabId) &&
      (metadataUnavailable ||
        (state.editorProjectPath === request.projectPath && fileTreeError) ||
        (projectPath !== null && projectPath !== request.projectPath))
    ) {
      state.setPendingTaskDetailEditorRequest({ ...request, status: 'blocked' });
      return;
    }
    if (
      !active ||
      !request ||
      !editorReady ||
      !isTaskDetailEditorTargetCurrent(state, request, teamName, tabId)
    )
      return;
    state.setPendingTaskDetailEditorRequest({ ...request, status: 'opening' });
    const isCurrent = () => {
      const current = useStore.getState();
      return (
        current.pendingTaskDetailEditorRequest?.status === 'opening' &&
        isTaskDetailEditorTargetCurrent(current, request, teamName, tabId)
      );
    };
    if (!isCurrent()) return;
    try {
      if (request.line !== null) state.setPendingGoToLine(request.line);
      state.revealFileInEditor(request.filePath);
      if (isCurrent()) state.setPendingTaskDetailEditorRequest(null);
    } catch {
      if (isCurrent()) state.setPendingTaskDetailEditorRequest({ ...request, status: 'blocked' });
    }
  }, [
    active,
    editorReady,
    fileTreeError,
    metadataUnavailable,
    projectPath,
    request,
    tabId,
    teamName,
  ]);

  return useCallback((intent: TaskDetailFileLinkIntent) => {
    return useStore.getState().openTaskDetailEditor(
      { contextId: intent.contextId, teamName: intent.teamName, taskId: intent.taskId },
      {
        projectPath: intent.projectPath,
        filePath: intent.filePath,
        line: intent.line,
      }
    );
  }, []);
}
