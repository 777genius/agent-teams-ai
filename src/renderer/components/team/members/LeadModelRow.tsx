import React, { useState } from 'react';

import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { AnthropicFastModeSelector } from '@renderer/components/team/dialogs/AnthropicFastModeSelector';
import { CodexFastModeSelector } from '@renderer/components/team/dialogs/CodexFastModeSelector';
import { EffortLevelSelector } from '@renderer/components/team/dialogs/EffortLevelSelector';
import { LimitContextCheckbox } from '@renderer/components/team/dialogs/LimitContextCheckbox';
import {
  getProviderScopedTeamModelLabel,
  getTeamProviderLabel,
  OPENCODE_TEAM_LEAD_DISABLED_BADGE_LABEL,
  OPENCODE_TEAM_LEAD_DISABLED_REASON,
  TeamModelSelector,
} from '@renderer/components/team/dialogs/TeamModelSelector';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import { isAnthropicHaikuTeamModel } from '@renderer/utils/teamModelCatalog';
import { resolveTeamLeadColorName } from '@shared/utils/teamMemberColors';
import { AlertTriangle, ChevronDown, ChevronRight, Info } from 'lucide-react';

import { Button } from '../../ui/button';

import type { EffortLevel, TeamFastMode, TeamProviderId } from '@shared/types';

interface LeadModelRowProps {
  providerId: TeamProviderId;
  model: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  providerFastModeDefault?: boolean;
  limitContext: boolean;
  onProviderChange: (providerId: TeamProviderId) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onFastModeChange?: (fastMode: TeamFastMode) => void;
  onLimitContextChange: (value: boolean) => void;
  syncModelsWithTeammates: boolean;
  onSyncModelsWithTeammatesChange: (value: boolean) => void;
  warningText?: string | null;
  fastModeNotice?: string | null;
  disableGeminiOption?: boolean;
  modelIssueText?: string | null;
}

export const LeadModelRow = ({
  providerId,
  model,
  effort,
  fastMode = 'inherit',
  providerFastModeDefault = false,
  limitContext,
  onProviderChange,
  onModelChange,
  onEffortChange,
  onFastModeChange,
  onLimitContextChange,
  syncModelsWithTeammates,
  onSyncModelsWithTeammatesChange,
  warningText,
  fastModeNotice,
  disableGeminiOption = false,
  modelIssueText,
}: LeadModelRowProps): React.JSX.Element => {
  const { isLight } = useTheme();
  const [modelExpanded, setModelExpanded] = useState(false);
  const leadColorSet = getTeamColorSet(resolveTeamLeadColorName());
  const modelButtonLabel = model.trim()
    ? getProviderScopedTeamModelLabel(providerId, model.trim())
    : 'Default';
  const modelButtonAriaLabel = `${getTeamProviderLabel(providerId)} provider, ${modelButtonLabel}`;
  const hasModelIssue = Boolean(modelIssueText);

  return (
    <div
      className="relative grid grid-cols-1 gap-2 rounded-md p-2 shadow-sm md:grid-cols-[minmax(0,1fr)_auto_auto]"
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
        <div className="flex items-center gap-2">
          <img
            src={agentAvatarUrl('team-lead', 32)}
            alt=""
            className="size-8 shrink-0 rounded-full bg-[var(--color-surface-raised)]"
            loading="lazy"
          />
          <div className="flex h-8 min-w-0 items-center gap-3">
            <span className="truncate text-sm font-medium text-[var(--color-text)]">lead</span>
            <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">Team Lead</span>
          </div>
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
            className={cn(
              'h-8 w-full justify-start gap-1 overflow-hidden text-left',
              hasModelIssue &&
                'border-red-500/50 bg-red-500/10 text-red-100 hover:border-red-400/60 hover:bg-red-500/15 hover:text-red-50'
            )}
            aria-label={modelButtonAriaLabel}
            onClick={() => setModelExpanded((prev) => !prev)}
          >
            {modelExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            <ProviderBrandLogo providerId={providerId} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{modelButtonLabel}</span>
            {hasModelIssue ? <AlertTriangle className="size-3.5 shrink-0 text-red-300" /> : null}
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
            providerDisabledReasonById={{ opencode: OPENCODE_TEAM_LEAD_DISABLED_REASON }}
            providerDisabledBadgeLabelById={{ opencode: OPENCODE_TEAM_LEAD_DISABLED_BADGE_LABEL }}
            modelIssueReasonByValue={model.trim() ? { [model.trim()]: modelIssueText } : undefined}
          />
          <EffortLevelSelector
            value={effort ?? ''}
            onValueChange={onEffortChange}
            id="lead-effort"
            providerId={providerId}
            model={model}
            limitContext={limitContext}
          />
          {providerId === 'anthropic' && onFastModeChange ? (
            <AnthropicFastModeSelector
              value={fastMode}
              onValueChange={onFastModeChange}
              providerFastModeDefault={providerFastModeDefault}
              model={model}
              limitContext={limitContext}
              id="lead-fast-mode"
            />
          ) : null}
          {providerId === 'codex' && onFastModeChange ? (
            <CodexFastModeSelector
              value={fastMode}
              onValueChange={onFastModeChange}
              model={model}
              id="lead-fast-mode"
            />
          ) : null}
          {providerId === 'anthropic' ? (
            <LimitContextCheckbox
              id="lead-limit-context"
              checked={limitContext}
              onCheckedChange={onLimitContextChange}
              disabled={isAnthropicHaikuTeamModel(model)}
            />
          ) : null}
          {fastModeNotice ? (
            <div className="bg-amber-500/8 flex items-start gap-2 rounded-md border border-amber-500/25 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
              <Info className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
              <p>{fastModeNotice}</p>
            </div>
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
