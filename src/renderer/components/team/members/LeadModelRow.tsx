import React, { useState } from 'react';

import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';
import { EffortLevelSelector } from '@renderer/components/team/dialogs/EffortLevelSelector';
import { LimitContextCheckbox } from '@renderer/components/team/dialogs/LimitContextCheckbox';
import {
  getTeamModelLabel,
  TeamModelSelector,
} from '@renderer/components/team/dialogs/TeamModelSelector';
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
}: LeadModelRowProps): React.JSX.Element => {
  const { isLight } = useTheme();
  const [modelExpanded, setModelExpanded] = useState(false);
  const leadColorSet = getTeamColorSet(getMemberColorByName('lead'));
  const modelButtonLabel = model.trim() ? getTeamModelLabel(model.trim()) : 'Default';

  return (
    <div
      className="relative grid grid-cols-1 gap-2 rounded-md p-2 shadow-sm md:grid-cols-[1fr_180px_auto]"
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
      <div className="space-y-0.5">
        <div className="flex h-8 items-center px-2 text-sm font-medium text-[var(--color-text)]">
          lead
        </div>
      </div>
      <div>
        <div className="flex h-8 items-center px-2 text-xs text-[var(--color-text-secondary)]">
          Team Lead
        </div>
      </div>
      <div className="space-y-1">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0 space-y-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 max-w-[190px] shrink-0 justify-start gap-1 overflow-hidden text-left"
              onClick={() => setModelExpanded((prev) => !prev)}
            >
              {modelExpanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              <span className="truncate">Model: {modelButtonLabel}</span>
            </Button>
          </div>
          <div className="flex items-center gap-2 pl-1 xl:pl-0">
            <Checkbox
              id="sync-models-with-lead"
              checked={syncModelsWithTeammates}
              onCheckedChange={(checked) => onSyncModelsWithTeammatesChange(checked === true)}
            />
            <Label
              htmlFor="sync-models-with-lead"
              className="cursor-pointer text-xs font-normal text-text-secondary"
            >
              Синхронизировать модель с тимейтами
            </Label>
          </div>
        </div>
      </div>
      {modelExpanded ? (
        <div className="space-y-2 md:col-span-3">
          <TeamModelSelector
            providerId={providerId}
            onProviderChange={onProviderChange}
            value={model}
            onValueChange={onModelChange}
            id="lead-model"
          />
          <EffortLevelSelector
            value={effort ?? ''}
            onValueChange={onEffortChange}
            id="lead-effort"
          />
          <LimitContextCheckbox
            id="lead-limit-context"
            checked={limitContext}
            onCheckedChange={onLimitContextChange}
            disabled={providerId !== 'anthropic' || model === 'haiku'}
          />
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
