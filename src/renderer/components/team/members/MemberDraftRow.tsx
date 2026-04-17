import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { EffortLevelSelector } from '@renderer/components/team/dialogs/EffortLevelSelector';
import {
  getProviderScopedTeamModelLabel,
  getTeamProviderLabel,
  TeamModelSelector,
} from '@renderer/components/team/dialogs/TeamModelSelector';
import { RoleSelect } from '@renderer/components/team/RoleSelect';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useFileListCacheWarmer } from '@renderer/hooks/useFileListCacheWarmer';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { reconcileChips, removeChipTokenFromText } from '@renderer/utils/chipUtils';
import { getMemberColorByName } from '@shared/constants/memberColors';
import { AlertTriangle, ChevronDown, ChevronRight, Info, RotateCcw, Trash2 } from 'lucide-react';

import type { MemberDraft } from './membersEditorTypes';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { EffortLevel, TeamProviderId } from '@shared/types';

interface MemberDraftRowProps {
  member: MemberDraft;
  index: number;
  resolvedColor?: string;
  nameError: string | null;
  onNameChange: (id: string, name: string) => void;
  onRoleChange: (id: string, roleSelection: string) => void;
  onCustomRoleChange: (id: string, customRole: string) => void;
  onRemove: (id: string) => void;
  showWorkflow?: boolean;
  onWorkflowChange?: (id: string, workflow: string) => void;
  onWorkflowChipsChange?: (id: string, chips: InlineChip[]) => void;
  onProviderChange: (id: string, providerId: TeamProviderId) => void;
  onModelChange: (id: string, model: string) => void;
  onEffortChange: (id: string, effort: string) => void;
  inheritedProviderId?: TeamProviderId;
  inheritedModel?: string;
  inheritedEffort?: EffortLevel;
  draftKeyPrefix?: string;
  projectPath?: string | null;
  mentionSuggestions?: MentionSuggestion[];
  taskSuggestions?: MentionSuggestion[];
  teamSuggestions?: MentionSuggestion[];
  lockProviderModel?: boolean;
  forceInheritedModelSettings?: boolean;
  modelLockReason?: string;
  isRemoved?: boolean;
  onRestore?: (id: string) => void;
  warningText?: string | null;
  disableGeminiOption?: boolean;
  modelIssueText?: string | null;
}

export const MemberDraftRow = ({
  member,
  index,
  resolvedColor,
  nameError,
  onNameChange,
  onRoleChange,
  onCustomRoleChange,
  onRemove,
  showWorkflow = false,
  onWorkflowChange,
  onWorkflowChipsChange,
  onProviderChange,
  onModelChange,
  onEffortChange,
  inheritedProviderId = 'anthropic',
  inheritedModel = '',
  inheritedEffort,
  draftKeyPrefix,
  projectPath,
  mentionSuggestions = [],
  taskSuggestions,
  teamSuggestions,
  lockProviderModel = false,
  forceInheritedModelSettings = false,
  modelLockReason,
  isRemoved = false,
  onRestore,
  warningText,
  disableGeminiOption = false,
  modelIssueText,
}: MemberDraftRowProps): React.JSX.Element => {
  const { isLight } = useTheme();
  const memberColorSet = getTeamColorSet(
    resolvedColor ?? getMemberColorByName(member.name.trim() || `member-${index}`)
  );
  const [workflowExpanded, setWorkflowExpanded] = useState(false);
  const [modelExpanded, setModelExpanded] = useState(false);

  // Pre-warm file list cache when workflow section is expanded
  useFileListCacheWarmer(workflowExpanded && projectPath ? projectPath : null);

  const draftKey =
    draftKeyPrefix && (member.name.trim() || member.id)
      ? `${draftKeyPrefix}:workflow:${member.name.trim() || member.id}`
      : null;

  const workflowDraft = useDraftPersistence({
    key: draftKey ?? `workflow:${member.id}`,
    initialValue: member.workflow?.trim() ? member.workflow : undefined,
    enabled: !!draftKey,
  });

  const chips = useMemo(() => member.workflowChips ?? [], [member.workflowChips]);

  const handleWorkflowChange = useCallback(
    (v: string) => {
      const reconciled = reconcileChips(chips, v);
      if (reconciled.length !== chips.length) {
        onWorkflowChipsChange?.(member.id, reconciled);
      }
      workflowDraft.setValue(v);
      onWorkflowChange?.(member.id, v);
    },
    [member.id, chips, onWorkflowChange, onWorkflowChipsChange, workflowDraft]
  );

  const handleFileChipInsert = useCallback(
    (chip: InlineChip) => {
      onWorkflowChipsChange?.(member.id, [...chips, chip]);
    },
    [member.id, chips, onWorkflowChipsChange]
  );

  const handleChipRemove = useCallback(
    (chipId: string) => {
      const chip = chips.find((c) => c.id === chipId);
      if (!chip) return;
      const newChips = chips.filter((c) => c.id !== chipId);
      const newValue = removeChipTokenFromText(workflowDraft.value, chip);
      onWorkflowChipsChange?.(member.id, newChips);
      workflowDraft.setValue(newValue);
      onWorkflowChange?.(member.id, newValue);
    },
    [chips, member.id, onWorkflowChange, onWorkflowChipsChange, workflowDraft]
  );

  useEffect(() => {
    if (
      onWorkflowChange &&
      workflowDraft.value &&
      workflowDraft.value !== (member.workflow ?? '')
    ) {
      onWorkflowChange(member.id, workflowDraft.value);
    }
  }, [workflowDraft.value, member.id, member.workflow, onWorkflowChange]);

  const suggestionsExcludingSelf = mentionSuggestions.filter(
    (s) => s.name.toLowerCase() !== member.name.trim().toLowerCase()
  );
  const effectiveProviderId = forceInheritedModelSettings
    ? inheritedProviderId
    : (member.providerId ?? inheritedProviderId);
  const effectiveModel = forceInheritedModelSettings
    ? inheritedModel
    : (member.model ?? inheritedModel);
  const effectiveEffort = forceInheritedModelSettings
    ? inheritedEffort
    : (member.effort ?? inheritedEffort);
  const modelButtonLabelBase = effectiveModel?.trim()
    ? getProviderScopedTeamModelLabel(effectiveProviderId, effectiveModel.trim())
    : 'Default';
  const modelButtonLabel = forceInheritedModelSettings
    ? `${modelButtonLabelBase} (lead)`
    : modelButtonLabelBase;
  const modelButtonAriaLabel = `${getTeamProviderLabel(effectiveProviderId)} provider, ${modelButtonLabel}`;
  const modelTooltipText = forceInheritedModelSettings
    ? 'Provider, model, and effort are inherited from the lead while sync is enabled.'
    : modelLockReason;
  const hasModelIssue = Boolean(modelIssueText);

  return (
    <div
      className={`relative grid grid-cols-1 gap-2 rounded-md p-2 shadow-sm md:grid-cols-[minmax(0,1fr)_156px_auto] ${isRemoved ? 'opacity-55' : ''}`}
      style={{
        backgroundColor: isLight
          ? 'color-mix(in srgb, var(--color-surface-raised) 22%, white 78%)'
          : 'var(--color-surface-raised)',
        boxShadow: isLight ? '0 1px 2px rgba(15, 23, 42, 0.06)' : '0 1px 2px rgba(0, 0, 0, 0.28)',
      }}
    >
      <div
        className="absolute inset-y-0 left-0 w-1 rounded-l-md"
        style={{ backgroundColor: memberColorSet.border }}
        aria-hidden="true"
      />
      <div className="space-y-0.5">
        <Input
          className="h-8 text-xs"
          value={member.name}
          aria-label={`Member ${index + 1} name`}
          disabled={isRemoved}
          onChange={(event) => onNameChange(member.id, event.target.value)}
          placeholder="member-name"
          style={
            member.name.trim()
              ? {
                  color: memberColorSet.text,
                }
              : undefined
          }
        />
        {nameError ? <p className="text-[10px] text-red-300">{nameError}</p> : null}
      </div>
      <div>
        <RoleSelect
          value={member.roleSelection || '__none__'}
          disabled={isRemoved}
          onValueChange={(roleSelection) => onRoleChange(member.id, roleSelection)}
          customRole={member.customRole}
          onCustomRoleChange={(customRole) => onCustomRoleChange(member.id, customRole)}
          triggerClassName="h-8 text-xs"
          inputClassName="h-8 text-xs"
        />
      </div>
      <div className="space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          {showWorkflow && onWorkflowChange ? (
            <Button
              variant="outline"
              size="sm"
              className="relative h-8 shrink-0 gap-1"
              disabled={isRemoved}
              onClick={() => setWorkflowExpanded((prev) => !prev)}
            >
              {workflowExpanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              Workflow
              {!workflowExpanded && workflowDraft.value.trim() ? (
                <span className="absolute -right-1 -top-1 size-2 rounded-full bg-blue-500" />
              ) : null}
            </Button>
          ) : null}
          <div className="w-full min-w-0 space-y-1 sm:w-[150px] sm:min-w-[150px]">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex w-full">
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      'h-8 w-full justify-start gap-1 overflow-hidden text-left',
                      hasModelIssue &&
                        'border-red-500/50 bg-red-500/10 text-red-100 hover:border-red-400/60 hover:bg-red-500/15 hover:text-red-50'
                    )}
                    aria-label={modelButtonAriaLabel}
                    disabled={lockProviderModel || isRemoved}
                    onClick={() => setModelExpanded((prev) => !prev)}
                  >
                    {modelExpanded ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                    <ProviderBrandLogo
                      providerId={effectiveProviderId}
                      className="size-3.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate">{modelButtonLabel}</span>
                    {hasModelIssue ? (
                      <AlertTriangle className="size-3.5 shrink-0 text-red-300" />
                    ) : null}
                  </Button>
                </span>
              </TooltipTrigger>
              {modelTooltipText || modelIssueText ? (
                <TooltipContent side="top" className="max-w-64 text-xs leading-relaxed">
                  {modelIssueText ? <p className="text-red-300">{modelIssueText}</p> : null}
                  {modelTooltipText ? (
                    <p className={modelIssueText ? 'mt-1 border-t border-white/10 pt-1' : ''}>
                      {modelTooltipText}
                    </p>
                  ) : null}
                </TooltipContent>
              ) : null}
            </Tooltip>
          </div>
          {isRemoved ? (
            <Button
              variant="outline"
              size="sm"
              className="size-8 shrink-0 px-0"
              aria-label={`Restore ${member.name || `member ${index + 1}`}`}
              title="Restore member"
              onClick={() => onRestore?.(member.id)}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="size-8 shrink-0 border-red-500/40 px-0 text-red-300 hover:bg-red-500/10 hover:text-red-200"
              aria-label={`Remove ${member.name || `member ${index + 1}`}`}
              title="Remove member"
              onClick={() => onRemove(member.id)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
        {isRemoved ? (
          <div className="pl-1 text-[11px] text-[var(--color-text-muted)]">Removed</div>
        ) : null}
      </div>
      {!isRemoved && warningText ? (
        <div className="md:col-span-3">
          <div className="bg-amber-500/8 ml-3 flex items-start gap-2 rounded-md border border-amber-500/25 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            <Info className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
            <p>{warningText}</p>
          </div>
        </div>
      ) : null}
      {showWorkflow && onWorkflowChange && workflowExpanded ? (
        <div className="space-y-0.5 pl-3 md:col-span-3">
          <label
            htmlFor={`member-${member.id}-workflow`}
            className="block text-[10px] font-medium text-[var(--color-text-muted)]"
          >
            Workflow (optional)
          </label>
          <MentionableTextarea
            id={`member-${member.id}-workflow`}
            className="min-h-[80px] text-xs"
            minRows={3}
            maxRows={8}
            value={workflowDraft.value}
            onValueChange={handleWorkflowChange}
            suggestions={suggestionsExcludingSelf}
            taskSuggestions={taskSuggestions}
            teamSuggestions={teamSuggestions}
            chips={chips}
            onChipRemove={handleChipRemove}
            projectPath={projectPath ?? undefined}
            onFileChipInsert={handleFileChipInsert}
            placeholder="How this agent should behave, interact with others..."
            footerRight={
              workflowDraft.isSaved ? (
                <span className="text-[10px] text-[var(--color-text-muted)]">Saved</span>
              ) : null
            }
          />
        </div>
      ) : null}
      {modelExpanded && (
        <div className="space-y-2 pl-3 md:col-span-3">
          <TeamModelSelector
            providerId={effectiveProviderId}
            onProviderChange={(providerId) => {
              if (lockProviderModel) return;
              onProviderChange(member.id, providerId);
            }}
            value={effectiveModel ?? ''}
            onValueChange={(value) => {
              if (lockProviderModel) return;
              onModelChange(member.id, value);
            }}
            id={`member-${member.id}-model`}
            disableGeminiOption={disableGeminiOption}
            modelIssueReasonByValue={
              effectiveModel?.trim() ? { [effectiveModel.trim()]: modelIssueText } : undefined
            }
          />
          <EffortLevelSelector
            value={effectiveEffort ?? ''}
            onValueChange={(value) => {
              if (lockProviderModel) return;
              onEffortChange(member.id, value);
            }}
            id={`member-${member.id}-effort`}
          />
          {lockProviderModel && (
            <p className="text-[11px] text-amber-300">
              {modelLockReason ??
                'Provider, model, and effort changes are disabled while the team is live. Reconnect the team to apply them safely.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
