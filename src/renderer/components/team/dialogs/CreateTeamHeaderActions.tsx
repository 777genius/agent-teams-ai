import { ExternalAgentPromptAction } from '@features/external-agent-connection/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

import { CreateTeamTemplatePicker } from './CreateTeamTemplatePicker';

import type { ComponentProps } from 'react';

type Props = ComponentProps<typeof CreateTeamTemplatePicker> & {
  local: boolean;
  isLight: boolean;
  onManagementApplied?: () => void;
};

export const CreateTeamHeaderActions = ({
  local,
  isLight,
  onManagementApplied,
  form,
  descriptionDraft,
  promptDraft,
  defaultDescription,
  hasPromptChips,
  clearPromptChips,
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
      <div className="w-56 min-w-0 max-w-full">
        <CreateTeamTemplatePicker
          form={form}
          descriptionDraft={descriptionDraft}
          promptDraft={promptDraft}
          defaultDescription={defaultDescription}
          hasPromptChips={hasPromptChips}
          clearPromptChips={clearPromptChips}
          disabled={disabled}
        />
      </div>
    </div>
  );
};
