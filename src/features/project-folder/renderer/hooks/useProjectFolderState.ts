import { useCallback, useEffect, useState } from 'react';

import { api } from '@renderer/api';

import type {
  ProjectFolderCreateError,
  ProjectFolderState,
} from '@features/project-folder/contracts';

const STATE_CHECK_DEBOUNCE_MS = 250;

export type ProjectFolderStatus = ProjectFolderState | 'idle' | 'checking';

export interface ProjectFolderController {
  path: string;
  status: ProjectFolderStatus;
  /** True while `status` still describes a previously checked path. */
  checking: boolean;
  creating: boolean;
  createError: ProjectFolderCreateError | null;
  /** Resolves true once the folder exists. */
  create: () => Promise<boolean>;
}

interface ProjectFolderSnapshot {
  path: string;
  state: ProjectFolderState;
}

export function useProjectFolderState(input: {
  enabled: boolean;
  path: string;
}): ProjectFolderController {
  const path = input.enabled ? input.path.trim() : '';
  const [snapshot, setSnapshot] = useState<ProjectFolderSnapshot | null>(null);
  const [checkRevision, setCheckRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<{
    path: string;
    error: ProjectFolderCreateError;
  } | null>(null);

  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void Promise.resolve()
        .then(() =>
          api.projectFolder ? api.projectFolder.getState({ path }) : { state: 'unknown' as const }
        )
        .then(
          (result) => result.state,
          (): ProjectFolderState => 'unknown'
        )
        .then((state) => {
          if (!cancelled) setSnapshot({ path, state });
        });
    }, STATE_CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [path, checkRevision]);

  useEffect(() => {
    if (!path) return undefined;
    // Folders are often created or removed outside the app while the dialog stays open.
    const recheck = (): void => setCheckRevision((revision) => revision + 1);
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, [path]);

  const create = useCallback(async (): Promise<boolean> => {
    if (!path) return false;
    setCreating(true);
    setCreateFailure(null);
    try {
      if (!api.projectFolder) {
        setCreateFailure({ path, error: 'failed' });
        return false;
      }
      const result = await api.projectFolder.create({ path });
      setSnapshot({ path, state: result.state });
      if (result.error) setCreateFailure({ path, error: result.error });
      return !result.error && result.state === 'exists';
    } catch {
      setCreateFailure({ path, error: 'failed' });
      return false;
    } finally {
      setCreating(false);
    }
  }, [path]);

  // While a new path is debounced, keep the last answer so typing does not flicker the notice.
  let status: ProjectFolderStatus = 'idle';
  if (path) status = snapshot?.state ?? 'checking';
  return {
    path,
    status,
    checking: Boolean(path) && snapshot?.path !== path,
    creating,
    createError: createFailure?.path === path ? createFailure.error : null,
    create,
  };
}
