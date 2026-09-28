import { useCallback, useEffect, useState } from 'react';

import {
  isInvalidProjectFolderPathShape,
  type ProjectFolderCreateError,
  type ProjectFolderElectronApi,
  type ProjectFolderState,
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
  projectFolder: ProjectFolderElectronApi['projectFolder'] | undefined;
}): ProjectFolderController {
  const path = input.enabled ? input.path.trim() : '';
  const { projectFolder } = input;
  const invalidShape = Boolean(path) && isInvalidProjectFolderPathShape(path);
  const [snapshot, setSnapshot] = useState<ProjectFolderSnapshot | null>(null);
  const [checkRevision, setCheckRevision] = useState(0);
  const [pendingCheck, setPendingCheck] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<{
    path: string;
    error: ProjectFolderCreateError;
  } | null>(null);

  useEffect(() => {
    if (!path || invalidShape) {
      setPendingCheck(false);
      return undefined;
    }
    let cancelled = false;
    setPendingCheck(true);
    const timeoutId = window.setTimeout(() => {
      void Promise.resolve()
        .then(() =>
          projectFolder ? projectFolder.getState({ path }) : { state: 'unknown' as const }
        )
        .then(
          (result) => result.state,
          (): ProjectFolderState => 'unknown'
        )
        .then((state) => {
          if (!cancelled) {
            setSnapshot({ path, state });
            setPendingCheck(false);
          }
        });
    }, STATE_CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [path, checkRevision, invalidShape, projectFolder]);

  useEffect(() => {
    if (!path || invalidShape) return undefined;
    // Folders are often created or removed outside the app while the dialog stays open.
    const recheck = (): void => {
      setPendingCheck(true);
      setCheckRevision((revision) => revision + 1);
    };
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, [path, invalidShape]);

  const create = useCallback(async (): Promise<boolean> => {
    if (!path) return false;
    setCreating(true);
    setCreateFailure(null);
    try {
      if (!projectFolder) {
        setCreateFailure({ path, error: 'failed' });
        return false;
      }
      const result = await projectFolder.create({ path });
      setSnapshot({ path, state: result.state });
      if (result.error) setCreateFailure({ path, error: result.error });
      return !result.error && result.state === 'exists';
    } catch {
      setCreateFailure({ path, error: 'failed' });
      return false;
    } finally {
      setCreating(false);
    }
  }, [path, projectFolder]);

  // While a new path is debounced, keep the last answer so typing does not flicker the notice.
  let status: ProjectFolderStatus = 'idle';
  if (invalidShape) status = 'invalid';
  else if (path) status = snapshot?.state ?? 'checking';
  return {
    path,
    status,
    checking: Boolean(path) && !invalidShape && (snapshot?.path !== path || pendingCheck),
    creating,
    createError: createFailure?.path === path ? createFailure.error : null,
    create,
  };
}
