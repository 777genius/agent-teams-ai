import { type JSX, useEffect, useMemo, useState } from 'react';

import {
  loadProjectPathProjects,
  type ProjectPathProject,
} from '@renderer/components/team/dialogs/projectPathProjects';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import { useRuntimeProviderManagement } from './hooks/useRuntimeProviderManagement';
import { RuntimeProviderManagementPanelView } from './ui/RuntimeProviderManagementPanelView';

import type { RuntimeProviderManagementRuntimeId } from '@features/runtime-provider-management/contracts';

interface RuntimeProviderManagementPanelProps {
  readonly runtimeId: RuntimeProviderManagementRuntimeId;
  readonly open: boolean;
  readonly projectPath?: string | null;
  readonly initialProviderId?: string | null;
  readonly initialProviderAction?: 'connect' | 'select' | null;
  readonly disabled?: boolean;
  readonly onProviderChanged?: () => Promise<void> | void;
}

export const RuntimeProviderManagementPanel = ({
  runtimeId,
  open,
  projectPath = null,
  initialProviderId = null,
  initialProviderAction = null,
  disabled = false,
  onProviderChanged,
}: RuntimeProviderManagementPanelProps): JSX.Element => {
  const repositoryGroups = useStore(useShallow((state) => state.repositoryGroups));
  const initialProjectPath = useMemo(() => projectPath?.trim() || null, [projectPath]);
  const [activeProjectPath, setActiveProjectPath] = useState<string | null>(initialProjectPath);
  const [projectContextProjects, setProjectContextProjects] = useState<ProjectPathProject[]>([]);
  const [projectContextLoading, setProjectContextLoading] = useState(false);
  const [projectContextError, setProjectContextError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
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
    directoryPageSize: 100,
    loadViewOnEnable: false,
    searchDirectoryOnQueryChange: false,
    projectPath: activeProjectPath,
    initialProviderId,
    initialProviderAction,
    onProviderChanged,
  });

  return (
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
  );
};
