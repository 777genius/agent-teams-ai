import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { CUSTOM_ROLE, NO_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { reconcileChips, removeChipTokenFromText } from '@renderer/utils/chipUtils';
import { getMemberColor } from '@shared/constants/memberColors';
import { ChevronDown, ChevronRight } from 'lucide-react';

import type { MemberDraft } from './membersEditorTypes';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';

interface MemberDraftRowProps {
  member: MemberDraft;
  index: number;
  nameError: string | null;
  onNameChange: (id: string, name: string) => void;
  onRoleChange: (id: string, roleSelection: string) => void;
  onCustomRoleChange: (id: string, customRole: string) => void;
  onRemove: (id: string) => void;
  showWorkflow?: boolean;
  onWorkflowChange?: (id: string, workflow: string) => void;
  onWorkflowChipsChange?: (id: string, chips: InlineChip[]) => void;
  draftKeyPrefix?: string;
  projectPath?: string | null;
  mentionSuggestions?: MentionSuggestion[];
}

export const MemberDraftRow = ({
  member,
  index,
  nameError,
  onNameChange,
  onRoleChange,
  onCustomRoleChange,
  onRemove,
  showWorkflow = false,
  onWorkflowChange,
  onWorkflowChipsChange,
  draftKeyPrefix,
  projectPath,
  mentionSuggestions = [],
}: MemberDraftRowProps): React.JSX.Element => {
  const memberColorSet = getTeamColorSet(getMemberColor(index));
  const [workflowExpanded, setWorkflowExpanded] = useState(false);

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

  return (
    <div
      className="grid grid-cols-1 gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2 md:grid-cols-[1fr_220px_auto]"
      style={{
        borderLeftWidth: '3px',
        borderLeftColor: memberColorSet.border,
      }}
    >
      <div className="space-y-0.5">
        <Input
          className="h-8 text-xs"
          value={member.name}
          aria-label={`Member ${index + 1} name`}
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
      <div className="space-y-1">
        <Select
          value={member.roleSelection || NO_ROLE}
          onValueChange={(roleSelection) => onRoleChange(member.id, roleSelection)}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={`Member ${index + 1} role`}>
            <SelectValue placeholder="No role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_ROLE}>No role</SelectItem>
            {PRESET_ROLES.map((role) => (
              <SelectItem key={role} value={role}>
                {role}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_ROLE}>Custom role...</SelectItem>
          </SelectContent>
        </Select>
        {member.roleSelection === CUSTOM_ROLE ? (
          <Input
            className="h-8 text-xs"
            value={member.customRole}
            aria-label={`Member ${index + 1} custom role`}
            onChange={(event) => onCustomRoleChange(member.id, event.target.value)}
            placeholder="e.g. architect"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        {showWorkflow && onWorkflowChange ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1"
            onClick={() => setWorkflowExpanded((prev) => !prev)}
          >
            {workflowExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            Workflow
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
          onClick={() => onRemove(member.id)}
        >
          Remove
        </Button>
      </div>
      {showWorkflow && onWorkflowChange && workflowExpanded ? (
        <div className="space-y-0.5 md:col-span-3">
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
            chips={chips}
            onChipRemove={handleChipRemove}
            projectPath={projectPath ?? undefined}
            onFileChipInsert={handleFileChipInsert}
            placeholder="How this agent should behave, interact with others. Use @ to mention teammates or add files."
            footerRight={
              workflowDraft.isSaved ? (
                <span className="text-[10px] text-[var(--color-text-muted)]">Draft saved</span>
              ) : null
            }
          />
        </div>
      ) : null}
    </div>
  );
};
