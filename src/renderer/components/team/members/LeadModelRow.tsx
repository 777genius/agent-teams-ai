import React, { useEffect, useState } from 'react';

import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import {
  ANTHROPIC_LONG_CONTEXT_PRICING_URL,
  ANTHROPIC_SONNET_EXTRA_USAGE_WARNING,
  AnthropicExtraUsageWarning,
} from '@renderer/components/team/dialogs/AnthropicExtraUsageWarning';
import { EffortLevelSelector } from '@renderer/components/team/dialogs/EffortLevelSelector';
import { LimitContextCheckbox } from '@renderer/components/team/dialogs/LimitContextCheckbox';
import { OpenCodeContextConfigHint } from '@renderer/components/team/dialogs/OpenCodeContextConfigHint';
import {
  getProviderScopedTeamModelLabel,
  getTeamProviderLabel,
  TeamModelSelector,
} from '@renderer/components/team/dialogs/TeamModelSelector';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import {
  isAnthropicHaikuTeamModel,
  isAnthropicSonnetOneMillionContextTeamModel,
} from '@renderer/utils/teamModelCatalog';
import { resolveTeamLeadColorName } from '@shared/utils/teamMemberColors';
import { AlertTriangle, ChevronDown, ChevronRight, Info } from 'lucide-react';

import { Button } from '../../ui/button';

import type { EffortLevel, TeamProviderId } from '@shared/types';

export { ANTHROPIC_LONG_CONTEXT_PRICING_URL, ANTHROPIC_SONNET_EXTRA_USAGE_WARNING };

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
  providerNoticeById?: Partial<Record<TeamProviderId, React.ReactNode>>;
  modelIssueText?: string | null;
  modelAdvisoryReasonByValue?: Partial<Record<string, string | null | undefined>>;
  modelIssueReasonByValue?: Partial<Record<string, string | null | undefined>>;
  modelUnavailableReasonByValue?: Partial<Record<string, string | null | undefined>>;
  showAnthropicContextLimit?: boolean;
  disableAnthropicContextLimit?: boolean;
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
  providerNoticeById,
  modelIssueText,
  modelAdvisoryReasonByValue,
  modelIssueReasonByValue,
  modelUnavailableReasonByValue,
  showAnthropicContextLimit = providerId === 'anthropic',
  disableAnthropicContextLimit,
}: LeadModelRowProps): React.JSX.Element => {
  const { isLight } = useTheme();
  const hasActiveProviderNotice = Boolean(providerNoticeById?.[providerId]);
  const [modelExpanded, setModelExpanded] = useState(hasActiveProviderNotice);
  const leadColorSet = getTeamColorSet(resolveTeamLeadColorName());
  const modelButtonLabel = model.trim()
    ? getProviderScopedTeamModelLabel(providerId, model.trim())
    : 'Default';
  const modelButtonAriaLabel = `${getTeamProviderLabel(providerId)} provider, ${modelButtonLabel}`;
  const selectedModelIssueText =
    model.trim() && modelIssueReasonByValue?.[model.trim()]
      ? modelIssueReasonByValue[model.trim()]
      : null;
  const selectedModelUnavailableText =
    model.trim() && modelUnavailableReasonByValue?.[model.trim()]
      ? modelUnavailableReasonByValue[model.trim()]
      : null;
  const selectedModelAdvisoryText =
    model.trim() && modelAdvisoryReasonByValue?.[model.trim()]
      ? modelAdvisoryReasonByValue[model.trim()]
      : null;
  const currentModelIssueText =
    modelIssueText ?? selectedModelUnavailableText ?? selectedModelIssueText ?? null;
  const currentModelAdvisoryText = currentModelIssueText ? null : selectedModelAdvisoryText;
  const hasModelIssue = Boolean(currentModelIssueText);
  const hasModelAdvisory = Boolean(currentModelAdvisoryText);
  const showSonnetExtraUsageWarning =
    providerId === 'anthropic' &&
    !limitContext &&
    isAnthropicSonnetOneMillionContextTeamModel(model);
  const warningMessages = [warningText?.trim() || null].filter((message): message is string =>
    Boolean(message)
  );
  const hasWarnings = warningMessages.length > 0 || showSonnetExtraUsageWarning;
  const contextLimitDisabled =
    disableAnthropicContextLimit ??
    (providerId === 'anthropic' && isAnthropicHaikuTeamModel(model));

  useEffect(() => {
    if (hasActiveProviderNotice && !modelExpanded) {
      setModelExpanded(true);
    }
  }, [hasActiveProviderNotice, modelExpanded]);

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
                'border-red-500/50 bg-red-500/10 text-red-100 hover:border-red-400/60 hover:bg-red-500/15 hover:text-red-50',
              hasModelAdvisory &&
                'border-amber-300/45 bg-amber-300/10 text-amber-100 hover:border-amber-300/60 hover:bg-amber-300/15 hover:text-amber-50'
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
            {hasModelAdvisory ? <Info className="size-3.5 shrink-0 text-amber-300" /> : null}
          </Button>
        </div>
      </div>
      {hasWarnings ? (
        <div className="md:col-span-3">
          <div className="bg-amber-500/8 ml-3 flex items-start gap-2 rounded-md border border-amber-500/25 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            <Info className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
            <div className="space-y-1">
              {warningMessages.map((message) => (
                <p key={message}>{message}</p>
              ))}
              {showSonnetExtraUsageWarning ? <AnthropicExtraUsageWarning /> : null}
            </div>
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
            providerNoticeById={providerNoticeById}
            modelAdvisoryReasonByValue={modelAdvisoryReasonByValue}
            modelIssueReasonByValue={{
              ...(modelIssueReasonByValue ?? {}),
              ...(model.trim() && modelIssueText ? { [model.trim()]: modelIssueText } : {}),
            }}
            modelUnavailableReasonByValue={modelUnavailableReasonByValue}
          />
          <EffortLevelSelector
            value={effort ?? ''}
            onValueChange={onEffortChange}
            id="lead-effort"
            providerId={providerId}
            model={model}
            limitContext={limitContext}
          />
          {providerId === 'opencode' ? <OpenCodeContextConfigHint /> : null}
          {showAnthropicContextLimit ? (
            <LimitContextCheckbox
              id="lead-limit-context"
              checked={limitContext}
              onCheckedChange={onLimitContextChange}
              disabled={contextLimitDisabled}
              scopeLabel={providerId === 'anthropic' ? undefined : 'Anthropic team-wide'}
            />
          ) : null}
          <div className="flex items-start gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2">
            <Info className="mt-0.5 size-3.5 shrink-0 text-sky-400" />
            <p className="text-[11px] leading-relaxed text-sky-300">
              Lead runtime applies to teammates unless they set their own provider or model.
              {showAnthropicContextLimit
                ? ' The 200K context limit is team-wide for Anthropic runtimes in this launch, including custom Anthropic teammates.'
                : null}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
};
