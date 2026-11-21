import { ExternalAgentPromptAction } from '@features/external-agent-connection/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

interface Props {
  local: boolean;
  isLight: boolean;
  disabled?: boolean;
  onManagementApplied?: () => void;
}

/** The template library now owns the single inline picker in Create Team. */
export const CreateTeamHeaderActions = ({
  local,
  isLight,
  disabled,
  onManagementApplied,
}: Props): React.JSX.Element => (
  <ExternalAgentPromptAction
    api={api.externalAgentConnection}
    local={local && !disabled}
    isLight={isLight}
    onSettings={() => useStore.getState().openSettingsTab('externalAgentConnection')}
    onManagementApplied={onManagementApplied}
  />
);
