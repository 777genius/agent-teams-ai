import React from 'react';

import { LeadModelRow } from './LeadModelRow';
import { MembersEditorSection } from './MembersEditorSection';

import type { MemberDraft } from './membersEditorTypes';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { EffortLevel, TeamFastMode, TeamProviderId } from '@shared/types';

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
  headerTop?: React.ReactNode;
  headerBottom?: React.ReactNode;
  softDeleteMembers?: boolean;
  leadWarningText?: string | null;
  leadFastModeNotice?: string | null;
  memberWarningById?: Record<string, string | null | undefined>;
  disableGeminiOption?: boolean;
  leadModelIssueText?: string | null;
  memberModelIssueById?: Record<string, string | null | undefined>;
  showWorktreeIsolationControls?: boolean;
  teammateWorktreeDefault?: boolean;
  onTeammateWorktreeDefaultChange?: (enabled: boolean) => void;
}

export const TeamRosterEditorSection = ({
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
  fastMode,
  providerFastModeDefault,
  limitContext,
  onProviderChange,
  onModelChange,
  onEffortChange,
  onFastModeChange,
  onLimitContextChange,
  syncModelsWithTeammates,
  onSyncModelsWithTeammatesChange,
  headerTop,
  headerBottom,
  softDeleteMembers = false,
  leadWarningText,
  leadFastModeNotice,
  memberWarningById,
  disableGeminiOption = false,
  leadModelIssueText,
  memberModelIssueById,
  showWorktreeIsolationControls = false,
  teammateWorktreeDefault = false,
  onTeammateWorktreeDefaultChange,
}: TeamRosterEditorSectionProps): React.JSX.Element => {
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
      showWorktreeIsolationControls={showWorktreeIsolationControls}
      teammateWorktreeDefault={teammateWorktreeDefault}
      onTeammateWorktreeDefaultChange={onTeammateWorktreeDefaultChange}
      headerExtra={
        <div className="space-y-3">
          {headerTop}
          <LeadModelRow
            providerId={providerId}
            model={model}
            effort={effort}
            fastMode={fastMode}
            providerFastModeDefault={providerFastModeDefault}
            limitContext={limitContext}
            onProviderChange={onProviderChange}
            onModelChange={onModelChange}
            onEffortChange={onEffortChange}
            onFastModeChange={onFastModeChange}
            onLimitContextChange={onLimitContextChange}
            syncModelsWithTeammates={syncModelsWithTeammates}
            onSyncModelsWithTeammatesChange={onSyncModelsWithTeammatesChange}
            warningText={leadWarningText}
            fastModeNotice={leadFastModeNotice}
            disableGeminiOption={disableGeminiOption}
            modelIssueText={leadModelIssueText}
          />
          {headerBottom}
        </div>
      }
      memberWarningById={memberWarningById}
    />
  );
};
