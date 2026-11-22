import { ExternalAgentPromptAction } from '@features/external-agent-connection/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

import type { ReactNode } from 'react';

type Props = {
  local: boolean;
  isLight: boolean;
  onManagementApplied?: () => void;
  disabled?: boolean;
  templatePicker: ReactNode;
};

export const CreateTeamHeaderActions = ({
  local,
  isLight,
  onManagementApplied,
  templatePicker,
  disabled,
}: Props): React.JSX.Element => {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <ExternalAgentPromptAction
        api={api.externalAgentConnection}
        local={local && !disabled}
        isLight={isLight}
        onSettings={() => useStore.getState().openSettingsTab('externalAgentConnection')}
        onManagementApplied={onManagementApplied}
      />
      {templatePicker}
    </div>
  );
};
