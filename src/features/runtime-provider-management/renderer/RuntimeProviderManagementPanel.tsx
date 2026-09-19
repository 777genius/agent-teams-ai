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
import { resolveRuntimeProviderProjectContext } from './ui/runtimeProviderProjectContext';

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
  const projectContextRequestKey = activeProjectPath ?? initialProjectPath ?? '';
  const [resolvedProjectContext, setResolvedProjectContext] = useState<{
    readonly requestKey: string;
    readonly repositoryGroups: typeof repositoryGroups;
  } | null>(null);
  const backgroundHydrationKeyRef = useRef<string | null>(null);
  const searchInitialProviderDirectly =
    initialProviderId === 'openrouter' || initialProviderId === 'vercel';
  const projectContextResolved =
    resolvedProjectContext?.requestKey === projectContextRequestKey &&
    resolvedProjectContext.repositoryGroups === repositoryGroups;
  const effectiveProjectPath = useMemo(
    () =>
      projectContextResolved && !projectContextError
        ? resolveRuntimeProviderProjectContext(activeProjectPath, projectContextProjects).path
        : null,
    [activeProjectPath, projectContextError, projectContextProjects, projectContextResolved]
  );

  useEffect(() => {
    if (!open) return;
    setActiveProjectPath(initialProjectPath);
  }, [initialProjectPath, open]);

  useEffect(() => {
    if (!open) {
      setResolvedProjectContext(null);
      return;
    }
    let cancelled = false;
    setResolvedProjectContext(null);
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
        setProjectContextProjects([]);
        setProjectContextError(
          error instanceof Error ? error.message : 'Failed to load project contexts'
        );
      })
      .finally(() => {
        if (!cancelled) {
          setResolvedProjectContext({ requestKey: projectContextRequestKey, repositoryGroups });
          setProjectContextLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectPath, initialProjectPath, open, projectContextRequestKey, repositoryGroups]);

  const [state, actions] = useRuntimeProviderManagement({
    runtimeId,
    enabled: open && projectContextResolved,
    // Paint the curated summary immediately (no live OpenCode host), then fill
    // the complete catalog in the background. OpenRouter/Vercel deep-links skip
    // this because they search the live directory by provider id.
    directoryPageSize: initialProviderId ? 100 : 250,
    directorySummaryOnEnable: !searchInitialProviderDirectly,
    reuseCachedFullDirectory: !searchInitialProviderDirectly,
    loadViewOnEnable: false,
    preserveViewRequestOnDisable: open && !projectContextResolved,
    searchDirectoryOnQueryChange: searchInitialProviderDirectly,
    projectPath: effectiveProjectPath,
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
  const hydrateDirectory = actions.hydrateDirectory;

  useEffect(() => {
    onBlockingOperationChange?.(blockingCredentialWrite);
    return () => onBlockingOperationChange?.(false);
  }, [blockingCredentialWrite, onBlockingOperationChange]);

  useEffect(() => {
    if (!open) {
      backgroundHydrationKeyRef.current = null;
      return;
    }
    if (
      searchInitialProviderDirectly ||
      !state.directoryLoaded ||
      !state.directorySummary ||
      state.directoryLoading ||
      state.directoryRefreshing ||
      state.directoryError
    ) {
      return;
    }
    const hydrationKey = `${effectiveProjectPath ?? ''}:full-catalog`;
    if (backgroundHydrationKeyRef.current === hydrationKey) {
      return;
    }
    const timeout = window.setTimeout(() => {
      backgroundHydrationKeyRef.current = hydrationKey;
      void hydrateDirectory().then((hydrated) => {
        if (!hydrated) {
          backgroundHydrationKeyRef.current = null;
        }
      });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [
    effectiveProjectPath,
    hydrateDirectory,
    open,
    searchInitialProviderDirectly,
    state.directoryError,
    state.directoryLoaded,
    state.directoryLoading,
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
        disabled={disabled || !projectContextResolved}
        projectPath={effectiveProjectPath}
        projectContextProjects={projectContextProjects}
        projectContextLoading={projectContextLoading || !projectContextResolved}
        projectContextError={projectContextError}
        onProjectContextChange={setActiveProjectPath}
      />
    </>
  );
};
