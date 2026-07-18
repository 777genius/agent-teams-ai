import { type JSX, useEffect, useMemo, useRef, useState } from 'react';

import {
  loadProjectPathProjects,
  type ProjectPathProject,
} from '@renderer/components/team/dialogs/projectPathProjects';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import {
  type RuntimeProviderChangeKind,
  useRuntimeProviderManagement,
} from './hooks/useRuntimeProviderManagement';
import { RuntimeProviderManagementPanelView } from './ui/RuntimeProviderManagementPanelView';

import type { RuntimeProviderManagementRuntimeId } from '@features/runtime-provider-management/contracts';

interface RuntimeProviderManagementPanelProps {
  readonly runtimeId: RuntimeProviderManagementRuntimeId;
  readonly open: boolean;
  readonly projectPath?: string | null;
  readonly initialProviderId?: string | null;
  readonly initialProviderAction?: 'connect' | 'reconnect' | 'select' | null;
  readonly disabled?: boolean;
  readonly onProviderChanged?: (
    changeKind: RuntimeProviderChangeKind
  ) => Promise<boolean | void> | boolean | void;
  readonly onBlockingOperationChange?: (blocking: boolean) => void;
}

export const RuntimeProviderManagementPanel = ({
  runtimeId,
  open,
  projectPath = null,
  initialProviderId = null,
  initialProviderAction = null,
  disabled = false,
  onProviderChanged,
  onBlockingOperationChange,
}: RuntimeProviderManagementPanelProps): JSX.Element => {
  const repositoryGroups = useStore(useShallow((state) => state.repositoryGroups));
  const initialProjectPath = useMemo(() => projectPath?.trim() || null, [projectPath]);
  const [activeProjectPath, setActiveProjectPath] = useState<string | null>(initialProjectPath);
  const [projectContextProjects, setProjectContextProjects] = useState<ProjectPathProject[]>([]);
  const [projectContextLoading, setProjectContextLoading] = useState(false);
  const [projectContextError, setProjectContextError] = useState<string | null>(null);
  const backgroundHydrationKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setActiveProjectPath(initialProjectPath);
  }, [initialProjectPath, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setProjectContextLoading(true);
    setProjectContextError(null);
    void loadProjectPathProjects({
      defaultProjectPath: activeProjectPath ?? initialProjectPath,
      repositoryGroups,
    })
      .then((projects) => {
        if (cancelled) return;
        setProjectContextProjects(projects);
      })
      .catch((error) => {
        if (cancelled) return;
        setProjectContextError(
          error instanceof Error ? error.message : 'Failed to load project contexts'
        );
      })
      .finally(() => {
        if (!cancelled) {
          setProjectContextLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectPath, initialProjectPath, open, repositoryGroups]);

  const [state, actions] = useRuntimeProviderManagement({
    runtimeId,
    enabled: open,
    // A quick-card Manage action can reuse the dashboard summary immediately.
    // Browse-all opens without an initial provider and loads the full catalog.
    directoryPageSize: initialProviderId ? 100 : 250,
    directorySummaryOnEnable: Boolean(initialProviderId),
    loadViewOnEnable: false,
    searchDirectoryOnQueryChange: false,
    projectPath: activeProjectPath,
    initialProviderId,
    initialProviderAction,
    onProviderChanged,
  });
  const activeAuthOption = state.setupForm?.authOptions?.find(
    (option) => option.id === state.selectedAuthOptionId
  );
  const activeSetupMethod = activeAuthOption?.method ?? state.setupForm?.method ?? null;
  const blockingCredentialWrite = Boolean(
    state.savingProviderId && activeSetupMethod && activeSetupMethod !== 'oauth'
  );
  const refreshDirectory = actions.refreshDirectory;

  useEffect(() => {
    onBlockingOperationChange?.(blockingCredentialWrite);
    return () => onBlockingOperationChange?.(false);
  }, [blockingCredentialWrite, onBlockingOperationChange]);

  useEffect(() => {
    if (
      !open ||
      !initialProviderId ||
      !state.directoryLoaded ||
      !state.directorySummary ||
      state.directoryRefreshing
    ) {
      return;
    }
    const hydrationKey = `${activeProjectPath ?? ''}:${initialProviderId}`;
    if (backgroundHydrationKeyRef.current === hydrationKey) {
      return;
    }
    backgroundHydrationKeyRef.current = hydrationKey;
    const timeout = window.setTimeout(() => refreshDirectory(), 0);
    return () => window.clearTimeout(timeout);
  }, [
    activeProjectPath,
    initialProviderId,
    open,
    refreshDirectory,
    state.directoryLoaded,
    state.directoryRefreshing,
    state.directorySummary,
  ]);

  const cancelConnectRef = useRef(actions.cancelConnect);
  useEffect(() => {
    cancelConnectRef.current = actions.cancelConnect;
  }, [actions.cancelConnect]);
  useEffect(
    () => () => {
      cancelConnectRef.current();
    },
    []
  );

  return (
    <>
      <RuntimeProviderManagementPanelView
        state={state}
        actions={actions}
        disabled={disabled}
        projectPath={activeProjectPath}
        projectContextProjects={projectContextProjects}
        projectContextLoading={projectContextLoading}
        projectContextError={projectContextError}
        onProjectContextChange={setActiveProjectPath}
      />
    </>
  );
};
