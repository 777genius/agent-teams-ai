import { useCallback, useRef, useState } from 'react';

import { useStore } from '@renderer/store';

import type { InlineChip } from '@renderer/types/inlineChip';
import type { MessageTaskSeed } from '@renderer/types/messageTaskSeed';

interface CreateTaskDialogState {
  open: boolean;
  messageOrigin?: { contextId: string; teamName: string; source: MessageTaskSeed['source'] };
  defaultSubject: string;
  defaultDescription: string;
  defaultOwner: string;
  defaultStartImmediately?: boolean;
  defaultChip?: InlineChip;
}

const CLOSED_TASK_DIALOG: CreateTaskDialogState = {
  open: false,
  defaultSubject: '',
  defaultDescription: '',
  defaultOwner: '',
};

/** Own each task dialog's message origin separately from ordinary Kanban defaults. */
export function useTeamCreateTaskDialog(teamName: string) {
  const contextId = useStore((state) => state.activeContextId);
  const currentOwnerRef = useRef({ contextId, teamName });
  currentOwnerRef.current = { contextId, teamName };
  const [createTaskDialog, setCreateTaskDialog] =
    useState<CreateTaskDialogState>(CLOSED_TASK_DIALOG);
  const origin = createTaskDialog.messageOrigin;
  const isCreateTaskOriginCurrent =
    !origin ||
    (origin.contextId === contextId &&
      origin.teamName === teamName &&
      origin.source.teamName === teamName);
  const openCreateTaskDialog = useCallback(
    (subject = '', description = '', owner = '', startImmediately?: boolean): void => {
      setCreateTaskDialog({
        open: true,
        defaultSubject: subject,
        defaultDescription: description,
        defaultOwner: owner,
        defaultStartImmediately: startImmediately,
      });
    },
    []
  );
  const closeCreateTaskDialog = useCallback(() => setCreateTaskDialog(CLOSED_TASK_DIALOG), []);
  const handleCreateTaskFromMessage = useCallback(
    (seed: MessageTaskSeed) => {
      const current = currentOwnerRef.current;
      if (
        current.contextId !== contextId ||
        current.teamName !== teamName ||
        useStore.getState().activeContextId !== contextId ||
        seed.source.teamName !== teamName
      )
        return;
      setCreateTaskDialog({
        open: true,
        defaultSubject: seed.subject,
        defaultDescription: seed.description,
        defaultOwner: '',
        messageOrigin: { contextId, teamName, source: { ...seed.source } },
      });
    },
    [contextId, teamName]
  );
  const assertCreateTaskOriginCurrent = useCallback(() => {
    if (
      !isCreateTaskOriginCurrent ||
      currentOwnerRef.current.teamName !== teamName ||
      useStore.getState().activeContextId !== contextId
    ) {
      throw new Error('The task message context has changed. Reopen the task from the message.');
    }
  }, [contextId, isCreateTaskOriginCurrent, teamName]);
  const defaultMessageGroupChatId = (kanbanGroupChatId?: string | null): string | null =>
    origin ? (origin.source.groupChatId ?? null) : (kanbanGroupChatId ?? null);
  return {
    createTaskDialog,
    setCreateTaskDialog,
    openCreateTaskDialog,
    closeCreateTaskDialog,
    handleCreateTaskFromMessage,
    isCreateTaskOriginCurrent,
    assertCreateTaskOriginCurrent,
    defaultMessageGroupChatId,
  };
}
