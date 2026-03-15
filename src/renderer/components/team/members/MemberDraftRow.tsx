import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { TeamModelSelector } from '@renderer/components/team/dialogs/TeamModelSelector';
import { RoleSelect } from '@renderer/components/team/RoleSelect';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useFileListCacheWarmer } from '@renderer/hooks/useFileListCacheWarmer';
import { useTheme } from '@renderer/hooks/useTheme';
import { reconcileChips, removeChipTokenFromText } from '@renderer/utils/chipUtils';
import { getMemberColorByName } from '@shared/constants/memberColors';
import { ChevronDown, ChevronRight, Info, Trash2 } from 'lucide-react';

import type { MemberDraft } from './membersEditorTypes';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';

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
  draftKeyPrefix?: string;
  projectPath?: string | null;
  mentionSuggestions?: MentionSuggestion[];
  taskSuggestions?: MentionSuggestion[];
  teamSuggestions?: MentionSuggestion[];
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
  draftKeyPrefix,
  projectPath,
  mentionSuggestions = [],
  taskSuggestions,
  teamSuggestions,
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

  return (
    <div
      className="relative grid grid-cols-1 gap-2 rounded-md p-2 shadow-sm md:grid-cols-[1fr_220px_auto]"
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
          onValueChange={(roleSelection) => onRoleChange(member.id, roleSelection)}
          customRole={member.customRole}
          onCustomRoleChange={(customRole) => onCustomRoleChange(member.id, customRole)}
          triggerClassName="h-8 text-xs"
          inputClassName="h-8 text-xs"
        />
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
          className="h-8 shrink-0 gap-1"
          onClick={() => setModelExpanded((prev) => !prev)}
        >
          {modelExpanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          Model
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 shrink-0 border-red-500/40 px-0 text-red-300 hover:bg-red-500/10 hover:text-red-200"
          aria-label={`Remove ${member.name || `member ${index + 1}`}`}
          title="Remove member"
          onClick={() => onRemove(member.id)}
        >
          <Trash2 className="size-3.5" />
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
        <div className="space-y-2 md:col-span-3">
          <div className="pointer-events-none opacity-40">
            <TeamModelSelector value="" onValueChange={() => {}} />
          </div>
          <div className="flex items-start gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2">
            <Info className="mt-0.5 size-3.5 shrink-0 text-sky-400" />
            <p className="text-[11px] leading-relaxed text-sky-300">
              Claude Code doesn&apos;t support per-member model selection yet &mdash; all teammates
              inherit the team launch model. We plan to solve this via a local proxy.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
