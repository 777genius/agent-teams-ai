import { useEffect } from 'react';

import { useStore } from '@renderer/store';
import { selectTaskDetailReadDemands } from '@renderer/store/team/taskDetailReadInterest';
import { useShallow } from 'zustand/react/shallow';

/** Single root owner for full-task interest discovery and event-driven reads. */
export const TaskDetailReadCoordinator = (): null => {
  const keys = useStore(
    useShallow((state) =>
      selectTaskDetailReadDemands(state)
        .filter((demand) => demand.needsRead)
        .map((demand) => demand.key)
    )
  );
  const ensureTaskDetail = useStore((state) => state.ensureTaskDetail);

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

  return null;
};
