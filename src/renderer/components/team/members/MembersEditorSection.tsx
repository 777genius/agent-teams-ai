import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';
import { CUSTOM_ROLE, NO_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { getParticipantAvatarUrlByIndex } from '@renderer/utils/memberAvatarCatalog';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import { GitBranch, Plus } from 'lucide-react';

import { MembersJsonEditor } from '../dialogs/MembersJsonEditor';

import { MemberDraftRow } from './MemberDraftRow';
import { getNextSuggestedMemberName } from './memberNameSets';
import {
  buildMemberDraftColorMap,
  buildMemberDraftSuggestions,
  createMemberDraft,
  getMemberDraftRole,
  getWorkflowForExport,
} from './membersEditorUtils';

import type { MemberDraft } from './membersEditorTypes';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { EffortLevel, TeamProviderId } from '@shared/types';

function membersToJsonText(drafts: MemberDraft[]): string {
  const arr = drafts
    .filter((d) => d.name.trim())
    .map((d) => {
      const role = getMemberDraftRole(d);
      const obj: Record<string, string> = { name: d.name.trim() };
      if (role) obj.role = role;
      const workflow = getWorkflowForExport(d);
      if (workflow) obj.workflow = workflow;
      if (d.isolation === 'worktree') obj.isolation = 'worktree';
      if (d.providerId) obj.providerId = d.providerId;
      if (d.model?.trim()) obj.model = d.model.trim();
      if (d.effort) obj.effort = d.effort;
      return obj;
    });
  return JSON.stringify(arr, null, 2);
}

function parseJsonToDrafts(text: string): MemberDraft[] {
  const arr: unknown = JSON.parse(text);
  if (!Array.isArray(arr)) return [];
  return (arr as Record<string, unknown>[]).map((item) => {
    const name = typeof item.name === 'string' ? item.name : '';
    const role = typeof item.role === 'string' ? item.role.trim() : '';
    const workflow = typeof item.workflow === 'string' ? item.workflow.trim() : '';
    const isolation = item.isolation === 'worktree' ? 'worktree' : undefined;
    const providerId = normalizeOptionalTeamProviderId(item.providerId);
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    const effort: EffortLevel | undefined = isTeamEffortLevel(item.effort)
      ? item.effort
      : undefined;
    const presetRoles: readonly string[] = PRESET_ROLES;
    const isPreset = presetRoles.includes(role);
    return createMemberDraft({
      name,
      roleSelection: role ? (isPreset ? role : CUSTOM_ROLE) : '',
      customRole: role && !isPreset ? role : '',
      workflow: workflow || undefined,
      isolation,
      providerId,
      model,
      effort,
    });
  });
}

export interface MembersEditorSectionProps {
  members: MemberDraft[];
  onChange: (members: MemberDraft[]) => void;
  fieldError?: string;
  validateMemberName?: (name: string) => string | null;
  showWorkflow?: boolean;
  showJsonEditor?: boolean;
  /** Prefix for draft persistence keys (e.g. 'createTeam' or 'editTeam:team-alpha') */
  draftKeyPrefix?: string;
  /** Project path for @file mentions in workflow */
  projectPath?: string | null;
  /** Task suggestions for #task references in workflow */
  taskSuggestions?: MentionSuggestion[];
  /** Team suggestions for @@team mentions in workflow */
  teamSuggestions?: MentionSuggestion[];
  /** Extra content rendered right below the "Members" label row */
  headerExtra?: React.ReactNode;
  /** When true, hides member rows and action buttons (label + headerExtra still visible) */
  hideContent?: boolean;
  /** Existing team members — used to reserve their colors so drafts get the next available ones */
  existingMembers?: readonly { name: string; color?: string; removedAt?: number | string | null }[];
  /** Pre-resolved member colors from the live Team view. */
  existingMemberColorMap?: ReadonlyMap<string, string>;
  /** Default provider to use for newly added member rows. */
  defaultProviderId?: TeamProviderId;
  /** When true, provider/model controls stay read-only for existing rows. */
  lockProviderModel?: boolean;
  /** When true, existing teammate names stay read-only while the team is live. */
  lockExistingMemberIdentity?: boolean;
  identityLockReason?: string;
  inheritedProviderId?: TeamProviderId;
  inheritedModel?: string;
  inheritedEffort?: EffortLevel;
  limitContext?: boolean;
  inheritModelSettingsByDefault?: boolean;
  forceInheritedModelSettings?: boolean;
  modelLockReason?: string;
  softDeleteMembers?: boolean;
  memberWarningById?: Record<string, string | null | undefined>;
  disableGeminiOption?: boolean;
  memberModelIssueById?: Record<string, string | null | undefined>;
  disableAddMember?: boolean;
  addMemberLockReason?: string;
  showWorktreeIsolationControls?: boolean;
  teammateWorktreeDefault?: boolean;
  onTeammateWorktreeDefaultChange?: (enabled: boolean) => void;
}

export const MembersEditorSection = ({
  members,
  onChange,
  fieldError,
  validateMemberName,
  showWorkflow = false,
  showJsonEditor = true,
  draftKeyPrefix,
  projectPath,
  taskSuggestions,
  teamSuggestions,
  headerExtra,
  hideContent = false,
  existingMembers,
  existingMemberColorMap,
  defaultProviderId = 'anthropic',
  lockProviderModel = false,
  lockExistingMemberIdentity = false,
  identityLockReason,
  inheritedProviderId,
  inheritedModel,
  inheritedEffort,
  limitContext = false,
  inheritModelSettingsByDefault = false,
  forceInheritedModelSettings = false,
  modelLockReason,
  softDeleteMembers = false,
  memberWarningById,
  disableGeminiOption = false,
  memberModelIssueById,
  disableAddMember = false,
  addMemberLockReason,
  showWorktreeIsolationControls = false,
  teammateWorktreeDefault = false,
  onTeammateWorktreeDefaultChange,
}: MembersEditorSectionProps): React.JSX.Element => {
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const toggleJsonEditor = (): void => {
    if (!jsonEditorOpen) {
      setJsonText(membersToJsonText(members));
      setJsonError(null);
    }
    setJsonEditorOpen((prev) => !prev);
  };

  useEffect(() => {
    if (!jsonEditorOpen || jsonError !== null) return;
    queueMicrotask(() => setJsonText(membersToJsonText(members)));
  }, [members, jsonEditorOpen, jsonError]);

  const handleJsonChange = (text: string): void => {
    setJsonText(text);
    try {
      const drafts = parseJsonToDrafts(text);
      onChange(drafts);
      setJsonError(null);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  };

  const updateMemberName = (memberId: string, name: string): void => {
    onChange(members.map((c) => (c.id === memberId ? { ...c, name } : c)));
  };

  const updateMemberRole = (memberId: string, roleSelection: string): void => {
    const resolvedRole = roleSelection === NO_ROLE ? '' : roleSelection;
    onChange(
      members.map((c) =>
        c.id === memberId
          ? {
              ...c,
              roleSelection: resolvedRole,
              customRole: resolvedRole === CUSTOM_ROLE ? c.customRole : '',
            }
          : c
      )
    );
  };

  const updateMemberCustomRole = (memberId: string, customRole: string): void => {
    onChange(members.map((c) => (c.id === memberId ? { ...c, customRole } : c)));
  };

  const updateMemberWorkflow = (memberId: string, workflow: string): void => {
    onChange(members.map((c) => (c.id === memberId ? { ...c, workflow } : c)));
  };

  const updateMemberWorkflowChips = (memberId: string, workflowChips: InlineChip[]): void => {
    onChange(members.map((c) => (c.id === memberId ? { ...c, workflowChips } : c)));
  };

  const updateMemberProvider = (memberId: string, providerId: TeamProviderId): void => {
    onChange(
      members.map((c) =>
        c.id === memberId
          ? {
              ...c,
              providerId,
              model: c.providerId === providerId ? c.model : '',
            }
          : c
      )
    );
  };

  const updateMemberModel = (memberId: string, model: string): void => {
    onChange(members.map((c) => (c.id === memberId ? { ...c, model } : c)));
  };

  const updateMemberEffort = (memberId: string, effort: string): void => {
    onChange(
      members.map((c) =>
        c.id === memberId
          ? {
              ...c,
              effort: isTeamEffortLevel(effort) ? effort : undefined,
            }
          : c
      )
    );
  };

  const updateMemberIsolation = (memberId: string, enabled: boolean): void => {
    onChange(
      members.map((c) =>
        c.id === memberId ? { ...c, isolation: enabled ? 'worktree' : undefined } : c
      )
    );
  };

  const updateTeammateWorktreeDefault = (enabled: boolean): void => {
    onTeammateWorktreeDefaultChange?.(enabled);
    onChange(
      members.map((member) =>
        member.removedAt ? member : { ...member, isolation: enabled ? 'worktree' : undefined }
      )
    );
  };

  const removeMember = (memberId: string): void => {
    if (!softDeleteMembers) {
      onChange(members.filter((c) => c.id !== memberId));
      return;
    }
    onChange(
      members.map((member) =>
        member.id === memberId ? { ...member, removedAt: member.removedAt ?? Date.now() } : member
      )
    );
  };

  const restoreMember = (memberId: string): void => {
    onChange(
      members.map((member) => (member.id === memberId ? { ...member, removedAt: null } : member))
    );
  };

  const addMember = (): void => {
    const suggestedName = getNextSuggestedMemberName(members.map((member) => member.name));
    onChange([
      ...members,
      createMemberDraft(
        inheritModelSettingsByDefault
          ? {
              name: suggestedName,
              isolation: teammateWorktreeDefault ? 'worktree' : undefined,
            }
          : {
              name: suggestedName,
              providerId: defaultProviderId,
              isolation: teammateWorktreeDefault ? 'worktree' : undefined,
            }
      ),
    ]);
  };

  const activeMembers = members.filter((member) => !member.removedAt);
  const removedMembers = members.filter((member) => member.removedAt);
  const names = activeMembers.map((m) => m.name.trim().toLowerCase()).filter(Boolean);
  const hasDuplicates = new Set(names).size !== names.length;
  const memberColorMap = useMemo(
    () => buildMemberDraftColorMap(members, existingMembers, existingMemberColorMap),
    [members, existingMembers, existingMemberColorMap]
  );
  const worktreeDefaultControlId = useMemo(
    () =>
      `teammate-worktree-default-${(draftKeyPrefix ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '-')}`,
    [draftKeyPrefix]
  );

  const mentionSuggestions = useMemo(
    () => buildMemberDraftSuggestions(members, memberColorMap),
    [members, memberColorMap]
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>Members</Label>
        {!hideContent && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={addMember}
              disabled={disableAddMember}
              title={disableAddMember ? addMemberLockReason : undefined}
            >
              <Plus className="size-3.5" />
              Add member
            </Button>
            {showJsonEditor && !jsonEditorOpen ? (
              <Button variant="ghost" size="sm" onClick={toggleJsonEditor}>
                Edit as JSON
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {headerExtra}
      {!hideContent && (
        <>
          {showWorktreeIsolationControls ? (
            <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2">
              <Checkbox
                id={worktreeDefaultControlId}
                checked={teammateWorktreeDefault}
                onCheckedChange={(checked) => updateTeammateWorktreeDefault(checked === true)}
              />
              <Label
                htmlFor={worktreeDefaultControlId}
                className="flex min-w-0 cursor-pointer items-center gap-1.5 text-xs font-normal text-[var(--color-text-secondary)]"
              >
                <GitBranch className="size-3.5 shrink-0" />
                <span className="truncate">Run teammates in separate worktrees</span>
              </Label>
            </div>
          ) : null}
          {disableAddMember && addMemberLockReason ? (
            <p className="text-[11px] text-[var(--color-text-muted)]">{addMemberLockReason}</p>
          ) : null}
          <div className="space-y-2">
            {activeMembers.map((member, index) => (
              <MemberDraftRow
                key={member.id}
                member={member}
                index={index}
                avatarSrc={getParticipantAvatarUrlByIndex(index + 1)}
                resolvedColor={memberColorMap.get(member.id)}
                nameError={validateMemberName?.(member.name) ?? null}
                onNameChange={updateMemberName}
                onRoleChange={updateMemberRole}
                onCustomRoleChange={updateMemberCustomRole}
                onRemove={removeMember}
                showWorkflow={showWorkflow}
                onWorkflowChange={showWorkflow ? updateMemberWorkflow : undefined}
                onWorkflowChipsChange={showWorkflow ? updateMemberWorkflowChips : undefined}
                onProviderChange={updateMemberProvider}
                onModelChange={updateMemberModel}
                onEffortChange={updateMemberEffort}
                showWorktreeIsolationControls={showWorktreeIsolationControls}
                onWorktreeIsolationChange={updateMemberIsolation}
                inheritedProviderId={inheritedProviderId}
                inheritedModel={inheritedModel}
                inheritedEffort={inheritedEffort}
                limitContext={limitContext}
                forceInheritedModelSettings={forceInheritedModelSettings}
                draftKeyPrefix={draftKeyPrefix}
                projectPath={projectPath}
                mentionSuggestions={mentionSuggestions}
                taskSuggestions={taskSuggestions}
                teamSuggestions={teamSuggestions}
                lockProviderModel={lockProviderModel}
                lockIdentity={lockExistingMemberIdentity && Boolean(member.originalName?.trim())}
                identityLockReason={identityLockReason}
                modelLockReason={modelLockReason}
                warningText={memberWarningById?.[member.id] ?? null}
                disableGeminiOption={disableGeminiOption}
                modelIssueText={memberModelIssueById?.[member.id] ?? null}
              />
            ))}
            {softDeleteMembers && removedMembers.length > 0 ? (
              <div className="pt-2">
                <div className="mb-2 text-[10px] text-[var(--color-text-muted)]">
                  Removed ({removedMembers.length})
                </div>
                <div className="space-y-2">
                  {removedMembers.map((member, index) => (
                    <MemberDraftRow
                      key={member.id}
                      member={member}
                      index={activeMembers.length + index}
                      avatarSrc={getParticipantAvatarUrlByIndex(activeMembers.length + index + 1)}
                      resolvedColor={memberColorMap.get(member.id)}
                      nameError={null}
                      onNameChange={updateMemberName}
                      onRoleChange={updateMemberRole}
                      onCustomRoleChange={updateMemberCustomRole}
                      onRemove={removeMember}
                      onRestore={restoreMember}
                      showWorkflow={showWorkflow}
                      onWorkflowChange={showWorkflow ? updateMemberWorkflow : undefined}
                      onWorkflowChipsChange={showWorkflow ? updateMemberWorkflowChips : undefined}
                      onProviderChange={updateMemberProvider}
                      onModelChange={updateMemberModel}
                      onEffortChange={updateMemberEffort}
                      showWorktreeIsolationControls={showWorktreeIsolationControls}
                      onWorktreeIsolationChange={updateMemberIsolation}
                      inheritedProviderId={inheritedProviderId}
                      inheritedModel={inheritedModel}
                      inheritedEffort={inheritedEffort}
                      limitContext={limitContext}
                      forceInheritedModelSettings={forceInheritedModelSettings}
                      draftKeyPrefix={draftKeyPrefix}
                      projectPath={projectPath}
                      mentionSuggestions={mentionSuggestions}
                      taskSuggestions={taskSuggestions}
                      teamSuggestions={teamSuggestions}
                      lockProviderModel
                      modelLockReason="Removed members are kept for soft delete history. Restore them to edit settings."
                      isRemoved
                      warningText={null}
                      disableGeminiOption={disableGeminiOption}
                      modelIssueText={null}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {jsonEditorOpen && showJsonEditor ? (
              <MembersJsonEditor
                value={jsonText}
                onChange={handleJsonChange}
                error={jsonError}
                onClose={toggleJsonEditor}
              />
            ) : null}
          </div>
          {hasDuplicates ? (
            <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
              Member names must be unique
            </p>
          ) : fieldError ? (
            <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
              {fieldError}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
};

export type { MemberDraft } from './membersEditorTypes';
export {
  buildMemberDraftColorMap,
  buildMemberDraftSuggestions,
  buildMembersFromDrafts,
  clearMemberModelOverrides,
  createMemberDraft,
  createMemberDraftsFromInputs,
  filterEditableMemberInputs,
  getMemberDraftRole,
  normalizeLeadProviderForMode,
  normalizeMemberDraftForProviderMode,
  normalizeProviderForMode,
  validateMemberNameInline,
} from './membersEditorUtils';
