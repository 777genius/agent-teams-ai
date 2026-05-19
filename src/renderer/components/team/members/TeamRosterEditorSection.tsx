import React from 'react';

import { isAnthropicHaikuTeamModel } from '@renderer/utils/teamModelCatalog';

import { LeadModelRow } from './LeadModelRow';
import { MembersEditorSection } from './MembersEditorSection';

import type { MemberDraft } from './membersEditorTypes';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { EffortLevel, TeamProviderId } from '@shared/types';

interface TeamRosterEditorSectionProps {
  members: MemberDraft[];
  onMembersChange: (members: MemberDraft[]) => void;
  fieldError?: string;
  validateMemberName?: (name: string) => string | null;
  showWorkflow?: boolean;
  showJsonEditor?: boolean;
  draftKeyPrefix?: string;
  projectPath?: string | null;
  taskSuggestions?: MentionSuggestion[];
  teamSuggestions?: MentionSuggestion[];
  hideMembersContent?: boolean;
  existingMembers?: readonly { name: string; color?: string; removedAt?: number | string | null }[];
  defaultProviderId?: TeamProviderId;
  inheritedProviderId: TeamProviderId;
  inheritedModel: string;
  inheritedEffort?: EffortLevel;
  inheritModelSettingsByDefault?: boolean;
  forceInheritedModelSettings?: boolean;
  lockProviderModel?: boolean;
  modelLockReason?: string;
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
  headerTop?: React.ReactNode;
  headerBottom?: React.ReactNode;
  leadProviderNoticeById?: Partial<Record<TeamProviderId, React.ReactNode>>;
  softDeleteMembers?: boolean;
  leadWarningText?: string | null;
  memberWarningById?: Record<string, string | null | undefined>;
  memberInfoById?: Record<string, string | null | undefined>;
  disableGeminiOption?: boolean;
  leadModelIssueText?: string | null;
  memberModelIssueById?: Record<string, string | null | undefined>;
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
  teammateWorktreeDefault?: boolean;
  worktreeIsolationDisabledReason?: string | null;
  onTeammateWorktreeDefaultChange?: (enabled: boolean) => void;
}

const TeamRosterEditorSectionImpl = ({
  members,
  onMembersChange,
  fieldError,
  validateMemberName,
  showWorkflow = false,
  showJsonEditor = true,
  draftKeyPrefix,
  projectPath,
  taskSuggestions,
  teamSuggestions,
  hideMembersContent = false,
  existingMembers,
  defaultProviderId = 'anthropic',
  inheritedProviderId,
  inheritedModel,
  inheritedEffort,
  inheritModelSettingsByDefault = false,
  forceInheritedModelSettings = false,
  lockProviderModel = false,
  modelLockReason,
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
  headerTop,
  headerBottom,
  leadProviderNoticeById,
  softDeleteMembers = false,
  leadWarningText,
  memberWarningById,
  memberInfoById,
  disableGeminiOption = false,
  leadModelIssueText,
  memberModelIssueById,
  modelAdvisoryReasonByProvider,
  modelIssueReasonByProvider,
  modelUnavailableReasonByProvider,
  showWorktreeIsolationControls = false,
  teammateWorktreeDefault = false,
  worktreeIsolationDisabledReason,
  onTeammateWorktreeDefaultChange,
}: TeamRosterEditorSectionProps): React.JSX.Element => {
  const canUseCustomMemberRuntimes =
    !hideMembersContent && !forceInheritedModelSettings && !syncModelsWithTeammates;
  const activeRuntimeMembers = canUseCustomMemberRuntimes
    ? members.filter((member) => !member.removedAt)
    : [];
  const hasCustomAnthropicRuntime = activeRuntimeMembers.some(
    (member) => member.providerId === 'anthropic'
  );
  const hasMemberAnthropicRuntimeWithContextChoice = activeRuntimeMembers.some((member) => {
    if (member.providerId === 'anthropic') {
      const memberModel = member.model?.trim();
      return !memberModel || !isAnthropicHaikuTeamModel(memberModel);
    }

    if (member.providerId == null && providerId === 'anthropic') {
      const memberModel = member.model?.trim();
      return Boolean(memberModel && !isAnthropicHaikuTeamModel(memberModel));
    }

    return false;
  });
  const hasAnthropicRuntime = providerId === 'anthropic' || hasCustomAnthropicRuntime;
  const disableAnthropicContextLimit =
    providerId === 'anthropic' &&
    isAnthropicHaikuTeamModel(model) &&
    !hasMemberAnthropicRuntimeWithContextChoice;

  return (
    <MembersEditorSection
      members={members}
      onChange={onMembersChange}
      fieldError={fieldError}
      validateMemberName={validateMemberName}
      showWorkflow={showWorkflow}
      showJsonEditor={showJsonEditor}
      draftKeyPrefix={draftKeyPrefix}
      projectPath={projectPath}
      taskSuggestions={taskSuggestions}
      teamSuggestions={teamSuggestions}
      hideContent={hideMembersContent}
      existingMembers={existingMembers}
      defaultProviderId={defaultProviderId}
      inheritedProviderId={inheritedProviderId}
      inheritedModel={inheritedModel}
      inheritedEffort={inheritedEffort}
      limitContext={limitContext}
      inheritModelSettingsByDefault={inheritModelSettingsByDefault}
      lockProviderModel={lockProviderModel}
      forceInheritedModelSettings={forceInheritedModelSettings}
      modelLockReason={modelLockReason}
      softDeleteMembers={softDeleteMembers}
      disableGeminiOption={disableGeminiOption}
      memberModelIssueById={memberModelIssueById}
      modelAdvisoryReasonByProvider={modelAdvisoryReasonByProvider}
      modelIssueReasonByProvider={modelIssueReasonByProvider}
      modelUnavailableReasonByProvider={modelUnavailableReasonByProvider}
      showWorktreeIsolationControls={showWorktreeIsolationControls}
      teammateWorktreeDefault={teammateWorktreeDefault}
      worktreeIsolationDisabledReason={worktreeIsolationDisabledReason}
      onTeammateWorktreeDefaultChange={onTeammateWorktreeDefaultChange}
      headerExtra={
        <div className="space-y-3">
          {headerTop}
          <LeadModelRow
            providerId={providerId}
            model={model}
            effort={effort}
            limitContext={limitContext}
            onProviderChange={onProviderChange}
            onModelChange={onModelChange}
            onEffortChange={onEffortChange}
            onLimitContextChange={onLimitContextChange}
            syncModelsWithTeammates={syncModelsWithTeammates}
            onSyncModelsWithTeammatesChange={onSyncModelsWithTeammatesChange}
            warningText={leadWarningText}
            disableGeminiOption={disableGeminiOption}
            providerNoticeById={leadProviderNoticeById}
            modelIssueText={leadModelIssueText}
            modelAdvisoryReasonByValue={modelAdvisoryReasonByProvider?.[providerId]}
            modelIssueReasonByValue={modelIssueReasonByProvider?.[providerId]}
            modelUnavailableReasonByValue={modelUnavailableReasonByProvider?.[providerId]}
            showAnthropicContextLimit={hasAnthropicRuntime}
            disableAnthropicContextLimit={disableAnthropicContextLimit}
          />
          {headerBottom}
        </div>
      }
      memberWarningById={memberWarningById}
      memberInfoById={memberInfoById}
    />
  );
};

export const TeamRosterEditorSection = React.memo(TeamRosterEditorSectionImpl);
TeamRosterEditorSection.displayName = 'TeamRosterEditorSection';
