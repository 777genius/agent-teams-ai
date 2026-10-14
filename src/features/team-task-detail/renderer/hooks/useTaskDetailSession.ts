import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useStore } from '@renderer/store';
import {
  captureTaskDetailReadScope,
  isTaskDetailReadScopeCurrent,
  isTaskDetailTeamUnavailable,
} from '@renderer/store/team/taskDetailReadAuthority';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import { buildReplyBlock } from '@renderer/utils/agentMessageFormatting';
import {
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { categorizeFile, getEffectiveMimeType } from '@shared/constants/attachments';
import { useShallow } from 'zustand/react/shallow';

import {
  EMPTY_TASK_DETAIL_SESSION,
  isValidTaskDetailIdentity,
  taskDetailKey,
} from '../../core/domain';
import { taskDraftStorage } from '../adapters/taskDraftStorage';

import type {
  PendingAttachment,
  TaskDetailIdentity,
  TaskDetailReplyDraft,
  TaskDetailSavePart,
  TaskDetailSession,
} from '../../contracts';
import type { CommentAttachmentPayload, TeamTaskWithKanban } from '@shared/types';
import type { InlineChip } from '@shared/types/inlineChip';

const MAX_ATTACHMENTS = 5;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

export interface TaskDetailSessionController {
  identity: TaskDetailIdentity;
  surfaceId: string;
  session: TaskDetailSession;
  isOwner: boolean;
  canEditNow: () => boolean;
  isOriginCurrent: () => boolean;
  canSubmit: boolean;
  isDraftSaved: boolean;
  attachmentError: string | null;
  setCommentText: (text: string) => void;
  setCommentChips: (chips: InlineChip[]) => void;
  addCommentChip: (chip: InlineChip) => void;
  removeCommentChip: (chipId: string) => void;
  setReply: (reply: TaskDetailReplyDraft | null) => void;
  addPendingFiles: (files: FileList | File[]) => Promise<void>;
  removePendingAttachment: (id: string) => void;
  clearAttachmentError: () => void;
  submitComment: () => Promise<void>;
  startEditSubject: () => void;
  cancelEditSubject: () => void;
  setSubjectDraft: (value: string) => void;
  saveSubject: () => Promise<void>;
  startEditDescription: () => void;
  cancelEditDescription: () => void;
  setDescriptionDraft: (value: string) => void;
  saveDescription: () => Promise<void>;
  openInTaskTab: () => boolean;
}

function readDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export function useTaskDetailSession({
  identity: requestedIdentity,
  surfaceId,
  currentTask,
  enabled = true,
}: {
  identity: TaskDetailIdentity;
  surfaceId: string;
  currentTask: TeamTaskWithKanban | null;
  enabled?: boolean;
}): TaskDetailSessionController {
  const { contextId, teamName, taskId } = requestedIdentity;
  const identity = useMemo(() => ({ contextId, teamName, taskId }), [contextId, teamName, taskId]);
  const identityKey = taskDetailKey(identity);
  const session = useStore(
    (state) => state.taskDetailSessionById[identityKey] ?? EMPTY_TASK_DETAIL_SESSION
  );
  const live = useStore(
    useShallow((state) => ({
      activeContextId: state.activeContextId,
      switching: state.isContextSwitching,
      phase: state.taskDetailById[identityKey]?.phase,
      deletionIntent: state.taskDetailById[identityKey]?.deletionIntent,
      teamUnavailable: isTaskDetailTeamUnavailable(state, identity.teamName),
      ...captureTaskDetailReadScope(identity.teamName, identity.contextId),
    }))
  );
  const scope = useMemo(
    () => ({
      contextId: identity.contextId,
      teamName: identity.teamName,
      contextEpoch: live.contextEpoch,
      teamStateEpoch: live.teamStateEpoch,
    }),
    [identity.contextId, identity.teamName, live.contextEpoch, live.teamStateEpoch]
  );
  const isOriginCurrent = useCallback(() => {
    const state = useStore.getState();
    return (
      enabled &&
      isValidTaskDetailIdentity(identity) &&
      !state.isContextSwitching &&
      state.activeContextId === identity.contextId &&
      isTaskDetailReadScopeCurrent(scope, state.activeContextId, identity.teamName)
    );
  }, [enabled, identity, scope]);
  const isOwner =
    enabled &&
    !live.switching &&
    live.activeContextId === identity.contextId &&
    !live.teamUnavailable &&
    live.phase === 'ready' &&
    live.deletionIntent === null &&
    currentTask?.id === identity.taskId &&
    !currentTask.deletedAt &&
    currentTask.status !== 'deleted' &&
    session.ownerSurfaceId === surfaceId;
  const { suggestions: taskSuggestions } = useTaskSuggestions(identity.teamName, {
    enabled: isOwner,
  });
  const [localUi, setLocalUi] = useState({
    key: identityKey,
    isSaved: false,
    attachmentError: null as string | null,
  });
  if (localUi.key !== identityKey) {
    setLocalUi({ key: identityKey, isSaved: false, attachmentError: null });
  }
  const isDraftSaved = localUi.key === identityKey && localUi.isSaved;
  const attachmentError = localUi.key === identityKey ? localUi.attachmentError : null;
  const setIsDraftSaved = useCallback(
    (isSaved: boolean) => {
      setLocalUi((current) => (current.key === identityKey ? { ...current, isSaved } : current));
    },
    [identityKey]
  );
  const setAttachmentError = useCallback(
    (error: string | null) => {
      setLocalUi((current) =>
        current.key === identityKey ? { ...current, attachmentError: error } : current
      );
    },
    [identityKey]
  );

  useEffect(() => {
    if (isOriginCurrent()) useStore.getState().claimTaskDetailOwner(identity, surfaceId);
  }, [
    identity,
    isOriginCurrent,
    live.activeContextId,
    live.phase,
    live.switching,
    live.teamUnavailable,
    session.ownerSurfaceId,
    surfaceId,
  ]);
  const ownedRevision =
    enabled && session.ownerSurfaceId === surfaceId ? session.ownerRevision : null;
  useEffect(
    () => () => {
      if (ownedRevision !== null) {
        useStore.getState().releaseTaskDetailOwner(identity, surfaceId, ownedRevision);
      }
    },
    [identity, ownedRevision, surfaceId]
  );

  useEffect(() => {
    if (!isOriginCurrent()) return;
    let cancelled = false;
    void (async () => {
      const hydration = await taskDraftStorage.hydrate(identity);
      if (cancelled || !isOriginCurrent()) return;
      useStore.getState().hydrateTaskDetailSessionDraft(identity, {
        text: hydration.text ?? undefined,
        commentChips: hydration.commentChips ?? undefined,
      });
      if (
        identity.contextId === 'local' &&
        (hydration.legacyText != null || hydration.legacyCommentChips != null)
      ) {
        const next = useStore.getState().taskDetailSessionById[identityKey];
        await taskDraftStorage.save(
          identity,
          {
            text: next?.commentText ?? hydration.legacyText ?? '',
            commentChips: next?.commentChips ?? hydration.legacyCommentChips ?? [],
          },
          { migrateLegacy: true }
        );
      }
    })().catch(() => {
      if (!cancelled && isOriginCurrent()) setIsDraftSaved(false);
    });
    return () => {
      cancelled = true;
    };
  }, [identity, identityKey, isOriginCurrent, setIsDraftSaved]);

  const requireOwner = useCallback((): boolean => {
    const state = useStore.getState();
    const current = state.taskDetailSessionById[identityKey];
    const currentTaskState = state.taskDetailById[identityKey]?.full;
    return (
      isOriginCurrent() &&
      !isTaskDetailTeamUnavailable(state, identity.teamName) &&
      current?.ownerSurfaceId === surfaceId &&
      current.ownerRevision === session.ownerRevision &&
      state.taskDetailById[identityKey]?.phase === 'ready' &&
      state.taskDetailById[identityKey]?.deletionIntent === null &&
      currentTaskState?.id === identity.taskId &&
      !currentTaskState.deletedAt &&
      currentTaskState.status !== 'deleted'
    );
  }, [identity, identityKey, isOriginCurrent, session.ownerRevision, surfaceId]);

  const persistDraft = useCallback(
    (value: { text?: string; commentChips?: InlineChip[] }) => {
      setIsDraftSaved(false);
      void taskDraftStorage
        .save(identity, value)
        .then(() => {
          if (isOriginCurrent()) setIsDraftSaved(true);
        })
        .catch(() => {
          if (isOriginCurrent()) setIsDraftSaved(false);
        });
    },
    [identity, isOriginCurrent, setIsDraftSaved]
  );

  const setCommentText = useCallback(
    (text: string) => {
      if (!requireOwner()) return;
      useStore.getState().updateTaskDetailSessionPart(identity, 'commentText', text);
      persistDraft({ text });
    },
    [identity, persistDraft, requireOwner]
  );

  const setCommentChips = useCallback(
    (chips: InlineChip[]) => {
      if (!requireOwner()) return;
      useStore.getState().updateTaskDetailSessionPart(identity, 'commentChips', chips);
      persistDraft({ commentChips: chips });
    },
    [identity, persistDraft, requireOwner]
  );

  const addCommentChip = useCallback(
    (chip: InlineChip) => {
      const current = useStore.getState().taskDetailSessionById[identityKey];
      setCommentChips([...(current?.commentChips ?? []), chip]);
    },
    [identityKey, setCommentChips]
  );

  const removeCommentChip = useCallback(
    (chipId: string) => {
      const current = useStore.getState().taskDetailSessionById[identityKey];
      setCommentChips((current?.commentChips ?? []).filter((chip) => chip.id !== chipId));
    },
    [identityKey, setCommentChips]
  );

  const setReply = useCallback(
    (reply: TaskDetailReplyDraft | null) => {
      if (!requireOwner()) return;
      useStore.getState().updateTaskDetailSessionPart(identity, 'reply', reply);
    },
    [identity, requireOwner]
  );

  const addPendingFiles = useCallback(
    async (files: FileList | File[]): Promise<void> => {
      if (!requireOwner()) return;
      setAttachmentError(null);
      const prepared: { file: File; attachment: PendingAttachment }[] = [];
      // Register the whole user selection before awaiting any FileReader. The
      // next owner can see/remove these files while this callback continues.
      for (const file of Array.from(files)) {
        if (categorizeFile(file) === 'unsupported') {
          let filePath = '';
          try {
            filePath = window.electronAPI.getPathForFile(file);
          } catch {
            /* Clipboard file. */
          }
          if (filePath) {
            const text = useStore.getState().taskDetailSessionById[identityKey]?.commentText ?? '';
            setCommentText(text ? `${filePath}\n${text}` : `${filePath}\n`);
          }
          continue;
        }
        if (file.size === 0 || file.size > MAX_FILE_SIZE) {
          setAttachmentError(
            file.size === 0
              ? `File "${file.name}" is empty`
              : `File too large: ${(file.size / (1024 * 1024)).toFixed(1)} MB (max 20 MB)`
          );
          continue;
        }
        const current = useStore.getState().taskDetailSessionById[identityKey];
        if ((current?.pendingAttachments.length ?? 0) >= MAX_ATTACHMENTS) {
          setAttachmentError(`Maximum ${MAX_ATTACHMENTS} attachments per comment`);
          continue;
        }
        const attachment: PendingAttachment = {
          id: crypto.randomUUID(),
          filename: file.name,
          mimeType: getEffectiveMimeType(file),
          base64Data: '',
          previewUrl: '',
          size: file.size,
        };
        useStore.getState().beginTaskDetailPendingAttachmentSession(identity, attachment);
        prepared.push({ file, attachment });
      }
      for (const { file, attachment } of prepared) {
        const pending = useStore.getState().taskDetailSessionById[identityKey];
        if (!pending?.pendingAttachmentPreparationIds.includes(attachment.id)) continue;
        const result = await readDataUrl(file);
        const registered = useStore
          .getState()
          .taskDetailSessionById[
            identityKey
          ]?.pendingAttachmentPreparationIds.includes(attachment.id);
        if (!registered) continue;
        const base64Data = result?.split(',')[1];
        if (!result || !base64Data) {
          useStore.getState().ignoreTaskDetailPendingAttachmentSession(identity, attachment.id);
          continue;
        }
        useStore.getState().completeTaskDetailPendingAttachmentSession(identity, attachment.id, {
          ...attachment,
          base64Data,
          previewUrl: result,
        });
      }
    },
    [identity, identityKey, requireOwner, setAttachmentError, setCommentText]
  );

  const removePendingAttachment = useCallback(
    (id: string) => {
      if (!requireOwner()) return;
      useStore.getState().ignoreTaskDetailPendingAttachmentSession(identity, id);
    },
    [identity, requireOwner]
  );

  const submitComment = useCallback(async (): Promise<void> => {
    if (!requireOwner()) return;
    const state = useStore.getState();
    const current = state.taskDetailSessionById[identityKey];
    if (!current || current.submitPending || current.pendingAttachmentPreparationIds.length > 0)
      return;
    const trimmed = stripEncodedTaskReferenceMetadata(current.commentText).trim();
    if (
      (trimmed.length === 0 && current.pendingAttachments.length === 0) ||
      trimmed.length > MAX_TEXT_LENGTH
    ) {
      return;
    }
    const serialized = serializeChipsWithText(trimmed, current.commentChips);
    const text = current.reply
      ? buildReplyBlock(current.reply.author, current.reply.text, serialized || '(image)')
      : serialized || '(image)';
    const taskRefs = extractTaskRefsFromText(current.commentText, taskSuggestions);
    const attachments: CommentAttachmentPayload[] | undefined =
      current.pendingAttachments.length > 0
        ? current.pendingAttachments.map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            base64Data: attachment.base64Data,
          }))
        : undefined;
    const revision = state.beginTaskDetailSubmitSession(identity);
    try {
      await state.addTaskComment(identity.teamName, identity.taskId, {
        text,
        attachments,
        taskRefs,
      });
      if (!isOriginCurrent()) return;
      const before = useStore.getState().taskDetailSessionById[identityKey];
      if (!before?.submitPending || before.submitRevision !== revision) return;
      useStore.getState().completeTaskDetailSubmitSession(identity, revision);
      const after = useStore.getState().taskDetailSessionById[identityKey] ?? before;
      if (after) {
        if (after.commentText === '' && after.commentChips.length === 0) {
          void taskDraftStorage.clear(identity);
        } else {
          persistDraft({ text: after.commentText, commentChips: after.commentChips });
        }
      }
    } catch (error) {
      if (!isOriginCurrent()) return;
      useStore
        .getState()
        .failTaskDetailSubmitSession(
          identity,
          revision,
          error instanceof Error ? error.message : 'Failed to add comment'
        );
    }
  }, [identity, identityKey, isOriginCurrent, persistDraft, requireOwner, taskSuggestions]);

  const startEditSubject = useCallback(() => {
    if (!requireOwner() || !currentTask) return;
    useStore.getState().updateTaskDetailSessionPart(identity, 'subject', currentTask.subject);
  }, [currentTask, identity, requireOwner]);

  const setSubjectDraft = useCallback(
    (value: string) => {
      if (!requireOwner()) return;
      useStore.getState().updateTaskDetailSessionPart(identity, 'subject', value);
    },
    [identity, requireOwner]
  );

  const saveField = useCallback(
    async (part: TaskDetailSavePart): Promise<void> => {
      if (!requireOwner() || !currentTask) return;
      const state = useStore.getState();
      const current = state.taskDetailSessionById[identityKey];
      if (!current || current.savedPartRevisionByPart[part] !== null) return;
      const value =
        part === 'subject' ? current.subjectDraft.trim() : current.descriptionDraft.trim();
      const existing = part === 'subject' ? currentTask.subject : (currentTask.description ?? '');
      if (!value && part === 'subject') return;
      if (value === existing) {
        const revision = state.beginTaskDetailSaveSession(identity, [part]);
        state.completeTaskDetailSaveSession(identity, revision);
        return;
      }
      const revision = state.beginTaskDetailSaveSession(identity, [part]);
      try {
        await state.updateTaskFields(identity.teamName, identity.taskId, {
          [part]: value,
        });
        if (isOriginCurrent())
          useStore.getState().completeTaskDetailSaveSession(identity, revision);
      } catch (error) {
        if (!isOriginCurrent()) return;
        useStore
          .getState()
          .failTaskDetailSaveSession(
            identity,
            revision,
            error instanceof Error ? error.message : `Failed to save ${part}`
          );
      }
    },
    [currentTask, identity, identityKey, isOriginCurrent, requireOwner]
  );

  const saveSubject = useCallback(() => saveField('subject'), [saveField]);
  const cancelEditSubject = useCallback(() => {
    if (!requireOwner()) return;
    useStore.getState().updateTaskDetailSession(identity, { editingSubject: false });
  }, [identity, requireOwner]);
  const startEditDescription = useCallback(() => {
    if (!requireOwner() || !currentTask) return;
    useStore
      .getState()
      .updateTaskDetailSessionPart(identity, 'description', currentTask.description ?? '');
  }, [currentTask, identity, requireOwner]);
  const setDescriptionDraft = useCallback(
    (value: string) => {
      if (!requireOwner()) return;
      useStore.getState().updateTaskDetailSessionPart(identity, 'description', value);
    },
    [identity, requireOwner]
  );
  const saveDescription = useCallback(() => saveField('description'), [saveField]);
  const cancelEditDescription = useCallback(() => {
    if (!requireOwner()) return;
    useStore.getState().updateTaskDetailSession(identity, { editingDescription: false });
  }, [identity, requireOwner]);

  const openInTaskTab = useCallback(() => {
    if (!isOriginCurrent()) return false;
    const state = useStore.getState();
    const before = state.taskDetailSessionById[identityKey];
    if (!before) return false;
    const result = state.openTaskDetailTab(identity);
    if (!result) return false;
    if (before.ownerSurfaceId === surfaceId) {
      state.transferTaskDetailOwner(identity, surfaceId, result.tabId, before.ownerRevision);
    } else if (before.ownerSurfaceId === null) {
      state.claimTaskDetailOwner(identity, result.tabId);
    }
    return useStore.getState().taskDetailSessionById[identityKey]?.ownerSurfaceId === result.tabId;
  }, [identity, identityKey, isOriginCurrent, surfaceId]);

  return useMemo(
    () => ({
      identity,
      surfaceId,
      session,
      isOwner,
      canEditNow: requireOwner,
      isOriginCurrent,
      canSubmit:
        isOwner && !session.submitPending && session.pendingAttachmentPreparationIds.length === 0,
      isDraftSaved,
      attachmentError,
      setCommentText,
      setCommentChips,
      addCommentChip,
      removeCommentChip,
      setReply,
      addPendingFiles,
      removePendingAttachment,
      clearAttachmentError: () => setAttachmentError(null),
      submitComment,
      startEditSubject,
      cancelEditSubject,
      setSubjectDraft,
      saveSubject,
      startEditDescription,
      cancelEditDescription,
      setDescriptionDraft,
      saveDescription,
      openInTaskTab,
    }),
    [
      addCommentChip,
      addPendingFiles,
      attachmentError,
      identity,
      isDraftSaved,
      isOwner,
      isOriginCurrent,
      requireOwner,
      openInTaskTab,
      removeCommentChip,
      removePendingAttachment,
      saveDescription,
      saveSubject,
      cancelEditDescription,
      cancelEditSubject,
      session,
      setAttachmentError,
      setCommentChips,
      setCommentText,
      setDescriptionDraft,
      setReply,
      setSubjectDraft,
      startEditDescription,
      startEditSubject,
      submitComment,
      surfaceId,
    ]
  );
}
