import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
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

const TASK_CHANGES_AUTO_REFRESH_MS = 20_000;
const TASK_CHANGES_INITIAL_LOAD_DELAY_MS = 1_500;

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
  isOriginCurrent,
  onOpenFile,
  task,
  teamName,
}: {
  active: boolean;
  enabled: boolean;
  contextId: string;
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
  const [sectionOpen, setSectionOpen] = useState(false);
  const [files, setFiles] = useState<FileChangeSummary[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [reviewability, setReviewability] = useState<TaskChangeReviewability | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  const inFlightKeysRef = useRef<Set<string>>(new Set());
  const currentKeyRef = useRef<string | null>(null);

  const since = useMemo(() => deriveTaskSince(task), [task]);
  const requestOptions = useMemo(() => (task ? buildTaskChangeRequestOptions(task) : null), [task]);
  const requestSignature = useMemo(
    () => (requestOptions ? buildTaskChangeSignature(requestOptions) : null),
    [requestOptions]
  );
  const currentKey = useMemo(
    () =>
      task ? JSON.stringify([contextId, teamName, task.id, requestSignature ?? 'default']) : null,
    [contextId, requestSignature, task, teamName]
  );
  const summaryOptions = useMemo(
    () => (task ? buildTaskChangeRequestOptions(task, { since, summaryOnly: true }) : null),
    [since, task]
  );

  currentKeyRef.current = currentKey;

  useEffect(() => {
    setSectionOpen(false);
    setFiles(null);
    setWarnings([]);
    setReviewability(null);
    setLoading(false);
    setError(null);
    loadedKeyRef.current = null;
    currentKeyRef.current = currentKey;
  }, [currentKey, task?.id]);

  const syncResult = useCallback(
    (data: TaskChangeSetV2 | null) => {
      setFiles(data?.files ?? null);
      const status = data ? classifyTaskChangeReviewability(data) : null;
      const diagnostics =
        status && status.diagnostics.length > 0
          ? status.diagnostics.map((diagnostic) => diagnostic.message)
          : (data?.warnings ?? []);
      setWarnings([...new Set(diagnostics.filter((message) => message.trim().length > 0))]);
      setReviewability(status?.reviewability ?? null);
      const nextPresence = data ? resolveTaskChangePresenceFromResult(data) : null;
      if (task && requestOptions) {
        recordTaskChangePresence(teamName, task.id, requestOptions, nextPresence);
      }
      if (task) setSelectedTeamTaskChangePresence(teamName, task.id, nextPresence ?? 'unknown');
    },
    [recordTaskChangePresence, requestOptions, setSelectedTeamTaskChangePresence, task, teamName]
  );

  const requestSummary = useCallback(
    async ({
      forceFresh = false,
      retryBackfill = false,
      showSpinner = false,
      preserveFilesOnError = false,
    }: {
      forceFresh?: boolean;
      retryBackfill?: boolean;
      showSpinner?: boolean;
      preserveFilesOnError?: boolean;
    } = {}): Promise<void> => {
      const requestKey = currentKeyRef.current;
      if (!requestKey || !task || !enabled || !summaryOptions || !isOriginCurrent()) return;
      if (inFlightKeysRef.current.has(requestKey)) return;

      inFlightKeysRef.current.add(requestKey);
      if (showSpinner) setLoading(true);
      setError(null);

      try {
        const data = await api.review.getTaskChanges(teamName, task.id, {
          ...summaryOptions,
          forceFresh,
          retryBackfill,
        });
        if (currentKeyRef.current !== requestKey || !isOriginCurrent()) return;
        syncResult(data);
      } catch (cause) {
        if (currentKeyRef.current !== requestKey || !isOriginCurrent()) return;
        if (!preserveFilesOnError) {
          setFiles(null);
          setWarnings([]);
          setReviewability(null);
        }
        setError(cause instanceof Error ? cause.message : t('taskDetail.changes.loadFailed'));
      } finally {
        inFlightKeysRef.current.delete(requestKey);
        if (showSpinner && currentKeyRef.current === requestKey && isOriginCurrent())
          setLoading(false);
      }
    },
    [enabled, isOriginCurrent, summaryOptions, syncResult, t, task, teamName]
  );

  useEffect(() => {
    if (!active || !enabled || !task || !sectionOpen || !currentKey) return;
    if (loadedKeyRef.current === currentKey) return;
    if (files !== null) {
      loadedKeyRef.current = currentKey;
      return;
    }
    loadedKeyRef.current = currentKey;
    void requestSummary({ showSpinner: true });
  }, [active, currentKey, enabled, files, requestSummary, sectionOpen, task]);

  useEffect(() => {
    if (!active || !enabled || !task || sectionOpen || !currentKey || files !== null) return;
    if (loadedKeyRef.current === currentKey) return;
    const timer = window.setTimeout(() => {
      if (currentKeyRef.current !== currentKey) return;
      void requestSummary({ showSpinner: true, preserveFilesOnError: true });
    }, TASK_CHANGES_INITIAL_LOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active, currentKey, enabled, files, requestSummary, sectionOpen, task]);

  useEffect(() => {
    if (!active || !enabled || !task || !sectionOpen) return;
    const timer = window.setInterval(() => {
      void requestSummary({ forceFresh: true, preserveFilesOnError: true });
    }, TASK_CHANGES_AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, enabled, requestSummary, sectionOpen, task]);

  const badge = !loading
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
      error,
      files,
      loading,
      open: sectionOpen,
      reviewability,
      sectionOpen,
      since,
      warnings,
    },
    actions: {
      openFile: onOpenFile,
      refresh: () => {
        void requestSummary({
          forceFresh: true,
          retryBackfill: true,
          showSpinner: true,
          preserveFilesOnError: false,
        });
      },
      setOpen: (nextOpen) => {
        setSectionOpen(nextOpen);
        if (!nextOpen) loadedKeyRef.current = null;
      },
    },
  };
}
