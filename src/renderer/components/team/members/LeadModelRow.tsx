import React, { useState } from 'react';

import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { EffortLevelSelector } from '@renderer/components/team/dialogs/EffortLevelSelector';
import { LimitContextCheckbox } from '@renderer/components/team/dialogs/LimitContextCheckbox';
import {
  getProviderScopedTeamModelLabel,
  getTeamProviderLabel,
  TeamModelSelector,
} from '@renderer/components/team/dialogs/TeamModelSelector';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { getMemberColorByName } from '@shared/constants/memberColors';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';

import { Button } from '../../ui/button';

import type { EffortLevel, TeamProviderId } from '@shared/types';

interface LeadModelRowProps {
  providerId: TeamProviderId;
  model: string;
  effort?: EffortLevel;
  limitContext: boolean;
  onProviderChange: (providerId: TeamProviderId) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onLimitContextChange: (value: boolean) => void;
  syncModelsWithTeammates: boolean;
  onSyncModelsWithTeammatesChange: (value: boolean) => void;
  warningText?: string | null;
  disableGeminiOption?: boolean;
}

export const LeadModelRow = ({
  providerId,
  model,
  effort,
  limitContext,
  onProviderChange,
  onModelChange,
  onEffortChange,
  onLimitContextChange,
  syncModelsWithTeammates,
  onSyncModelsWithTeammatesChange,
  warningText,
  disableGeminiOption = false,
}: LeadModelRowProps): React.JSX.Element => {
  const { isLight } = useTheme();
  const [modelExpanded, setModelExpanded] = useState(false);
  const leadColorSet = getTeamColorSet(getMemberColorByName('lead'));
  const modelButtonLabel = model.trim()
    ? getProviderScopedTeamModelLabel(providerId, model.trim())
    : 'Default';
  const modelButtonAriaLabel = `${getTeamProviderLabel(providerId)} provider, ${modelButtonLabel}`;

  return (
    <div
      className="relative grid grid-cols-1 gap-2 rounded-md p-2 shadow-sm md:grid-cols-[auto_1fr_auto]"
      style={{
        backgroundColor: isLight
          ? 'color-mix(in srgb, var(--color-surface-raised) 22%, white 78%)'
          : 'var(--color-surface-raised)',
        boxShadow: isLight ? '0 1px 2px rgba(15, 23, 42, 0.06)' : '0 1px 2px rgba(0, 0, 0, 0.28)',
      }}
    >
      <div
        className="absolute inset-y-0 left-0 w-1 rounded-l-md"
        style={{ backgroundColor: leadColorSet.border }}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <div className="flex h-8 items-center gap-3 px-2">
          <span className="text-sm font-medium text-[var(--color-text)]">lead</span>
          <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">Team Lead</span>
        </div>
      </div>
      <div className="min-w-0">
        <div className="flex h-8 items-center justify-end px-2 text-xs text-[var(--color-text-secondary)]">
          <div className="flex min-w-0 items-center gap-2">
            <Checkbox
              id="sync-models-with-lead"
              checked={syncModelsWithTeammates}
              onCheckedChange={(checked) => onSyncModelsWithTeammatesChange(checked === true)}
            />
            <Label
              htmlFor="sync-models-with-lead"
              className="cursor-pointer truncate text-xs font-normal text-text-secondary"
            >
              Sync model with teammates
            </Label>
          </div>
        </div>
      </div>
      <div className="space-y-1">
        <div className="w-full min-w-0 space-y-1 sm:w-[150px] sm:min-w-[150px]">
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full justify-start gap-1 overflow-hidden text-left"
            aria-label={modelButtonAriaLabel}
            onClick={() => setModelExpanded((prev) => !prev)}
          >
            {modelExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            <ProviderBrandLogo providerId={providerId} className="size-3.5 shrink-0" />
            <span className="truncate">{modelButtonLabel}</span>
          </Button>
        </div>
      </div>
      {warningText ? (
        <div className="md:col-span-3">
          <div className="bg-amber-500/8 ml-3 flex items-start gap-2 rounded-md border border-amber-500/25 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            <Info className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
            <p>{warningText}</p>
          </div>
        </div>
      ) : null}
      {modelExpanded ? (
        <div className="space-y-2 md:col-span-3">
          <TeamModelSelector
            providerId={providerId}
            onProviderChange={onProviderChange}
            value={model}
            onValueChange={onModelChange}
            id="lead-model"
            disableGeminiOption={disableGeminiOption}
          />
          <EffortLevelSelector
            value={effort ?? ''}
            onValueChange={onEffortChange}
            id="lead-effort"
          />
          {providerId === 'anthropic' ? (
            <LimitContextCheckbox
              id="lead-limit-context"
              checked={limitContext}
              onCheckedChange={onLimitContextChange}
              disabled={model === 'haiku'}
            />
          ) : null}
          <div className="flex items-start gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2">
            <Info className="mt-0.5 size-3.5 shrink-0 text-sky-400" />
            <p className="text-[11px] leading-relaxed text-sky-300">
              These settings control the team lead and act as the default runtime for teammates that
              do not have their own override.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
};
