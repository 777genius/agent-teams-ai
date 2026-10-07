import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useStore } from '@renderer/store';

import { applyTeamTemplate, TEAM_TEMPLATES } from '../core';

import type { TeamCreateConfigRequest } from '@shared/types';
import type { TeamProviderId } from '@shared/types';

export const TeamTemplatePicker = ({
  onApply,
}: {
  onApply: (draft: ReturnType<typeof applyTeamTemplate>) => void;
}): React.JSX.Element => {
  return (
    <Select
      value=""
      onValueChange={(id) => {
        const template = TEAM_TEMPLATES.find((entry) => entry.id === id);
        if (template) onApply(applyTeamTemplate(template));
      }}
    >
      <SelectTrigger aria-label="Team template">
        <SelectValue placeholder="Start from a team template" />
      </SelectTrigger>
      <SelectContent>
        {TEAM_TEMPLATES.map((template) => (
          <SelectItem key={template.id} value={template.id}>
            {template.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export const UnselectedTeamProvider = ({
  onSelect,
  anthropicOnly = false,
}: {
  onSelect: (provider: TeamProviderId) => void;
  anthropicOnly?: boolean;
}): React.JSX.Element => {
  const multimodelEnabled = useStore(
    (state) => state.appConfig?.general?.multimodelEnabled ?? true
  );
  return (
    <div className="space-y-1">
      <Select value="" onValueChange={(value) => onSelect(value as TeamProviderId)}>
        <SelectTrigger aria-label="Choose team provider">
          <SelectValue placeholder="Choose a provider" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="anthropic">Claude</SelectItem>
          {!anthropicOnly && multimodelEnabled ? (
            <>
              <SelectItem value="codex">Codex</SelectItem>
              <SelectItem value="opencode">OpenCode</SelectItem>
            </>
          ) : null}
        </SelectContent>
      </Select>
      <p className="text-xs text-text-secondary">
        Model selection is available after choosing a provider.
      </p>
    </div>
  );
};

export type TemplateDraft = Pick<
  TeamCreateConfigRequest,
  'runtimeSelectionVersion' | 'description' | 'prompt' | 'members' | 'syncModelsWithLead'
>;
