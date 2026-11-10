import React, { useEffect, useId } from 'react';

import { TaskDetailReadCoordinator } from '@features/team-task-detail/renderer/adapters/TaskDetailReadCoordinator';
import { useStore } from '@renderer/store';
import { invalidateTaskDetailForTeamChange } from '@renderer/store/team/taskDetailReadAuthority';
import type { TeamChangeEvent } from '@shared/types';

import type { TaskDetailIdentity } from '@features/team-task-detail/core';
import type { TaskDetailVisibleResourceKind } from '@renderer/store/team/taskDetailResourceIdentity';

/** Mount the production resource owner around a presentation-only log section. */
export function TaskResourceTestHost({
  identity,
  kind,
  enabled = true,
  children,
}: {
  identity: TaskDetailIdentity;
  kind: TaskDetailVisibleResourceKind;
  enabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const surfaceId = useId();
  const setDemand = useStore((state) => state.setTaskDetailVisibleResourceDemand);
  useEffect(() => {
    setDemand(surfaceId, identity, kind, enabled);
    return () => setDemand(surfaceId, identity, kind, false);
  }, [enabled, identity, kind, setDemand, surfaceId]);
  return (
    <>
      <TaskDetailReadCoordinator />
      {children}
    </>
  );
}

export function resetTaskResourceTestState(): void {
  useStore.setState({
    activeContextId: 'local',
    isContextSwitching: false,
    taskDetailResourcesById: {},
    taskDetailVisibleDemandById: {},
    taskDetailResourcesRevision: 0,
  });
}

/** Exercise the same source invalidation used by the single app event listener. */
export function emitTaskResourceChange(_event: unknown, event: TeamChangeEvent): void {
  invalidateTaskDetailForTeamChange(useStore.getState(), event, false);
}
