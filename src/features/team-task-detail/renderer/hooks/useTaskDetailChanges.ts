import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';
import { selectTaskDetailResourceEntry } from '@renderer/store/slices/taskDetailResourcesSlice';
import { resolveTaskChangePresenceFromResult } from '@renderer/utils/taskChangePresence';
import {
  buildTaskChangeRequestOptions,
  buildTaskChangeSignature,
  deriveTaskSince,
} from '@renderer/utils/taskChangeRequest';
import { classifyTaskChangeReviewability } from '@shared/utils/taskChangeReviewability';

import type {
  FileChangeSummary,
  TaskChangeReviewability,
  TaskChangeSetV2,
  TeamTaskWithKanban,
} from '@shared/types';

export interface TaskDetailChangesState {
  badge: string | number | undefined;
  error: string | null;
  files: FileChangeSummary[] | null;
  loading: boolean;
  open: boolean;
  reviewability: TaskChangeReviewability | null;
  sectionOpen: boolean;
  since: string | undefined;
  warnings: string[];
}

export interface TaskDetailChangesActions {
  openFile: (filePath: string) => void;
  refresh: () => void;
  setOpen: (open: boolean) => void;
}

export function useTaskDetailChanges({
  active,
  enabled,
  contextId,
  surfaceId,
  isOriginCurrent,
  onOpenFile,
  task,
  teamName,
}: {
  active: boolean;
  enabled: boolean;
  contextId: string;
  surfaceId: string;
  isOriginCurrent: () => boolean;
  onOpenFile: (filePath: string) => void;
  task: TeamTaskWithKanban | null;
  teamName: string;
}): { actions: TaskDetailChangesActions; state: TaskDetailChangesState } {
  const { t } = useAppTranslation('team');
  const recordTaskChangePresence = useStore((state) => state.recordTaskChangePresence);
  const setSelectedTeamTaskChangePresence = useStore(
    (state) => state.setSelectedTeamTaskChangePresence
  );
  const ensureTaskDetailChanges = useStore((state) => state.ensureTaskDetailChanges);
  const setTaskDetailVisibleResourceDemand = useStore(
    (state) => state.setTaskDetailVisibleResourceDemand
  );
  const [sectionOpen, setSectionOpen] = useState(false);

  const since = useMemo(() => deriveTaskSince(task), [task]);
  const requestOptions = useMemo(() => (task ? buildTaskChangeRequestOptions(task) : null), [task]);
  const requestSignature = useMemo(
    () => (requestOptions ? buildTaskChangeSignature(requestOptions) : 'default'),
    [requestOptions]
  );
  const summaryOptions = useMemo(
    () => (task ? buildTaskChangeRequestOptions(task, { since, summaryOnly: true }) : null),
    [since, task]
  );
  const identity = useMemo(
    () => (task ? { contextId, teamName, taskId: task.id } : null),
    [contextId, task, teamName]
  );
  const resourceEntry = useStore((state) =>
    identity
      ? selectTaskDetailResourceEntry(state, identity, 'changes', requestSignature)
      : undefined
  );
  const data = resourceEntry?.data as TaskChangeSetV2 | null | undefined;

  useEffect(() => {
    if (!identity) return;
    setTaskDetailVisibleResourceDemand(
      surfaceId,
      identity,
      'changes',
      active && enabled,
      requestSignature
    );
    return () =>
      setTaskDetailVisibleResourceDemand(surfaceId, identity, 'changes', false, requestSignature);
  }, [
    active,
    contextId,
    enabled,
    identity,
    requestSignature,
    setTaskDetailVisibleResourceDemand,
    task?.id,
    teamName,
    surfaceId,
  ]);

  const files = data?.files ?? null;
  const status = useMemo(() => (data ? classifyTaskChangeReviewability(data) : null), [data]);
  const warnings = useMemo(() => {
    const diagnostics =
      status && status.diagnostics.length > 0
        ? status.diagnostics.map((diagnostic) => diagnostic.message)
        : (data?.warnings ?? []);
    return [...new Set(diagnostics.filter((message) => message.trim().length > 0))];
  }, [data, status]);
  const reviewability = status?.reviewability ?? null;

  useEffect(() => {
    const nextPresence = data ? resolveTaskChangePresenceFromResult(data) : null;
    if (task && requestOptions && isOriginCurrent()) {
      recordTaskChangePresence(teamName, task.id, requestOptions, nextPresence);
      setSelectedTeamTaskChangePresence(teamName, task.id, nextPresence ?? 'unknown');
    }
  }, [
    data,
    isOriginCurrent,
    recordTaskChangePresence,
    requestOptions,
    setSelectedTeamTaskChangePresence,
    task,
    teamName,
  ]);

  useEffect(() => {
    setSectionOpen(false);
  }, [contextId, teamName, identity?.taskId]);

  const requestSummary = useCallback(
    (forceFresh = false): void => {
      if (!identity || !summaryOptions || !enabled || !isOriginCurrent()) return;
      void ensureTaskDetailChanges(identity, summaryOptions, requestSignature, forceFresh);
    },
    [enabled, ensureTaskDetailChanges, identity, isOriginCurrent, requestSignature, summaryOptions]
  );

  const badge = !resourceEntry?.loading
    ? files && files.length > 0
      ? files.length
      : files && warnings.length > 0
        ? reviewability === 'attention_required'
          ? t('taskDetail.changes.badges.attention')
          : reviewability === 'diagnostic_only'
            ? t('taskDetail.changes.badges.noSafeDiff')
            : undefined
        : undefined
    : undefined;

  return {
    state: {
      badge,
      error: resourceEntry?.error ?? null,
      files,
      loading: resourceEntry?.loading ?? false,
      open: sectionOpen,
      reviewability,
      sectionOpen,
      since,
      warnings,
    },
    actions: {
      openFile: onOpenFile,
      refresh: () => requestSummary(true),
      setOpen: setSectionOpen,
    },
  };
}
