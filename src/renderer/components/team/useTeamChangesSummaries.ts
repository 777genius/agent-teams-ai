import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { resolveTaskChangePresenceFromResult } from '@renderer/utils/taskChangePresence';
import { classifyTaskChangeReviewability } from '@shared/utils/taskChangeReviewability';
import { getTaskChangeStateBucket } from '@shared/utils/taskChangeState';

import { withTeamChangesLoadTimeout } from './teamChangesLoadTimeout';
import {
  buildTeamChangeRequestPlan,
  buildTeamChangesTasksFingerprint,
  TEAM_CHANGES_MAX_REQUESTS,
} from './teamChangesRequestPlan';

import type {
  TaskChangePresenceState,
  TaskChangeSetV2,
  TeamTaskChangeSummaryItem,
  TeamTaskWithKanban,
} from '@shared/types';

const TEAM_CHANGES_AUTO_REFRESH_MS = 30_000;
const TEAM_CHANGES_COUNTER_AUTO_REFRESH_MS = 60_000;
const TEAM_CHANGES_FIRST_PAINT_REQUESTS = 3;
const TEAM_CHANGES_SECOND_PAINT_REQUESTS = 9;
const TEAM_CHANGES_FIRST_UNKNOWN_SCAN_LIMIT = 3;
const TEAM_CHANGES_SECOND_UNKNOWN_SCAN_LIMIT = 6;
const TEAM_CHANGES_INITIAL_STAGED_REFRESH_PLAN = [
  TEAM_CHANGES_SECOND_PAINT_REQUESTS,
  TEAM_CHANGES_MAX_REQUESTS,
] as const;
const TEAM_CHANGES_ERROR_AUTO_RETRY_COOLDOWN_MS = 120_000;

export interface TeamChangeSummaryState {
  taskId: string;
  changeSet: TaskChangeSetV2 | null;
  error?: string;
}

export interface TeamChangeStats {
  eligibleCount: number;
  requestedCount: number;
  deferredCount: number;
}

interface TeamChangesLoadOptions {
  forceFresh?: boolean;
  showSpinner?: boolean;
  preserveOnError?: boolean;
  storeSummaries?: boolean;
  reportError?: boolean;
  blockAutoRetryOnError?: boolean;
  maxRequests?: number;
  unknownScanLimit?: number;
  queueDeferredRefresh?: boolean;
  satisfiedTaskIds?: ReadonlySet<string>;
  stagedRefreshPlan?: readonly number[];
}

interface UseTeamChangesSummariesInput {
  teamName: string;
  tasks: TeamTaskWithKanban[];
  sectionOpen: boolean;
}

interface UseTeamChangesSummariesResult {
  summariesByTaskId: Record<string, TeamChangeSummaryState>;
  badgeCount: number | null;
  stats: TeamChangeStats;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

function normalizeTeamChangeSummaryItem(item: unknown): TeamTaskChangeSummaryItem | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidate = item as Partial<TeamTaskChangeSummaryItem>;
  const taskId = typeof candidate.taskId === 'string' ? candidate.taskId.trim() : '';
  if (!taskId) {
    return null;
  }

  const changeSet =
    candidate.changeSet &&
    typeof candidate.changeSet === 'object' &&
    !Array.isArray(candidate.changeSet)
      ? candidate.changeSet
      : null;
  const error = typeof candidate.error === 'string' ? candidate.error : undefined;
  return {
    taskId,
    changeSet,
    ...(error ? { error } : {}),
  };
}

function getSafeResponseItems(response: unknown): TeamTaskChangeSummaryItem[] {
  if (
    !response ||
    typeof response !== 'object' ||
    !Array.isArray((response as { items?: unknown }).items)
  ) {
    throw new Error('Team changes response was malformed.');
  }
  return (response as { items: unknown[] }).items
    .map(normalizeTeamChangeSummaryItem)
    .filter((item): item is TeamTaskChangeSummaryItem => item !== null);
}

function hasSafeFileSummaries(changeSet: TaskChangeSetV2): boolean {
  return changeSet.files.every(
    (file) =>
      file &&
      typeof file === 'object' &&
      typeof file.filePath === 'string' &&
      file.filePath.trim().length > 0
  );
}

function hasDisplayableFileSummaries(changeSet: TaskChangeSetV2): boolean {
  return (
    Array.isArray(changeSet.files) &&
    changeSet.files.some(
      (file) =>
        file &&
        typeof file === 'object' &&
        typeof file.filePath === 'string' &&
        file.filePath.trim().length > 0
    )
  );
}

function isMinimalPresenceChangeSet(changeSet: TaskChangeSetV2): boolean {
  return Boolean(
    Array.isArray(changeSet.files) &&
    hasSafeFileSummaries(changeSet) &&
    Array.isArray(changeSet.warnings) &&
    Number.isFinite(changeSet.totalFiles) &&
    Number(changeSet.totalFiles) >= 0 &&
    typeof changeSet.computedAt === 'string' &&
    changeSet.computedAt.trim().length > 0 &&
    changeSet.scope &&
    typeof changeSet.scope === 'object' &&
    !Array.isArray(changeSet.scope)
  );
}

function resolveCacheablePresenceFromChangeSet(
  changeSet: TaskChangeSetV2
): Exclude<TaskChangePresenceState, 'unknown'> | null {
  if (!isMinimalPresenceChangeSet(changeSet)) {
    return null;
  }

  const nextPresence = resolveTaskChangePresenceFromResult(changeSet);
  if (nextPresence === 'has_changes' || nextPresence === 'needs_attention') {
    return nextPresence;
  }
  if (
    nextPresence === 'no_changes' &&
    (changeSet.confidence === 'high' || changeSet.confidence === 'medium')
  ) {
    return nextPresence;
  }
  return null;
}

function shouldClearSelectedTaskChangePresence(
  task: TeamTaskWithKanban,
  changeSet: TaskChangeSetV2
): boolean {
  if (!Array.isArray(changeSet.files) || !Array.isArray(changeSet.warnings)) {
    return false;
  }
  const reviewability = classifyTaskChangeReviewability(changeSet).reviewability;
  if (reviewability === 'diagnostic_only') {
    return true;
  }
  if (reviewability !== 'unknown') {
    return false;
  }
  if (changeSet.files.length > 0 || changeSet.warnings.length > 0) {
    return false;
  }
  return (
    getTaskChangeStateBucket({
      status: task.status,
      reviewState: task.reviewState,
      historyEvents: task.historyEvents,
      kanbanColumn: task.kanbanColumn,
      deletedAt: task.deletedAt,
    }) === 'active'
  );
}

function isCountableTeamChangeSummary(item: TeamTaskChangeSummaryItem): boolean {
  if (item.error) {
    return true;
  }

  const changeSet = item.changeSet;
  if (!changeSet) {
    return false;
  }
  if (hasDisplayableFileSummaries(changeSet)) {
    return true;
  }

  const reviewability = classifyTaskChangeReviewability(changeSet).reviewability;
  return reviewability === 'attention_required' || reviewability === 'diagnostic_only';
}

function countChangedTasks(changeCountByTaskId: Record<string, boolean>): number {
  return Object.values(changeCountByTaskId).filter(Boolean).length;
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function isSilentCounterLoad(options: TeamChangesLoadOptions | null): boolean {
  return Boolean(
    options?.storeSummaries === false &&
    options.reportError === false &&
    options.showSpinner !== true
  );
}

function getUnknownScanLimitForStage(maxRequests: number | undefined): number | undefined {
  if (maxRequests === TEAM_CHANGES_FIRST_PAINT_REQUESTS) {
    return TEAM_CHANGES_FIRST_UNKNOWN_SCAN_LIMIT;
  }
  if (maxRequests === TEAM_CHANGES_SECOND_PAINT_REQUESTS) {
    return TEAM_CHANGES_SECOND_UNKNOWN_SCAN_LIMIT;
  }
  return undefined;
}

function mergeSuccessfulTaskIds(
  existingTaskIds: ReadonlySet<string> | undefined,
  responseItems: TeamTaskChangeSummaryItem[],
  requestOptionsByTaskId: ReadonlyMap<string, unknown>
): ReadonlySet<string> | undefined {
  const next = new Set(existingTaskIds);
  for (const item of responseItems) {
    if (item.error || item.changeSet === null || !requestOptionsByTaskId.has(item.taskId)) {
      continue;
    }
    next.add(item.taskId);
  }
  return next.size > 0 ? next : undefined;
}

export function useTeamChangesSummaries({
  teamName,
  tasks,
  sectionOpen,
}: UseTeamChangesSummariesInput): UseTeamChangesSummariesResult {
  const recordTaskChangePresence = useStore((s) => s.recordTaskChangePresence);
  const setSelectedTeamTaskChangePresence = useStore((s) => s.setSelectedTeamTaskChangePresence);
  const [summariesByTaskId, setSummariesByTaskId] = useState<
    Record<string, TeamChangeSummaryState>
  >({});
  const [changeCountByTaskId, setChangeCountByTaskId] = useState<Record<string, boolean>>({});
  const [counterLoaded, setCounterLoaded] = useState(false);
  const [stats, setStats] = useState<TeamChangeStats>({
    eligibleCount: 0,
    requestedCount: 0,
    deferredCount: 0,
  });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queuedRefreshTick, setQueuedRefreshTick] = useState(0);
  const hasLoadedRef = useRef(false);
  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);
  const activeRequestSeqRef = useRef<number | null>(null);
  const activeRequestOptionsRef = useRef<TeamChangesLoadOptions | null>(null);
  const queuedRefreshOptionsRef = useRef<TeamChangesLoadOptions | null>(null);
  const autoRefreshBlockedUntilRef = useRef(0);
  const unknownScanCursorRef = useRef(0);
  const lastRequestedTasksFingerprintRef = useRef<string | null>(null);
  const lastCounterTasksFingerprintRef = useRef<string | null>(null);
  const tasksFingerprint = useMemo(() => buildTeamChangesTasksFingerprint(tasks), [tasks]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
      activeRequestSeqRef.current = null;
      activeRequestOptionsRef.current = null;
      queuedRefreshOptionsRef.current = null;
      autoRefreshBlockedUntilRef.current = 0;
      hasLoadedRef.current = false;
      unknownScanCursorRef.current = 0;
      lastRequestedTasksFingerprintRef.current = null;
      lastCounterTasksFingerprintRef.current = null;
    };
  }, []);

  const loadSummaries = useCallback(
    async ({
      forceFresh = false,
      showSpinner = false,
      preserveOnError = true,
      storeSummaries = true,
      reportError = true,
      blockAutoRetryOnError = true,
      maxRequests,
      unknownScanLimit,
      queueDeferredRefresh = false,
      satisfiedTaskIds,
      stagedRefreshPlan,
    }: TeamChangesLoadOptions = {}): Promise<void> => {
      if (forceFresh) {
        autoRefreshBlockedUntilRef.current = 0;
      } else if (autoRefreshBlockedUntilRef.current > Date.now()) {
        return;
      }

      const shouldPreemptSilentCounterLoad =
        activeRequestSeqRef.current !== null &&
        storeSummaries &&
        isSilentCounterLoad(activeRequestOptionsRef.current);
      if (shouldPreemptSilentCounterLoad) {
        requestSeqRef.current += 1;
        activeRequestSeqRef.current = null;
        activeRequestOptionsRef.current = null;
        queuedRefreshOptionsRef.current = null;
      }

      if (activeRequestSeqRef.current !== null || queuedRefreshOptionsRef.current !== null) {
        const previous = queuedRefreshOptionsRef.current;
        queuedRefreshOptionsRef.current = {
          forceFresh: Boolean(previous?.forceFresh || forceFresh),
          showSpinner: Boolean(previous?.showSpinner || showSpinner),
          preserveOnError: previous
            ? Boolean(previous.preserveOnError && preserveOnError)
            : preserveOnError,
          storeSummaries: Boolean(previous?.storeSummaries || storeSummaries),
          reportError: previous ? Boolean(previous.reportError || reportError) : reportError,
          blockAutoRetryOnError: previous
            ? Boolean(previous.blockAutoRetryOnError || blockAutoRetryOnError)
            : blockAutoRetryOnError,
          maxRequests:
            maxRequests === undefined
              ? undefined
              : previous?.maxRequests === undefined
                ? maxRequests
                : Math.max(previous.maxRequests, maxRequests),
          unknownScanLimit:
            unknownScanLimit === undefined
              ? undefined
              : previous?.unknownScanLimit === undefined
                ? unknownScanLimit
                : Math.max(previous.unknownScanLimit, unknownScanLimit),
          queueDeferredRefresh: Boolean(previous?.queueDeferredRefresh || queueDeferredRefresh),
          satisfiedTaskIds:
            previous?.satisfiedTaskIds && satisfiedTaskIds
              ? new Set(
                  [...previous.satisfiedTaskIds].filter((taskId) => satisfiedTaskIds.has(taskId))
                )
              : undefined,
          stagedRefreshPlan:
            stagedRefreshPlan !== undefined
              ? stagedRefreshPlan
              : maxRequests === undefined && unknownScanLimit === undefined
                ? undefined
                : previous?.stagedRefreshPlan,
        };
        if (showSpinner) {
          setLoading(true);
        } else if (storeSummaries) {
          setRefreshing(true);
        }
        if (activeRequestSeqRef.current === null) {
          setQueuedRefreshTick((value) => value + 1);
        }
        return;
      }

      const plan = buildTeamChangeRequestPlan(tasks, unknownScanCursorRef.current, forceFresh, {
        maxRequests,
        unknownScanLimit,
        satisfiedTaskIds,
      });
      unknownScanCursorRef.current = plan.nextUnknownScanCursor;
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;
      setStats({
        eligibleCount: plan.eligibleCount,
        requestedCount: plan.requestedCount,
        deferredCount: plan.deferredCount,
      });
      setError(null);

      if (plan.requests.length === 0) {
        if (storeSummaries) {
          setSummariesByTaskId({});
        }
        setChangeCountByTaskId({});
        setCounterLoaded(true);
        autoRefreshBlockedUntilRef.current = 0;
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (showSpinner) {
        setLoading(true);
      } else if (storeSummaries) {
        setRefreshing(true);
      }
      activeRequestSeqRef.current = requestSeq;
      activeRequestOptionsRef.current = {
        forceFresh,
        showSpinner,
        preserveOnError,
        storeSummaries,
        reportError,
        blockAutoRetryOnError,
        maxRequests,
        unknownScanLimit,
        queueDeferredRefresh,
        satisfiedTaskIds,
        stagedRefreshPlan,
      };

      try {
        const response = await withTeamChangesLoadTimeout(
          api.review.getTeamTaskChangeSummaries(teamName, plan.requests)
        );
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) {
          return;
        }
        if (queuedRefreshOptionsRef.current !== null) {
          return;
        }
        autoRefreshBlockedUntilRef.current = 0;
        const responseItems = getSafeResponseItems(response);

        const currentTaskIds = new Set(tasks.map((task) => task.id));
        const taskById = new Map<string, TeamTaskWithKanban>();
        for (const task of tasks) {
          if (!taskById.has(task.id)) {
            taskById.set(task.id, task);
          }
        }

        setChangeCountByTaskId((previous) => {
          const next: Record<string, boolean> = {};
          for (const [taskId, countable] of Object.entries(previous)) {
            if (currentTaskIds.has(taskId) && plan.eligibleTaskIds.has(taskId)) {
              next[taskId] = countable;
            }
          }
          for (const item of responseItems) {
            if (!plan.requestOptionsByTaskId.has(item.taskId)) continue;
            next[item.taskId] = isCountableTeamChangeSummary(item);
          }
          return next;
        });
        setCounterLoaded(true);

        for (const item of responseItems) {
          const changeSet = item.changeSet;
          const options = plan.requestOptionsByTaskId.get(item.taskId);
          if (!changeSet || !options) continue;

          const nextPresence = resolveCacheablePresenceFromChangeSet(changeSet);
          if (!nextPresence) {
            const task = taskById.get(item.taskId);
            if (
              task?.changePresence &&
              task.changePresence !== 'unknown' &&
              shouldClearSelectedTaskChangePresence(task, changeSet)
            ) {
              setSelectedTeamTaskChangePresence(teamName, item.taskId, 'unknown');
            }
            continue;
          }
          recordTaskChangePresence(teamName, item.taskId, options, nextPresence);
          setSelectedTeamTaskChangePresence(teamName, item.taskId, nextPresence);
        }

        if (storeSummaries) {
          setSummariesByTaskId((previous) => {
            const next: Record<string, TeamChangeSummaryState> = {};
            for (const [taskId, summary] of Object.entries(previous)) {
              if (currentTaskIds.has(taskId) && plan.eligibleTaskIds.has(taskId)) {
                next[taskId] = summary;
              }
            }
            for (const item of responseItems) {
              const options = plan.requestOptionsByTaskId.get(item.taskId);
              if (!options) continue;
              next[item.taskId] = {
                taskId: item.taskId,
                changeSet: item.changeSet,
                error: item.error,
              };
            }
            return next;
          });
        }
        if (storeSummaries && queueDeferredRefresh && plan.deferredCount > 0) {
          const [nextStageMaxRequests, ...remainingStages] = stagedRefreshPlan ?? [];
          const successfulTaskIds = mergeSuccessfulTaskIds(
            satisfiedTaskIds,
            responseItems,
            plan.requestOptionsByTaskId
          );
          queuedRefreshOptionsRef.current = {
            forceFresh,
            showSpinner: false,
            preserveOnError: true,
            storeSummaries: true,
            reportError: true,
            blockAutoRetryOnError: true,
            maxRequests: nextStageMaxRequests,
            unknownScanLimit: getUnknownScanLimitForStage(nextStageMaxRequests),
            queueDeferredRefresh: remainingStages.length > 0,
            stagedRefreshPlan: remainingStages.length > 0 ? remainingStages : undefined,
            satisfiedTaskIds: successfulTaskIds,
          };
        }
      } catch (err) {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) {
          return;
        }
        const queuedOptions = queuedRefreshOptionsRef.current;
        const shouldRunVisibleQueuedRefreshAfterSilentFailure =
          !storeSummaries &&
          !reportError &&
          Boolean(queuedOptions?.showSpinner || queuedOptions?.storeSummaries);
        if (!shouldRunVisibleQueuedRefreshAfterSilentFailure) {
          queuedRefreshOptionsRef.current = null;
        }
        if (blockAutoRetryOnError) {
          autoRefreshBlockedUntilRef.current =
            Date.now() + TEAM_CHANGES_ERROR_AUTO_RETRY_COOLDOWN_MS;
        }
        if (!preserveOnError) {
          setSummariesByTaskId({});
        }
        if (reportError) {
          setError(err instanceof Error ? err.message : 'Failed to load team changes');
        }
      } finally {
        if (mountedRef.current) {
          const hasQueuedRefresh = queuedRefreshOptionsRef.current !== null;
          if (activeRequestSeqRef.current === requestSeq) {
            activeRequestSeqRef.current = null;
            activeRequestOptionsRef.current = null;
          }
          if (hasQueuedRefresh && activeRequestSeqRef.current === null) {
            setQueuedRefreshTick((value) => value + 1);
          }
          const shouldStopIndicators =
            requestSeqRef.current === requestSeq ||
            (!hasQueuedRefresh && activeRequestSeqRef.current === null);
          if (shouldStopIndicators) {
            setLoading(false);
            setRefreshing(false);
          }
        }
      }
    },
    [recordTaskChangePresence, setSelectedTeamTaskChangePresence, tasks, teamName]
  );

  useEffect(() => {
    hasLoadedRef.current = false;
    requestSeqRef.current += 1;
    activeRequestSeqRef.current = null;
    activeRequestOptionsRef.current = null;
    queuedRefreshOptionsRef.current = null;
    autoRefreshBlockedUntilRef.current = 0;
    unknownScanCursorRef.current = 0;
    lastRequestedTasksFingerprintRef.current = null;
    lastCounterTasksFingerprintRef.current = null;
    setSummariesByTaskId({});
    setChangeCountByTaskId({});
    setCounterLoaded(false);
    setError(null);
    setStats({ eligibleCount: 0, requestedCount: 0, deferredCount: 0 });
  }, [teamName]);

  useEffect(() => {
    if (!sectionOpen) {
      requestSeqRef.current += 1;
      activeRequestSeqRef.current = null;
      activeRequestOptionsRef.current = null;
      queuedRefreshOptionsRef.current = null;
      autoRefreshBlockedUntilRef.current = 0;
      hasLoadedRef.current = false;
      lastRequestedTasksFingerprintRef.current = null;
      setSummariesByTaskId({});
      setError(null);
      setStats({ eligibleCount: 0, requestedCount: 0, deferredCount: 0 });
      setLoading(false);
      setRefreshing(false);
    }
  }, [sectionOpen]);

  useEffect(() => {
    if (sectionOpen) {
      return;
    }
    if (lastCounterTasksFingerprintRef.current === tasksFingerprint && counterLoaded) {
      return;
    }
    lastCounterTasksFingerprintRef.current = tasksFingerprint;
    void loadSummaries({
      showSpinner: false,
      preserveOnError: true,
      storeSummaries: false,
      reportError: false,
      blockAutoRetryOnError: false,
    });
  }, [counterLoaded, loadSummaries, sectionOpen, tasksFingerprint]);

  useEffect(() => {
    if (!sectionOpen || hasLoadedRef.current) {
      return;
    }
    hasLoadedRef.current = true;
    lastRequestedTasksFingerprintRef.current = tasksFingerprint;
    void loadSummaries({
      showSpinner: true,
      preserveOnError: false,
      maxRequests: TEAM_CHANGES_FIRST_PAINT_REQUESTS,
      unknownScanLimit: TEAM_CHANGES_FIRST_UNKNOWN_SCAN_LIMIT,
      queueDeferredRefresh: true,
      stagedRefreshPlan: TEAM_CHANGES_INITIAL_STAGED_REFRESH_PLAN,
    });
  }, [loadSummaries, sectionOpen, tasksFingerprint]);

  useEffect(() => {
    if (!sectionOpen || !hasLoadedRef.current) {
      return;
    }
    if (lastRequestedTasksFingerprintRef.current === tasksFingerprint) {
      return;
    }
    lastRequestedTasksFingerprintRef.current = tasksFingerprint;
    void loadSummaries({ showSpinner: false, preserveOnError: true });
  }, [loadSummaries, sectionOpen, tasksFingerprint]);

  useEffect(() => {
    if (activeRequestSeqRef.current !== null) {
      return;
    }
    const options = queuedRefreshOptionsRef.current;
    if (!options) {
      return;
    }
    queuedRefreshOptionsRef.current = null;
    void loadSummaries(options);
  }, [loadSummaries, queuedRefreshTick]);

  useEffect(() => {
    if (!sectionOpen) {
      return;
    }

    const timer = window.setInterval(() => {
      if (activeRequestSeqRef.current !== null || queuedRefreshOptionsRef.current !== null) {
        return;
      }
      void loadSummaries({ showSpinner: false, preserveOnError: true });
    }, TEAM_CHANGES_AUTO_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [loadSummaries, sectionOpen]);

  useEffect(() => {
    if (sectionOpen) {
      return;
    }

    const timer = window.setInterval(() => {
      if (isDocumentHidden()) {
        return;
      }
      if (activeRequestSeqRef.current !== null || queuedRefreshOptionsRef.current !== null) {
        return;
      }
      void loadSummaries({
        showSpinner: false,
        preserveOnError: true,
        storeSummaries: false,
        reportError: false,
        blockAutoRetryOnError: false,
      });
    }, TEAM_CHANGES_COUNTER_AUTO_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [loadSummaries, sectionOpen]);

  const refresh = useCallback(() => {
    void loadSummaries({
      forceFresh: true,
      showSpinner: true,
      preserveOnError: false,
      maxRequests: TEAM_CHANGES_FIRST_PAINT_REQUESTS,
      unknownScanLimit: TEAM_CHANGES_FIRST_UNKNOWN_SCAN_LIMIT,
      queueDeferredRefresh: true,
      stagedRefreshPlan: TEAM_CHANGES_INITIAL_STAGED_REFRESH_PLAN,
    });
  }, [loadSummaries]);

  return {
    summariesByTaskId,
    badgeCount: counterLoaded ? countChangedTasks(changeCountByTaskId) : null,
    stats,
    loading,
    refreshing,
    error,
    refresh,
  };
}
