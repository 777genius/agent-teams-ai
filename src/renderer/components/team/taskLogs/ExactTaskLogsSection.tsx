import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { isSameTaskDetailIdentity } from '@features/team-task-detail/core';
import { useStore } from '@renderer/store';
import { selectTaskDetailResourceEntry } from '@renderer/store/slices/taskDetailResourcesSlice';
import {
  captureTaskDetailReadScope,
  isTaskDetailReadScopeCurrent,
} from '@renderer/store/team/taskDetailReadAuthority';
import { asEnhancedChunkArray } from '@renderer/types/data';
import { AlertCircle, FileText, Loader2 } from 'lucide-react';

import { ExactTaskLogCard, type ExactTaskLogDetailState } from './ExactTaskLogCard';

import type { TaskDetailIdentity } from '@features/team-task-detail/core';
import type {
  BoardTaskExactLogDetailResult,
  BoardTaskExactLogSummariesResponse,
  BoardTaskExactLogSummary,
} from '@shared/types';

interface ExactTaskLogsSectionProps {
  identity: TaskDetailIdentity;
  enabled?: boolean;
}

function sortExactSummaries(
  items: readonly BoardTaskExactLogSummary[]
): BoardTaskExactLogSummary[] {
  return [...items].sort((left, right) => {
    const leftTs = Date.parse(left.timestamp);
    const rightTs = Date.parse(right.timestamp);
    if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
      return rightTs - leftTs;
    }
    if (left.source.filePath !== right.source.filePath) {
      return left.source.filePath.localeCompare(right.source.filePath);
    }
    if (left.source.sourceOrder !== right.source.sourceOrder) {
      return left.source.sourceOrder - right.source.sourceOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

function toDetailState(
  result: BoardTaskExactLogDetailResult | null | undefined,
  generation: string
): ExactTaskLogDetailState | undefined {
  if (!result) return undefined;
  return result.status === 'ok'
    ? { status: 'ok', generation, chunks: asEnhancedChunkArray(result.detail.chunks) }
    : { status: 'missing', generation };
}

export const ExactTaskLogsSection = ({
  identity,
  enabled = true,
}: ExactTaskLogsSectionProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const surfaceId = useId();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const liveOrigin = useRef({ identity, enabled });
  liveOrigin.current = { identity, enabled };
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const summariesEntry = useStore((state) =>
    selectTaskDetailResourceEntry(state, identity, 'exact-summaries')
  );
  const resourceRevision = useStore((state) => state.taskDetailResourcesRevision);
  const ensureTaskDetailExactSummaries = useStore((state) => state.ensureTaskDetailExactSummaries);
  const ensureTaskDetailExactDetail = useStore((state) => state.ensureTaskDetailExactDetail);
  const setTaskDetailVisibleResourceDemand = useStore(
    (state) => state.setTaskDetailVisibleResourceDemand
  );
  const summaries = useMemo(() => {
    const response = summariesEntry?.data as BoardTaskExactLogSummariesResponse | null | undefined;
    return sortExactSummaries(response?.items ?? []);
  }, [summariesEntry?.data]);

  useEffect(() => {
    setTaskDetailVisibleResourceDemand(surfaceId, identity, 'exact-summaries', enabled);
    return () => setTaskDetailVisibleResourceDemand(surfaceId, identity, 'exact-summaries', false);
  }, [enabled, identity, setTaskDetailVisibleResourceDemand, surfaceId]);

  const getDetailState = useCallback(
    (summary: BoardTaskExactLogSummary): ExactTaskLogDetailState | undefined => {
      void resourceRevision;
      if (!summary.canLoadDetail) return undefined;
      const entry = selectTaskDetailResourceEntry(
        useStore.getState(),
        identity,
        'exact-detail',
        JSON.stringify([summary.id, summary.sourceGeneration])
      );
      if (!entry) return undefined;
      if (entry.loading && !entry.loaded) {
        return { status: 'loading', generation: summary.sourceGeneration };
      }
      if (entry.error) {
        return {
          status: 'error',
          generation: summary.sourceGeneration,
          error: entry.error,
        };
      }
      return toDetailState(
        entry.data as BoardTaskExactLogDetailResult | null,
        summary.sourceGeneration
      );
    },
    [identity, resourceRevision]
  );

  const fetchDetail = useCallback(
    async (
      summary: Extract<BoardTaskExactLogSummary, { canLoadDetail: true }>,
      retryOnStale = true,
      forceFresh = false
    ): Promise<void> => {
      const scope = captureTaskDetailReadScope(identity.teamName, identity.contextId);
      const current = () =>
        mounted.current &&
        liveOrigin.current.enabled &&
        isSameTaskDetailIdentity(liveOrigin.current.identity, identity) &&
        !useStore.getState().isContextSwitching &&
        isTaskDetailReadScopeCurrent(scope, useStore.getState().activeContextId, identity.teamName);
      if (!enabled || !current()) return;
      await ensureTaskDetailExactDetail(identity, summary.id, summary.sourceGeneration, forceFresh);
      if (!current()) return;
      const detailEntry = selectTaskDetailResourceEntry(
        useStore.getState(),
        identity,
        'exact-detail',
        JSON.stringify([summary.id, summary.sourceGeneration])
      );
      const detail = detailEntry?.data as BoardTaskExactLogDetailResult | null | undefined;
      if (detail?.status !== 'stale' || !retryOnStale) return;
      await ensureTaskDetailExactSummaries(identity, true);
      if (!current()) return;
      const refreshedResponse = selectTaskDetailResourceEntry(
        useStore.getState(),
        identity,
        'exact-summaries'
      )?.data as BoardTaskExactLogSummariesResponse | null | undefined;
      const refreshed = refreshedResponse?.items.find(
        (item): item is Extract<BoardTaskExactLogSummary, { canLoadDetail: true }> =>
          item.id === summary.id && item.canLoadDetail
      );
      if (!refreshed) {
        setExpandedId(null);
        return;
      }
      await fetchDetail(refreshed, false);
    },
    [enabled, ensureTaskDetailExactDetail, ensureTaskDetailExactSummaries, identity]
  );

  useEffect(() => {
    if (!enabled || !expandedId) return;
    const summary = summaries.find((item) => item.id === expandedId);
    if (!summary?.canLoadDetail) return;
    const entry = selectTaskDetailResourceEntry(
      useStore.getState(),
      identity,
      'exact-detail',
      JSON.stringify([summary.id, summary.sourceGeneration])
    );
    if (!entry || (entry.refreshPending && !entry.loading)) void fetchDetail(summary);
  }, [enabled, expandedId, fetchDetail, identity, resourceRevision, summaries]);

  const handleToggle = useCallback(
    async (summary: BoardTaskExactLogSummary): Promise<void> => {
      if (!summary.canLoadDetail) return;
      if (expandedId === summary.id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(summary.id);
      const existing = getDetailState(summary);
      if (existing && existing.status !== 'error') return;
      await fetchDetail(summary, true, existing?.status === 'error');
    },
    [expandedId, fetchDetail, getDetailState]
  );

  if (summariesEntry?.loading && !summariesEntry.loaded && summaries.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
            {t('taskLogs.exact.title')}
          </h4>
        </div>
        <div className="flex items-center gap-2 py-4 text-xs text-[var(--color-text-muted)]">
          <Loader2 size={12} className="animate-spin" />
          {t('taskLogs.exact.loading')}
        </div>
      </div>
    );
  }

  if (summariesEntry?.error) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
            {t('taskLogs.exact.title')}
          </h4>
        </div>
        <div className="flex items-center gap-2 py-4 text-xs text-red-400">
          <AlertCircle size={14} />
          {summariesEntry.error}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
          {t('taskLogs.exact.title')}
        </h4>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">{t('taskLogs.exact.description')}</p>
      {summaries.length === 0 ? (
        <div className="py-8 text-center text-xs text-[var(--color-text-muted)]">
          <FileText size={20} className="mx-auto mb-2 opacity-40" />
          {t('taskLogs.exact.emptyTitle')}
          <p className="mt-1 text-[10px] opacity-60">{t('taskLogs.exact.emptyDescription')}</p>
        </div>
      ) : (
        <div className="w-full min-w-0 space-y-1.5">
          {summaries.map((summary) => (
            <ExactTaskLogCard
              key={summary.id}
              summary={summary}
              expanded={expandedId === summary.id}
              detailState={getDetailState(summary)}
              onToggle={() => void handleToggle(summary)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
