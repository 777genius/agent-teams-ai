import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Label } from '@renderer/components/ui/label';
import { CUSTOM_ROLE, NO_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { getMemberColorByName } from '@shared/constants/memberColors';
import { Plus } from 'lucide-react';

import { MembersJsonEditor } from '../dialogs/MembersJsonEditor';

import { MemberDraftRow } from './MemberDraftRow';
import { getNextSuggestedMemberName } from './memberNameSets';
import { createMemberDraft, getWorkflowForExport } from './membersEditorUtils';

import type { MemberDraft } from './membersEditorTypes';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';

function membersToJsonText(drafts: MemberDraft[]): string {
  const arr = drafts
    .filter((d) => d.name.trim())
    .map((d) => {
      const role =
        d.roleSelection === CUSTOM_ROLE
          ? d.customRole.trim() || undefined
          : d.roleSelection === NO_ROLE
            ? undefined
            : d.roleSelection.trim() || undefined;
      const obj: Record<string, string> = { name: d.name.trim() };
      if (role) obj.role = role;
      const workflow = getWorkflowForExport(d);
      if (workflow) obj.workflow = workflow;
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
    const presetRoles: readonly string[] = PRESET_ROLES;
    const isPreset = presetRoles.includes(role);
    return createMemberDraft({
      name,
      roleSelection: role ? (isPreset ? role : CUSTOM_ROLE) : '',
      customRole: role && !isPreset ? role : '',
      workflow: workflow || undefined,
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
  /** Extra content rendered right below the "Members" label row */
  headerExtra?: React.ReactNode;
  /** When true, hides member rows and action buttons (label + headerExtra still visible) */
  hideContent?: boolean;
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
  headerExtra,
  hideContent = false,
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

  const removeMember = (memberId: string): void => {
    onChange(members.filter((c) => c.id !== memberId));
  };

  const addMember = (): void => {
    const suggestedName = getNextSuggestedMemberName(members.map((member) => member.name));
    onChange([...members, createMemberDraft({ name: suggestedName })]);
  };

  const names = members.map((m) => m.name.trim().toLowerCase()).filter(Boolean);
  const hasDuplicates = new Set(names).size !== names.length;

  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      members
        .filter((m) => m.name.trim())
        .map((m) => ({
          id: m.id,
          name: m.name.trim(),
          subtitle:
            m.roleSelection === CUSTOM_ROLE
              ? m.customRole.trim() || undefined
              : m.roleSelection && m.roleSelection !== NO_ROLE
                ? m.roleSelection
                : undefined,
          color: getMemberColorByName(m.name.trim()),
        })),
    [members]
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
                nameError={validateMemberName?.(member.name) ?? null}
                onNameChange={updateMemberName}
                onRoleChange={updateMemberRole}
                onCustomRoleChange={updateMemberCustomRole}
                onRemove={removeMember}
                showWorkflow={showWorkflow}
                onWorkflowChange={showWorkflow ? updateMemberWorkflow : undefined}
                onWorkflowChipsChange={showWorkflow ? updateMemberWorkflowChips : undefined}
                draftKeyPrefix={draftKeyPrefix}
                projectPath={projectPath}
                mentionSuggestions={mentionSuggestions}
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
  buildMembersFromDrafts,
  createMemberDraft,
  validateMemberNameInline,
} from './membersEditorUtils';
