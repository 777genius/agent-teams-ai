import { useEffect } from 'react';

import { taskDetailKey } from '@features/team-task-detail/core';
import { useDocumentVisibility } from '@renderer/hooks/useDocumentVisibility';
import { useStore } from '@renderer/store';
import { selectTaskDetailReadDemands } from '@renderer/store/team/taskDetailReadInterest';
import { useShallow } from 'zustand/react/shallow';

/** Single root owner for full-task interest discovery and event-driven reads. */
export const TaskDetailReadCoordinator = (): null => {
  const documentVisible = useDocumentVisibility();
  const keys = useStore(
    useShallow((state) =>
      selectTaskDetailReadDemands(state)
        .filter((demand) => demand.needsRead)
        .map((demand) => demand.key)
    )
  );
  const ensureTaskDetail = useStore((state) => state.ensureTaskDetail);
  const resourceWorkKeys = useStore(
    useShallow((state) =>
      Object.entries(state.taskDetailVisibleDemandById)
        .filter(
          ([, demand]) =>
            !state.isContextSwitching && demand.identity.contextId === state.activeContextId
        )
        .flatMap(([surfaceId, demand]) =>
          Object.entries(demand.resources)
            .filter(([kind]) => kind !== 'detail')
            .map(([kind, signature]) =>
              [surfaceId, taskDetailKey(demand.identity), kind, signature].join('\u0000')
            )
        )
        .sort()
    )
  );
  const resourcesRevision = useStore((state) => state.taskDetailResourcesRevision);
  const refreshVisibleTaskDetailResources = useStore(
    (state) => state.refreshTaskDetailVisibleResources
  );

  useEffect(() => {
    for (const key of keys) {
      const [contextId, teamName, taskId] = JSON.parse(key) as [string, string, string];
      void ensureTaskDetail({
        contextId,
        teamName,
        taskId,
      });
    }
  }, [keys, ensureTaskDetail]);

  useEffect(() => {
    if (documentVisible) void refreshVisibleTaskDetailResources();
  }, [documentVisible, refreshVisibleTaskDetailResources, resourceWorkKeys, resourcesRevision]);

  const pollChanges =
    documentVisible && resourceWorkKeys.some((key) => key.split('\u0000')[2] === 'changes');
  const pollActivity =
    documentVisible && resourceWorkKeys.some((key) => key.split('\u0000')[2] === 'activity');
  useEffect(() => {
    const changesTimer = pollChanges
      ? window.setInterval(() => {
          void refreshVisibleTaskDetailResources('changes', true);
        }, 20_000)
      : undefined;
    const activityTimer = pollActivity
      ? window.setInterval(() => {
          void refreshVisibleTaskDetailResources('activity', true);
        }, 8_000)
      : undefined;
    return () => {
      if (changesTimer !== undefined) window.clearInterval(changesTimer);
      if (activityTimer !== undefined) window.clearInterval(activityTimer);
    };
  }, [pollActivity, pollChanges, refreshVisibleTaskDetailResources]);

  return null;
};
