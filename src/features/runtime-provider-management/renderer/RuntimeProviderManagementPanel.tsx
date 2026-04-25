import { useRuntimeProviderManagement } from './hooks/useRuntimeProviderManagement';
import { RuntimeProviderManagementPanelView } from './ui/RuntimeProviderManagementPanelView';

import type { RuntimeProviderManagementRuntimeId } from '@features/runtime-provider-management/contracts';
import type { JSX } from 'react';

interface RuntimeProviderManagementPanelProps {
  readonly runtimeId: RuntimeProviderManagementRuntimeId;
  readonly open: boolean;
  readonly projectPath?: string | null;
  readonly disabled?: boolean;
  readonly onProviderChanged?: () => Promise<void> | void;
}

export function RuntimeProviderManagementPanel({
  runtimeId,
  open,
  projectPath = null,
  disabled = false,
  onProviderChanged,
}: RuntimeProviderManagementPanelProps): JSX.Element {
  const [state, actions] = useRuntimeProviderManagement({
    runtimeId,
    enabled: open,
    projectPath,
    onProviderChanged,
  });

  return (
    <RuntimeProviderManagementPanelView
      state={state}
      actions={actions}
      disabled={disabled}
      projectPath={projectPath}
    />
  );
}
