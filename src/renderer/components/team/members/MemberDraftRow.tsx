import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { AnthropicExtraUsageWarning } from '@renderer/components/team/dialogs/AnthropicExtraUsageWarning';
import { EffortLevelSelector } from '@renderer/components/team/dialogs/EffortLevelSelector';
import { OpenCodeContextConfigHint } from '@renderer/components/team/dialogs/OpenCodeContextConfigHint';
import {
  formatTeamModelSummary,
  getProviderScopedTeamModelLabel,
  getTeamProviderLabel,
  TeamModelSelector,
} from '@renderer/components/team/dialogs/TeamModelSelector';
import { RoleSelect } from '@renderer/components/team/RoleSelect';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { HoverTooltip } from '@renderer/components/ui/hover-tooltip';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useFileListCacheWarmer } from '@renderer/hooks/useFileListCacheWarmer';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { reconcileChips, removeChipTokenFromText } from '@renderer/utils/chipUtils';
import { isAnthropicSonnetOneMillionContextTeamModel } from '@renderer/utils/teamModelCatalog';
import { getMemberColorByName } from '@shared/constants/memberColors';
import {
  normalizeTeamMemberMcpPolicy,
  resolveTeamMemberMcpScopes,
} from '@shared/utils/teamMemberMcpPolicy';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Info,
  Plug,
  RotateCcw,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react';

import type { MemberDraft } from './membersEditorTypes';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';
import type {
  EffortLevel,
  TeamMemberMcpMode,
  TeamMemberMcpPolicy,
  TeamProviderId,
} from '@shared/types';

interface MemberDraftRowProps {
  member: MemberDraft;
  index: number;
  avatarSrc?: string;
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
  limitContext?: boolean;
  draftKeyPrefix?: string;
  projectPath?: string | null;
  mentionSuggestions?: MentionSuggestion[];
  taskSuggestions?: MentionSuggestion[];
  teamSuggestions?: MentionSuggestion[];
  lockProviderModel?: boolean;
  lockRole?: boolean;
  lockedRoleLabel?: string;
  lockIdentity?: boolean;
  identityLockReason?: string;
  forceInheritedModelSettings?: boolean;
  modelLockReason?: string;
  isRemoved?: boolean;
  onRestore?: (id: string) => void;
  hideActionButton?: boolean;
  warningText?: string | null;
  infoText?: string | null;
  disableGeminiOption?: boolean;
  modelIssueText?: string | null;
  modelAdvisoryReasonByProvider?: Partial<
    Record<TeamProviderId, Partial<Record<string, string | null | undefined>>>
  >;
  modelIssueReasonByProvider?: Partial<
    Record<TeamProviderId, Partial<Record<string, string | null | undefined>>>
  >;
  modelUnavailableReasonByProvider?: Partial<
    Record<TeamProviderId, Partial<Record<string, string | null | undefined>>>
  >;
  showWorktreeIsolationControls?: boolean;
  worktreeIsolationDisabledReason?: string | null;
  onWorktreeIsolationChange?: (id: string, enabled: boolean) => void;
  onMcpPolicyChange?: (id: string, policy: TeamMemberMcpPolicy | undefined) => void;
  agentTeamsMcpLocked?: boolean;
  lockedModelAction?: {
    label: string;
    description?: string;
    onClick: () => void;
    disabled?: boolean;
  };
}

export const MemberDraftRow = ({
  member,
  index,
  avatarSrc,
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
  limitContext = false,
  draftKeyPrefix,
  projectPath,
  mentionSuggestions = [],
  taskSuggestions,
  teamSuggestions,
  lockProviderModel = false,
  lockRole = false,
  lockedRoleLabel,
  lockIdentity = false,
  identityLockReason,
  forceInheritedModelSettings = false,
  modelLockReason,
  isRemoved = false,
  onRestore,
  hideActionButton = false,
  warningText,
  infoText,
  disableGeminiOption = false,
  modelIssueText,
  modelAdvisoryReasonByProvider,
  modelIssueReasonByProvider,
  modelUnavailableReasonByProvider,
  showWorktreeIsolationControls = false,
  worktreeIsolationDisabledReason,
  onWorktreeIsolationChange,
  onMcpPolicyChange,
  agentTeamsMcpLocked = false,
  lockedModelAction,
}: MemberDraftRowProps): React.JSX.Element => {
  const { isLight } = useTheme();
  const memberColorSet = getTeamColorSet(
    resolvedColor ??
      getMemberColorByName(member.originalName?.trim() || member.name.trim() || `member-${index}`)
  );
  const [workflowExpanded, setWorkflowExpanded] = useState(false);
  const [modelExpanded, setModelExpanded] = useState(false);
  const [mcpExpanded, setMcpExpanded] = useState(false);

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

  const effectiveMcpPolicy = useMemo<TeamMemberMcpPolicy | undefined>(
    () => (agentTeamsMcpLocked ? { mode: 'appOnly' } : member.mcpPolicy),
    [agentTeamsMcpLocked, member.mcpPolicy]
  );
  const mcpMode: TeamMemberMcpMode = effectiveMcpPolicy?.mode ?? 'inheritLead';
  const mcpScopes = useMemo(
    () => resolveTeamMemberMcpScopes(effectiveMcpPolicy),
    [effectiveMcpPolicy]
  );
  const mcpServerNames = useMemo(
    () => effectiveMcpPolicy?.serverNames ?? [],
    [effectiveMcpPolicy?.serverNames]
  );
  const mcpButtonLabel =
    mcpMode === 'appOnly'
      ? 'Agent Teams MCP'
      : mcpMode === 'strictAllowlist'
        ? `MCP ${mcpServerNames.length || 'strict'}`
        : mcpMode === 'inheritScopes'
          ? 'MCP scopes'
          : 'MCP inherit';
  const updateMcpPolicy = useCallback(
    (policy: TeamMemberMcpPolicy | undefined) => {
      if (agentTeamsMcpLocked) {
        return;
      }
      onMcpPolicyChange?.(member.id, normalizeTeamMemberMcpPolicy(policy));
    },
    [agentTeamsMcpLocked, member.id, onMcpPolicyChange]
  );
  const handleMcpModeChange = useCallback(
    (mode: string) => {
      if (mode === 'inheritLead') {
        updateMcpPolicy(undefined);
        return;
      }
      if (mode === 'appOnly') {
        updateMcpPolicy({ mode: 'appOnly' });
        return;
      }
      if (mode === 'inheritScopes' || mode === 'strictAllowlist') {
        updateMcpPolicy({
          mode,
          scopes: mcpScopes,
          ...(mode === 'strictAllowlist' && mcpServerNames.length > 0
            ? { serverNames: mcpServerNames }
            : {}),
        });
      }
    },
    [mcpScopes, mcpServerNames, updateMcpPolicy]
  );
  const updateMcpScope = useCallback(
    (scope: 'user' | 'project' | 'local', enabled: boolean) => {
      if (mcpMode !== 'inheritScopes' && mcpMode !== 'strictAllowlist') {
        return;
      }
      updateMcpPolicy({
        mode: mcpMode,
        scopes: { ...mcpScopes, [scope]: enabled },
        ...(mcpMode === 'strictAllowlist' && mcpServerNames.length > 0
          ? { serverNames: mcpServerNames }
          : {}),
      });
    },
    [mcpMode, mcpScopes, mcpServerNames, updateMcpPolicy]
  );
  const updateMcpServerNames = useCallback(
    (value: string) => {
      const serverNames = value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
      updateMcpPolicy({
        mode: 'strictAllowlist',
        scopes: mcpScopes,
        serverNames,
      });
    },
    [mcpScopes, updateMcpPolicy]
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
  const canOpenLockedModelPanel = lockProviderModel && !isRemoved && Boolean(lockedModelAction);
  const modelTooltipText = forceInheritedModelSettings
    ? 'Provider, model, and effort are inherited from the lead while sync is enabled.'
    : lockProviderModel
      ? (lockedModelAction?.description ?? modelLockReason)
      : undefined;
  const worktreeIsolationDisabled =
    isRemoved || Boolean(worktreeIsolationDisabledReason && member.isolation !== 'worktree');
  const worktreeIsolationDescription =
    worktreeIsolationDisabledReason && member.isolation !== 'worktree'
      ? worktreeIsolationDisabledReason
      : 'Run this teammate in a separate git worktree. Apply/reject changes targets that worktree, not the lead workspace.';
  const worktreeIsolationDescriptionId = showWorktreeIsolationControls
    ? `member-${member.id}-worktree-isolation-description`
    : undefined;
  const effectiveModelKey = effectiveModel?.trim() ?? '';
  const selectedModelIssueText =
    effectiveModelKey && modelIssueReasonByProvider?.[effectiveProviderId]?.[effectiveModelKey]
      ? modelIssueReasonByProvider[effectiveProviderId]?.[effectiveModelKey]
      : null;
  const selectedModelUnavailableText =
    effectiveModelKey &&
    modelUnavailableReasonByProvider?.[effectiveProviderId]?.[effectiveModelKey]
      ? modelUnavailableReasonByProvider[effectiveProviderId]?.[effectiveModelKey]
      : null;
  const selectedModelAdvisoryText =
    effectiveModelKey && modelAdvisoryReasonByProvider?.[effectiveProviderId]?.[effectiveModelKey]
      ? modelAdvisoryReasonByProvider[effectiveProviderId]?.[effectiveModelKey]
      : null;
  const currentModelIssueText =
    modelIssueText ?? selectedModelUnavailableText ?? selectedModelIssueText ?? null;
  const currentModelAdvisoryText = currentModelIssueText ? null : selectedModelAdvisoryText;
  const hasModelIssue = Boolean(currentModelIssueText);
  const hasModelAdvisory = Boolean(currentModelAdvisoryText);
  const modelButtonDisabled = (lockProviderModel && !canOpenLockedModelPanel) || isRemoved;
  const modelButtonTitle =
    [currentModelIssueText ?? currentModelAdvisoryText, modelTooltipText]
      .filter((message): message is string => Boolean(message))
      .join('\n') || undefined;
  const modelIssueDescriptionId =
    hasModelIssue || hasModelAdvisory ? `member-${member.id}-model-issue` : undefined;
  const modelHelpDescriptionId = modelTooltipText ? `member-${member.id}-model-help` : undefined;
  const modelButtonDescribedBy =
    [modelIssueDescriptionId, modelHelpDescriptionId].filter(Boolean).join(' ') || undefined;
  const modelButtonTooltipContent =
    currentModelIssueText || currentModelAdvisoryText || modelTooltipText ? (
      <>
        {currentModelIssueText ? (
          <span className="block text-red-300">{currentModelIssueText}</span>
        ) : null}
        {currentModelAdvisoryText ? (
          <span className="block text-amber-200">{currentModelAdvisoryText}</span>
        ) : null}
        {modelTooltipText ? (
          <span
            className={cn(
              'block',
              (currentModelIssueText || currentModelAdvisoryText) &&
                'mt-1 border-t border-white/10 pt-1'
            )}
          >
            {modelTooltipText}
          </span>
        ) : null}
      </>
    ) : null;
  const hasCustomProviderOrModel =
    !forceInheritedModelSettings && Boolean(member.providerId || member.model?.trim());
  const showSonnetExtraUsageWarning =
    effectiveProviderId === 'anthropic' &&
    !limitContext &&
    hasCustomProviderOrModel &&
    isAnthropicSonnetOneMillionContextTeamModel(effectiveModel);
  const warningMessages = [warningText?.trim() || null].filter((message): message is string =>
    Boolean(message)
  );
  const hasWarnings = warningMessages.length > 0 || showSonnetExtraUsageWarning;
  const anthropicContextModeLabel = limitContext ? '200K limit enabled' : 'default context setting';
  const workflowTooltipText = workflowDraft.value.trim()
    ? 'Edit teammate workflow'
    : 'Add teammate workflow';
  const mcpTooltipText = `${mcpButtonLabel}: Control this member's MCP inheritance policy`;
  const mcpLockedInfoText =
    'Agent Teams MCP only is enabled for all teammates. This teammate will launch with only the Agent Teams server.';
  const mcpSettingInfoText = agentTeamsMcpLocked
    ? mcpLockedInfoText
    : 'Agent Teams MCP launches this teammate with only the Agent Teams server. Scope and allowlist modes apply only to this teammate launch.';
  const runtimeSummary = formatTeamModelSummary(
    effectiveProviderId,
    effectiveModel?.trim() ?? '',
    effectiveEffort
  );

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
        <div className="flex items-center gap-2">
          {avatarSrc ? (
            <img
              src={avatarSrc}
              alt=""
              className="size-8 shrink-0 rounded-full bg-[var(--color-surface-raised)]"
              loading="lazy"
            />
          ) : null}
          <Input
            className="h-8 text-xs"
            value={member.name}
            aria-label={`Member ${index + 1} name`}
            disabled={isRemoved || lockIdentity}
            title={lockIdentity ? identityLockReason : undefined}
            onChange={(event) => onNameChange(member.id, event.target.value)}
            placeholder="member-name"
          />
        </div>
        {nameError ? <p className="text-[10px] text-red-300">{nameError}</p> : null}
      </div>
      <div>
        {lockRole ? (
          <div className="flex h-8 items-center rounded-md border border-[var(--color-border)] bg-transparent px-3 text-xs text-[var(--color-text)] opacity-80">
            {lockedRoleLabel || member.customRole || member.roleSelection || 'No role'}
          </div>
        ) : (
          <RoleSelect
            value={member.roleSelection || '__none__'}
            disabled={isRemoved}
            onValueChange={(roleSelection) => onRoleChange(member.id, roleSelection)}
            customRole={member.customRole}
            onCustomRoleChange={(customRole) => onCustomRoleChange(member.id, customRole)}
            triggerClassName="h-8 text-xs"
            inputClassName="h-8 text-xs"
          />
        )}
      </div>
      <div className="space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="w-full min-w-0 space-y-1 sm:w-[150px] sm:min-w-[150px]">
            <HoverTooltip
              content={modelButtonTooltipContent}
              title={modelButtonTitle}
              disabled={!modelButtonTooltipContent}
              className="w-full"
              contentClassName="max-w-64"
            >
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
                aria-describedby={modelButtonDescribedBy}
                disabled={modelButtonDisabled}
                onClick={() => setModelExpanded((prev) => !prev)}
              >
                {modelExpanded ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                <ProviderBrandLogo providerId={effectiveProviderId} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{modelButtonLabel}</span>
                {hasModelIssue ? (
                  <AlertTriangle className="size-3.5 shrink-0 text-red-300" />
                ) : null}
                {hasModelAdvisory ? <Info className="size-3.5 shrink-0 text-amber-300" /> : null}
              </Button>
            </HoverTooltip>
            {modelTooltipText ? (
              <span id={modelHelpDescriptionId} className="sr-only">
                {modelTooltipText}
              </span>
            ) : null}
            {currentModelIssueText || currentModelAdvisoryText ? (
              <p
                id={modelIssueDescriptionId}
                className={cn(
                  'flex items-start gap-1 text-[10px] leading-snug',
                  currentModelIssueText ? 'text-red-300' : 'text-amber-200'
                )}
              >
                {currentModelIssueText ? (
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                ) : (
                  <Info className="mt-0.5 size-3 shrink-0" />
                )}
                <span>{currentModelIssueText ?? currentModelAdvisoryText}</span>
              </p>
            ) : null}
          </div>
          {showWorktreeIsolationControls ? (
            <div className="space-y-0.5">
              <HoverTooltip
                as="div"
                content={worktreeIsolationDescription}
                title={worktreeIsolationDescription}
                className="shrink-0"
                contentClassName="max-w-64"
              >
                <div
                  className={cn(
                    'flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 text-xs text-[var(--color-text-secondary)]',
                    worktreeIsolationDisabled && 'cursor-not-allowed opacity-50'
                  )}
                  aria-describedby={worktreeIsolationDescriptionId}
                >
                  <Checkbox
                    id={`member-${member.id}-worktree-isolation`}
                    checked={member.isolation === 'worktree'}
                    disabled={worktreeIsolationDisabled}
                    aria-describedby={worktreeIsolationDescriptionId}
                    onCheckedChange={(checked) =>
                      onWorktreeIsolationChange?.(member.id, checked === true)
                    }
                  />
                  <Label
                    htmlFor={`member-${member.id}-worktree-isolation`}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 text-xs font-normal',
                      worktreeIsolationDisabled && 'cursor-not-allowed'
                    )}
                  >
                    <GitBranch className="size-3.5 shrink-0" />
                    <span>Worktree</span>
                  </Label>
                </div>
              </HoverTooltip>
              <span id={worktreeIsolationDescriptionId} className="sr-only">
                {worktreeIsolationDescription}
              </span>
            </div>
          ) : null}
          {showWorkflow && onWorkflowChange ? (
            <HoverTooltip
              content={workflowTooltipText}
              title={workflowTooltipText}
              dismissOnClick
              className="shrink-0"
              contentClassName="max-w-64"
            >
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'relative size-8 shrink-0 px-0',
                  workflowExpanded &&
                    'border-blue-400/50 bg-blue-500/10 text-blue-100 hover:bg-blue-500/15'
                )}
                aria-label={workflowTooltipText}
                aria-expanded={workflowExpanded}
                disabled={isRemoved}
                onClick={() => setWorkflowExpanded((prev) => !prev)}
              >
                <WorkflowIcon className="size-3.5" />
                {!workflowExpanded && workflowDraft.value.trim() ? (
                  <span className="absolute -right-1 -top-1 size-2 rounded-full bg-blue-500" />
                ) : null}
              </Button>
            </HoverTooltip>
          ) : null}
          {onMcpPolicyChange ? (
            <HoverTooltip
              content={mcpTooltipText}
              title={mcpTooltipText}
              dismissOnClick
              className="shrink-0"
              contentClassName="max-w-64"
            >
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'relative size-8 shrink-0 px-0',
                  agentTeamsMcpLocked &&
                    'border-amber-300/50 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15',
                  !agentTeamsMcpLocked &&
                    (mcpExpanded || mcpMode !== 'inheritLead') &&
                    'border-sky-400/45 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15'
                )}
                aria-label={mcpTooltipText}
                aria-expanded={mcpExpanded}
                disabled={isRemoved}
                onClick={() => setMcpExpanded((prev) => !prev)}
              >
                <Plug className="size-3.5" />
                {agentTeamsMcpLocked || mcpMode !== 'inheritLead' ? (
                  <span
                    className={cn(
                      'absolute -right-1 -top-1 size-2 rounded-full',
                      agentTeamsMcpLocked ? 'bg-amber-300' : 'bg-sky-400'
                    )}
                  />
                ) : null}
              </Button>
            </HoverTooltip>
          ) : null}
          {hideActionButton ? null : isRemoved ? (
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
      {!isRemoved && hasWarnings ? (
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
      {!isRemoved && infoText ? (
        <div className="md:col-span-3">
          <div className="ml-3 flex items-start gap-2 rounded-md border border-sky-400/25 bg-sky-500/10 px-3 py-2 text-[11px] leading-relaxed text-sky-100">
            <Info className="mt-0.5 size-3.5 shrink-0 text-sky-300" />
            <p className="min-w-0 whitespace-pre-wrap break-words">{infoText}</p>
          </div>
        </div>
      ) : null}
      {!isRemoved && onMcpPolicyChange && mcpExpanded ? (
        <div className="space-y-3 pl-3 md:col-span-3">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <div className="grid gap-3 sm:grid-cols-[minmax(160px,220px)_1fr]">
              <div className="space-y-1">
                <Label
                  htmlFor={`member-${member.id}-mcp-mode`}
                  className="text-[10px] text-[var(--color-text-muted)]"
                >
                  MCP mode
                </Label>
                <Select
                  value={mcpMode}
                  onValueChange={handleMcpModeChange}
                  disabled={agentTeamsMcpLocked}
                >
                  <SelectTrigger
                    id={`member-${member.id}-mcp-mode`}
                    className="h-8 text-xs"
                    disabled={agentTeamsMcpLocked}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inheritLead">Inherit lead</SelectItem>
                    <SelectItem value="inheritScopes">Choose scopes</SelectItem>
                    <SelectItem value="strictAllowlist">Strict allowlist</SelectItem>
                    <SelectItem value="appOnly">Agent Teams MCP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <div className="grid gap-2 sm:grid-cols-3">
                  {(['user', 'project', 'local'] as const).map((scope) => (
                    <label
                      key={scope}
                      className={cn(
                        'flex h-8 items-center gap-2 rounded-md border border-[var(--color-border)] px-2 text-xs text-[var(--color-text-secondary)]',
                        (agentTeamsMcpLocked ||
                          mcpMode === 'inheritLead' ||
                          mcpMode === 'appOnly') &&
                          'opacity-50'
                      )}
                    >
                      <Checkbox
                        checked={mcpMode === 'appOnly' ? false : mcpScopes[scope]}
                        disabled={
                          agentTeamsMcpLocked || mcpMode === 'inheritLead' || mcpMode === 'appOnly'
                        }
                        onCheckedChange={(checked) => updateMcpScope(scope, checked === true)}
                      />
                      <span className="capitalize">{scope}</span>
                    </label>
                  ))}
                </div>
                {mcpMode === 'strictAllowlist' ? (
                  <div className="space-y-1">
                    <Label
                      htmlFor={`member-${member.id}-mcp-servers`}
                      className="text-[10px] text-[var(--color-text-muted)]"
                    >
                      Server names
                    </Label>
                    <Input
                      id={`member-${member.id}-mcp-servers`}
                      className="h-8 text-xs"
                      value={mcpServerNames.join(', ')}
                      disabled={agentTeamsMcpLocked}
                      onChange={(event) => updateMcpServerNames(event.target.value)}
                      placeholder="github, sentry"
                    />
                  </div>
                ) : null}
                {mcpMode !== 'inheritLead' ? (
                  <p className="text-[10px] leading-snug text-amber-200">{mcpSettingInfoText}</p>
                ) : null}
              </div>
            </div>
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
          {lockProviderModel && lockedModelAction ? (
            <div className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-[var(--color-text)]">
                  Current lead runtime
                </p>
                <p className="text-[11px] text-[var(--color-text-muted)]">{runtimeSummary}</p>
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                {lockedModelAction.description ??
                  'Lead runtime changes open Relaunch Team, where provider, model, and effort can be updated.'}
              </p>
              <p className="text-[11px] text-amber-300">
                Saving those runtime changes restarts the whole team.
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-fit"
                onClick={lockedModelAction.onClick}
                disabled={lockedModelAction.disabled}
              >
                {lockedModelAction.label}
              </Button>
            </div>
          ) : (
            <>
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
                modelAdvisoryReasonByValue={modelAdvisoryReasonByProvider?.[effectiveProviderId]}
                modelIssueReasonByValue={{
                  ...(modelIssueReasonByProvider?.[effectiveProviderId] ?? {}),
                  ...(effectiveModelKey && modelIssueText
                    ? { [effectiveModelKey]: modelIssueText }
                    : {}),
                }}
                modelUnavailableReasonByValue={
                  modelUnavailableReasonByProvider?.[effectiveProviderId]
                }
              />
              <EffortLevelSelector
                value={effectiveEffort ?? ''}
                onValueChange={(value) => {
                  if (lockProviderModel) return;
                  onEffortChange(member.id, value);
                }}
                id={`member-${member.id}-effort`}
                providerId={effectiveProviderId}
                model={effectiveModel}
                limitContext={limitContext}
              />
              {effectiveProviderId === 'opencode' ? <OpenCodeContextConfigHint /> : null}
              {effectiveProviderId === 'anthropic' ? (
                <div className="flex items-start gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2">
                  <Info className="mt-0.5 size-3.5 shrink-0 text-sky-400" />
                  <p className="text-[11px] leading-relaxed text-sky-300">
                    Anthropic context is team-wide for this launch: {anthropicContextModeLabel}. Use
                    the lead runtime panel&apos;s Limit context checkbox to change it.
                  </p>
                </div>
              ) : null}
              {lockProviderModel && (
                <p className="text-[11px] text-amber-300">
                  {modelLockReason ??
                    'Provider, model, and effort changes are disabled while the team is live. Reconnect the team to apply them safely.'}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
