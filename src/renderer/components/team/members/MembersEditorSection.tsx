import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Label } from '@renderer/components/ui/label';
import { CUSTOM_ROLE, NO_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { Plus } from 'lucide-react';

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
      if (d.providerId && d.providerId !== 'anthropic') obj.providerId = d.providerId;
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
    const providerId: TeamProviderId =
      item.providerId === 'codex' || item.providerId === 'gemini' ? item.providerId : 'anthropic';
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    const effort: EffortLevel | undefined =
      item.effort === 'low' || item.effort === 'medium' || item.effort === 'high'
        ? item.effort
        : undefined;
    const presetRoles: readonly string[] = PRESET_ROLES;
    const isPreset = presetRoles.includes(role);
    return createMemberDraft({
      name,
      roleSelection: role ? (isPreset ? role : CUSTOM_ROLE) : '',
      customRole: role && !isPreset ? role : '',
      workflow: workflow || undefined,
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
  /** Default provider to use for newly added member rows. */
  defaultProviderId?: TeamProviderId;
  /** When true, provider/model controls stay read-only for existing rows. */
  lockProviderModel?: boolean;
  inheritedProviderId?: TeamProviderId;
  inheritedModel?: string;
  inheritedEffort?: EffortLevel;
  inheritModelSettingsByDefault?: boolean;
  forceInheritedModelSettings?: boolean;
  modelLockReason?: string;
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
  defaultProviderId = 'anthropic',
  lockProviderModel = false,
  inheritedProviderId,
  inheritedModel,
  inheritedEffort,
  inheritModelSettingsByDefault = false,
  forceInheritedModelSettings = false,
  modelLockReason,
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
              effort:
                effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined,
            }
          : c
      )
    );
  };

  const removeMember = (memberId: string): void => {
    onChange(members.filter((c) => c.id !== memberId));
  };

  const addMember = (): void => {
    const suggestedName = getNextSuggestedMemberName(members.map((member) => member.name));
    onChange([
      ...members,
      createMemberDraft(
        inheritModelSettingsByDefault
          ? { name: suggestedName }
          : { name: suggestedName, providerId: defaultProviderId }
      ),
    ]);
  };

  const names = members.map((m) => m.name.trim().toLowerCase()).filter(Boolean);
  const hasDuplicates = new Set(names).size !== names.length;
  const memberColorMap = useMemo(
    () => buildMemberDraftColorMap(members, existingMembers),
    [members, existingMembers]
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
            <Button variant="outline" size="sm" className="gap-1.5" onClick={addMember}>
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
          <div className="space-y-2">
            {members.map((member, index) => (
              <MemberDraftRow
                key={member.id}
                member={member}
                index={index}
                resolvedColor={memberColorMap.get(member.name.trim())}
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
                inheritedProviderId={inheritedProviderId}
                inheritedModel={inheritedModel}
                inheritedEffort={inheritedEffort}
                forceInheritedModelSettings={forceInheritedModelSettings}
                draftKeyPrefix={draftKeyPrefix}
                projectPath={projectPath}
                mentionSuggestions={mentionSuggestions}
                taskSuggestions={taskSuggestions}
                teamSuggestions={teamSuggestions}
                lockProviderModel={lockProviderModel}
                modelLockReason={modelLockReason}
              />
            ))}
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
  getMemberDraftRole,
  validateMemberNameInline,
} from './membersEditorUtils';
