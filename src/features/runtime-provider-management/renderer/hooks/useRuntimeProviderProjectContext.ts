import { useCallback, useEffect, useRef } from 'react';

import type { RuntimeProviderManagementRuntimeId } from '../../contracts';

interface ProjectContextSnapshot {
  path: string | null;
  runtimeId: RuntimeProviderManagementRuntimeId;
  generation: number;
}

/** Async operations retain their original project/runtime and cannot outlive this hook. */
export function useRuntimeProviderProjectContext(
  path: string | null,
  runtimeId: RuntimeProviderManagementRuntimeId
) {
  const current = useRef<ProjectContextSnapshot>({ path, runtimeId, generation: 0 });
  if (current.current.path !== path || current.current.runtimeId !== runtimeId) {
    current.current = { path, runtimeId, generation: current.current.generation + 1 };
  }
  useEffect(
    () => () => {
      current.current = { ...current.current, generation: current.current.generation + 1 };
    },
    []
  );
  const getProjectContextSnapshot = useCallback(() => current.current, []);
  const isProjectContextCurrent = useCallback(
    (snapshot: ProjectContextSnapshot): boolean =>
      current.current.path === snapshot.path &&
      current.current.runtimeId === snapshot.runtimeId &&
      current.current.generation === snapshot.generation,
    []
  );
  return { getProjectContextSnapshot, isProjectContextCurrent };
}
